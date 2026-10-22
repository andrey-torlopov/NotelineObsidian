import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { StateStore } from '../src/services/persistence.ts';
import { createDefaultState } from '../src/domain/state.ts';

const asModule = source => `data:text/javascript,${encodeURIComponent(source)}`;
const obsidianStub = asModule(`
  export class App {}
  export class Plugin { constructor(app) { this.app = app; } }
  export class PluginSettingTab {}
  export class Setting {}
  export class Notice { static messages = []; constructor(message) { Notice.messages.push(message); } }
  export class TFolder { constructor(path) { this.path = path; } }
  export class TFile {
    constructor(path) { this.path = path; this.extension = path.split('.').at(-1); this.basename = path.split('/').at(-1).replace(/\\.md$/, ''); }
  }
  export class MarkdownView {}
  export function parseYaml(text) { return text.trim() ? JSON.parse(text) : undefined; }
`);
const dialogsStub = asModule(`
  export class NotePicker { constructor(app, action) { this.action = action; } open() {} }
  export class ValueModal {
    static opened = [];
    constructor(app, title, description, initial, action) { this.action = action; }
    open() { ValueModal.opened.push(this); }
  }
`);
const viewStub = asModule(`export const VIEW_TYPE = 'noteline-timeline'; export class TimelineView { flushCamera() {} }`);
const mainUrl = new URL('../src/main.ts', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'obsidian') return { url: obsidianStub, shortCircuit: true };
  if (context.parentURL === mainUrl && specifier === './ui/dialogs.ts') return { url: dialogsStub, shortCircuit: true };
  if (context.parentURL === mainUrl && specifier === './ui/timeline-view.ts') return { url: viewStub, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { TFile } = await import('obsidian');
const { default: NotelinePlugin } = await import('../src/main.ts');
const { ValueModal } = await import(dialogsStub);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function entry(path, id = path) {
  return { entryId: id, filePath: path, preferredLane: 0, expanded: false };
}

function harness(notes, state = createDefaultState()) {
  const contents = new Map(Object.entries(notes));
  const files = new Map([...contents.keys()].map(path => [path, new TFile(path)]));
  const caches = new Map();
  const saves = [];
  const reported = [];
  const reads = [];
  let reader = async file => {
    if (!contents.has(file.path)) throw new Error('Controlled missing note');
    return contents.get(file.path);
  };
  const app = {
    vault: {
      getAbstractFileByPath: path => files.get(path) ?? null,
      cachedRead(file) { reads.push(file.path); return reader(file); },
    },
    metadataCache: { getFileCache(file) { return caches.has(file.path) ? caches.get(file.path) : { tags: [] }; } },
    workspace: { getLeavesOfType: () => [] },
  };
  const plugin = new NotelinePlugin(app);
  plugin.store = new StateStore(async snapshot => { saves.push(structuredClone(snapshot)); }, () => {});
  plugin.store.load(structuredClone(state));
  let opens = 0;
  plugin.openTimeline = async () => { opens += 1; };
  plugin.report = error => { reported.push(error instanceof Error ? error.message : String(error)); };
  return { plugin, app, contents, files, caches, saves, reported, reads,
    setReader(next) { reader = next; }, get opens() { return opens; } };
}

async function settle(plugin) {
  // All work under test is promise-driven. Yield microtasks until the bounded read queue drains.
  for (let turns = 0; turns < 100 && (plugin.activeReads > 0 || plugin.queue.size > 0); turns += 1) await Promise.resolve();
  assert.equal(plugin.activeReads, 0, 'Read queue did not drain');
  assert.equal(plugin.queue.size, 0, 'Pending read queue did not drain');
  await plugin.store.flush();
}

async function withClock(year, month, day, action) {
  const RealDate = globalThis.Date;
  const timestamp = new RealDate(year, month - 1, day, 12).getTime();
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [timestamp])); }
    static now() { return timestamp; }
  }
  globalThis.Date = FixedDate;
  try { return await action(); }
  finally { globalThis.Date = RealDate; }
}

test('all four missing-field combinations produce independent metadata and fallback flags', async () => {
  await withClock(2026, 10, 22, async () => {
    const notes = {
      'complete.md': '📅 2026-10-20\n📍 Tags: #one\nBody',
      'missing-date.md': '📍 Tags: #one\nBody',
      'missing-tags.md': '📅 2026-10-20\nBody',
      'missing-both.md': 'Body',
    };
    const state = createDefaultState();
    state.timeline.entries = Object.keys(notes).map(path => entry(path));
    const current = harness(notes, state);
    current.plugin.refreshAll();
    await settle(current.plugin);
    const expected = [
      ['complete.md', false, false, '2026-10-20'],
      ['missing-date.md', true, false, '2026-10-22'],
      ['missing-tags.md', false, true, '2026-10-20'],
      ['missing-both.md', true, true, '2026-10-22'],
    ];
    for (const [path, missingDate, missingTags, effectiveDate] of expected) {
      const record = current.plugin.records.get(path);
      assert.equal(record.error, undefined, path);
      assert.equal(record.missingDate, missingDate, path);
      assert.equal(record.metadata.missingTags, missingTags, path);
      assert.equal(record.effectiveDate.value, effectiveDate, path);
      assert.equal(current.plugin.entry(path).fallbackDate, missingDate ? '2026-10-22' : undefined);
      assert.equal(current.contents.get(path), notes[path], 'Reading metadata must not rewrite Markdown');
    }
  });
});

test('fallback dates survive serialized state, restart and a different current day', async () => {
  let snapshot;
  await withClock(2026, 10, 22, async () => {
    const state = createDefaultState();
    state.timeline.entries = [entry('note.md')];
    const first = harness({ 'note.md': 'Body' }, state);
    first.plugin.refreshAll();
    await settle(first.plugin);
    snapshot = JSON.parse(JSON.stringify(first.saves.at(-1)));
    assert.equal(snapshot.timeline.entries[0].fallbackDate, '2026-10-22');
  });
  await withClock(2026, 10, 29, async () => {
    const restarted = harness({ 'note.md': 'Body' }, snapshot);
    restarted.plugin.refreshAll();
    await settle(restarted.plugin);
    assert.equal(restarted.plugin.records.get('note.md').effectiveDate.value, '2026-10-22');
    assert.equal(restarted.plugin.entry('note.md').fallbackDate, '2026-10-22');
    assert.equal(restarted.saves.length, 0, 'Reading a persisted fallback must not resave it each day');
  });
});

test('a source date clears fallback while missing tags remain defective', async () => {
  const state = createDefaultState();
  state.timeline.entries = [{ ...entry('note.md'), fallbackDate: '2026-10-22' }];
  const current = harness({ 'note.md': '📅 2026-11-01\nBody' }, state);
  current.plugin.refreshAll();
  await settle(current.plugin);
  const record = current.plugin.records.get('note.md');
  assert.equal(record.effectiveDate.value, '2026-11-01');
  assert.equal(record.missingDate, false);
  assert.equal(record.metadata.missingTags, true);
  assert.equal(current.plugin.entry('note.md').fallbackDate, undefined);
  assert.equal(current.saves.at(-1).timeline.entries[0].fallbackDate, undefined);
});

test('invalid source values and malformed YAML never create a fallback date', async () => {
  for (const text of ['📅 2026-02-30', '---\n{broken\n---\n📅 2026-10-22', '---\nnot closed']) {
    const state = createDefaultState();
    state.timeline.entries = [entry('note.md')];
    const current = harness({ 'note.md': text }, state);
    current.plugin.refreshAll();
    await settle(current.plugin);
    assert.equal(current.plugin.entry('note.md').fallbackDate, undefined);
    assert.equal(current.plugin.records.get('note.md').missingDate, false);
    assert.equal(typeof current.plugin.records.get('note.md').error, 'string');
    assert.equal(current.saves.length, 0);
  }
});

test('read errors and cache errors cannot generate fallback dates or overwrite persisted values', async () => {
  for (const existingFallback of [undefined, '2026-10-10']) {
    const state = createDefaultState();
    state.timeline.entries = [{ ...entry('note.md'), ...(existingFallback ? { fallbackDate: existingFallback } : {}) }];
    const current = harness({ 'note.md': 'Body' }, state);
    current.setReader(async () => { throw new Error('Controlled read failure'); });
    current.plugin.refreshAll();
    await settle(current.plugin);
    assert.match(current.plugin.records.get('note.md').error, /Controlled read failure/);
    assert.equal(current.plugin.entry('note.md').fallbackDate, existingFallback);
    assert.equal(current.saves.length, 0);

    current.setReader(async () => 'Body');
    current.app.metadataCache.getFileCache = () => { throw new Error('Controlled cache failure'); };
    current.plugin.refreshAll();
    await settle(current.plugin);
    assert.match(current.plugin.records.get('note.md').error, /Controlled cache failure/);
    assert.equal(current.plugin.entry('note.md').fallbackDate, existingFallback);
    assert.equal(current.saves.length, 0);
  }
});

test('a stale read after relink cannot replace the new record or manufacture a fallback', async () => {
  const state = createDefaultState();
  state.timeline.entries = [entry('old.md', 'entry')];
  const current = harness({ 'old.md': 'Body', 'new.md': '📅 2026-11-01\nBody' }, state);
  const oldRead = deferred();
  current.setReader(file => file.path === 'old.md' ? oldRead.promise : Promise.resolve(current.contents.get(file.path)));
  current.plugin.refresh('entry');
  current.plugin.updateEntry('entry', item => { item.filePath = 'new.md'; });
  current.plugin.refresh('entry');
  oldRead.resolve('Body');
  await settle(current.plugin);
  assert.equal(current.plugin.records.get('entry').path, 'new.md');
  assert.equal(current.plugin.records.get('entry').effectiveDate.value, '2026-11-01');
  assert.equal(current.plugin.entry('entry').fallbackDate, undefined);
});

test('a stale read after removal cannot restore the card or create a saved fallback', async () => {
  const state = createDefaultState();
  state.timeline.entries = [entry('note.md', 'entry')];
  const current = harness({ 'note.md': 'Body' }, state);
  const pending = deferred();
  current.setReader(() => pending.promise);
  current.plugin.refresh('entry');
  current.plugin.remove('entry');
  pending.resolve('Body');
  await settle(current.plugin);
  assert.equal(current.plugin.records.size, 0);
  assert.deepEqual(current.plugin.store.state.timeline.entries, []);
  assert.deepEqual(current.saves.at(-1).timeline.entries, []);
});

test('an older same-path read cannot overwrite a newer valid date', async () => {
  const state = createDefaultState();
  state.timeline.entries = [entry('note.md')];
  const current = harness({ 'note.md': 'Body' }, state);
  const oldRead = deferred();
  let reads = 0;
  current.setReader(() => ++reads === 1 ? oldRead.promise : Promise.resolve('📅 2026-11-02\nBody'));
  current.plugin.refresh('note.md');
  current.plugin.refresh('note.md');
  oldRead.resolve('Body');
  await settle(current.plugin);
  assert.equal(current.plugin.records.get('note.md').effectiveDate.value, '2026-11-02');
  assert.equal(current.plugin.entry('note.md').fallbackDate, undefined);
});

test('concurrent addNote reads deduplicate after await and retain one fallback', async () => {
  await withClock(2026, 10, 22, async () => {
    const current = harness({ 'note.md': 'Body' });
    const first = deferred();
    const second = deferred();
    let reads = 0;
    current.setReader(() => {
      reads += 1;
      return reads === 1 ? first.promise : reads === 2 ? second.promise : Promise.resolve('Body');
    });
    const file = current.files.get('note.md');
    const addFirst = current.plugin.addNote(file);
    const addSecond = current.plugin.addNote(file);
    first.resolve('Body');
    second.resolve('Body');
    await Promise.all([addFirst, addSecond]);
    await settle(current.plugin);
    assert.equal(current.plugin.store.state.timeline.entries.length, 1);
    const added = current.plugin.store.state.timeline.entries[0];
    assert.equal(added.filePath, 'note.md');
    assert.equal(added.fallbackDate, '2026-10-22');
    assert.equal(current.plugin.requestedFocus, added.entryId);
    assert.deepEqual(current.reported, []);
    assert.equal(current.opens, 2);
  });
});

test('addNote reports invalid dates and read failures without creating entries', async () => {
  const invalid = harness({ 'note.md': '📅 2026-02-30' });
  await invalid.plugin.addNote(invalid.files.get('note.md'));
  assert.deepEqual(invalid.plugin.store.state.timeline.entries, []);
  assert.match(invalid.reported[0], /дата|дату/);
  const unreadable = harness({ 'note.md': 'Body' });
  unreadable.setReader(async () => { throw new Error('Controlled addition read failure'); });
  await unreadable.plugin.addNote(unreadable.files.get('note.md'));
  assert.deepEqual(unreadable.plugin.store.state.timeline.entries, []);
  assert.match(unreadable.reported[0], /Controlled addition read failure/);
});

test('unloading during a pending addition prevents a late entry and view opening', async () => {
  const current = harness({ 'note.md': 'Body' });
  const pending = deferred();
  current.setReader(() => pending.promise);
  const adding = current.plugin.addNote(current.files.get('note.md'));
  current.plugin.onunload();
  pending.resolve('Body');
  await adding;
  assert.deepEqual(current.plugin.store.state.timeline.entries, []);
  assert.equal(current.plugin.records.size, 0);
  assert.equal(current.opens, 0);
  assert.deepEqual(current.reported, []);
});

test('tag forms reject deleted or relinked entries before touching their former note', async () => {
  for (const change of ['remove', 'relink']) {
    const state = createDefaultState();
    state.timeline.entries = [entry('old.md', 'entry')];
    const current = harness({ 'old.md': 'Body', 'new.md': 'Body' }, state);
    current.plugin.tagDialog('entry');
    const modal = ValueModal.opened.at(-1);
    if (change === 'remove') current.plugin.remove('entry');
    else current.plugin.updateEntry('entry', item => { item.filePath = 'new.md'; });
    await assert.rejects(modal.action('new-tag'), /удалена|другим файлом/);
    assert.equal(current.contents.get('old.md'), 'Body');
    assert.equal(current.contents.get('new.md'), 'Body');
    assert.deepEqual(current.reads, []);
    await current.plugin.store.flush();
  }
});
