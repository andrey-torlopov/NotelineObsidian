import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDefaultState } from '../src/domain/state.ts';

const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const obsidianStub = moduleUrl(`
  export class App {}
  export class Plugin {
    constructor(app) { this.app = app; this.registered = { views: new Map(), extensions: [], commands: [], settings: [], events: [] }; }
    loadData() { return this.app.storage.loadData(); }
    saveData(value) { return this.app.storage.saveData(value); }
    registerView(type, factory) { this.registered.views.set(type, factory); }
    registerExtensions(extensions, type) {
      if (this.app.storage.hooks.extensionCollision) throw new Error('Controlled extension collision');
      this.registered.extensions.push({ extensions, type });
    }
    addRibbonIcon() { return {}; }
    addCommand(command) { this.registered.commands.push(command); }
    addSettingTab(tab) { this.registered.settings.push(tab); }
    registerEvent(reference) { this.registered.events.push(reference); }
  }
  export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
  export class Setting {}
  export class Notice { static messages = []; constructor(message) { Notice.messages.push(message); } }
  export class TFolder { constructor(path) { this.path = path; } }
  export class TFile {
    constructor(path) { this.path = path; }
    get extension() { return this.path.split('.').at(-1); }
    get basename() { const name = this.path.split('/').at(-1); return name.slice(0, -(this.extension.length + 1)); }
  }
  export class MarkdownView {}
  export function parseYaml(text) { return text.trim() ? JSON.parse(text) : undefined; }
`);
const dialogsStub = moduleUrl(`
  export class ValueModal {
    static opened = [];
    constructor(app, title, description, initial, action) { Object.assign(this, { app, title, description, initial, action }); }
    open() { ValueModal.opened.push(this); }
  }
  export class ConfirmationModal extends ValueModal {
    constructor(app, title, description, action) { super(app, title, description, '', action); }
  }
  export class TimelinePicker { constructor(app, files, action) { Object.assign(this, { app, files, action }); } open() {} }
  export class NotePicker { constructor(app, action) { this.action = action; } open() {} }
`);
const viewStub = moduleUrl(`
  export const VIEW_TYPE = 'noteline-timeline';
  export class TimelineView { constructor(leaf, plugin) { this.leaf = leaf; this.plugin = plugin; } flushCamera() {} }
`);
const mainUrl = new URL('../src/main.ts', import.meta.url).href;
const sessionUrl = new URL('../src/services/timeline-session.ts', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'obsidian') return { url: obsidianStub, shortCircuit: true };
  if ((context.parentURL === mainUrl && specifier === './ui/dialogs.ts') || (context.parentURL === sessionUrl && specifier === '../ui/dialogs.ts')) return { url: dialogsStub, shortCircuit: true };
  if (context.parentURL === mainUrl && specifier === './ui/timeline-view.ts') return { url: viewStub, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { TFile, TFolder } = await import('obsidian');
const { default: NotelinePlugin } = await import('../src/main.ts');
const { serializeTimeline, parseTimeline } = await import('../src/services/timeline-files.ts');
const { ValueModal } = await import(dialogsStub);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function emitter() {
  const listeners = new Map();
  return {
    on(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
      return { name, callback };
    },
    trigger(name, ...values) { for (const callback of listeners.get(name) ?? []) callback(...values); },
  };
}

function storage(initial = {}, localData = null) {
  const files = new Map();
  const contents = new Map(Object.entries(initial));
  for (const path of contents.keys()) files.set(path, new TFile(path));
  let data = structuredClone(localData);
  const saves = [];
  const calls = { reads: [], writes: [], writeTexts: [], creates: [], opens: [], trash: [] };
  const hooks = { read: undefined, beforeProcess: undefined, afterProcess: undefined, failPreferences: false };
  return {
    files, contents, saves, calls, hooks,
    async loadData() { return structuredClone(data); },
    async saveData(value) {
      if (hooks.failPreferences) throw new Error('Controlled preference failure');
      data = structuredClone(value);
      saves.push(structuredClone(value));
    },
    get data() { return structuredClone(data); },
  };
}

async function harness(initial = {}, localData = null, shared = storage(initial, localData)) {
  const vaultEvents = emitter();
  const workspaceEvents = emitter();
  const metadataEvents = emitter();
  const layoutCallbacks = [];
  const leaves = [];
  const { files, contents, calls, hooks } = shared;
  const app = {
    storage: shared,
    vault: {
      ...vaultEvents,
      getFiles: () => [...files.values()].filter(file => file instanceof TFile),
      getAbstractFileByPath: path => files.get(path) ?? null,
      async read(file) {
        calls.reads.push(file.path);
        if (hooks.read) await hooks.read(file);
        if (!contents.has(file.path)) throw new Error('Controlled missing file');
        return contents.get(file.path);
      },
      async cachedRead(file) {
        if (!contents.has(file.path)) throw new Error('Controlled missing note');
        return contents.get(file.path);
      },
      async create(path, text) {
        if (files.has(path)) throw new Error('Controlled path collision');
        const file = new TFile(path);
        files.set(path, file);
        contents.set(path, text);
        calls.creates.push(path);
        vaultEvents.trigger('create', file);
        return file;
      },
      async createFolder(path) {
        if (files.has(path)) throw new Error('Controlled folder collision');
        const folder = new TFolder(path);
        files.set(path, folder);
        return folder;
      },
      async process(file, update) {
        if (hooks.beforeProcess) await hooks.beforeProcess(file);
        if (!contents.has(file.path)) throw new Error('Controlled missing file');
        const next = update(contents.get(file.path));
        contents.set(file.path, next);
        calls.writes.push(file.path);
        calls.writeTexts.push({ path: file.path, text: next });
        vaultEvents.trigger('modify', file);
        if (hooks.afterProcess) await hooks.afterProcess(file);
        return next;
      },
    },
    metadataCache: { ...metadataEvents, getFileCache: () => ({ tags: [] }) },
    workspace: {
      ...workspaceEvents,
      getActiveFile: () => null,
      getLeavesOfType: () => leaves,
      onLayoutReady: callback => { layoutCallbacks.push(callback); },
      getLeaf: () => ({ async openFile(file) { calls.opens.push(file.path); } }),
      async revealLeaf(leaf) { calls.opens.push(leaf.view.file.path); },
      iterateAllLeaves(callback) { for (const leaf of leaves) callback(leaf); },
    },
    fileManager: {
      async trashFile(file) {
        calls.trash.push(file.path);
        files.delete(file.path);
        contents.delete(file.path);
        vaultEvents.trigger('delete', file);
      },
    },
  };
  const plugin = new NotelinePlugin(app);
  await plugin.onload();
  return {
    plugin, app, shared, files, contents, calls, hooks, leaves,
    async external(path, text) {
      contents.set(path, text);
      vaultEvents.trigger('modify', files.get(path));
      await reloads(plugin);
    },
    layoutReady() { for (const callback of layoutCallbacks.splice(0)) callback(); },
  };
}

async function reloads(plugin) {
  await Promise.all([...plugin.handles.values()].map(handle => handle.reload));
}

async function settle(plugin) {
  for (let turn = 0; turn < 100; turn++) {
    const handles = [...plugin.handles.values()];
    const pending = handles.map(handle => handle.reload);
    await Promise.all(pending);
    await Promise.all(handles.map(handle => handle.session.store.flush()));
    await Promise.resolve();
    if (handles.every((handle, index) => handle.reload === pending[index] && handle.session.activeReads === 0 && handle.session.queue.size === 0)) return;
  }
  assert.fail('Controlled session work did not settle');
}

function stateWithNote(path = 'shared.md', fallbackDate = '2026-10-01', preferredLane = 0) {
  const state = createDefaultState();
  state.timeline.entries.push({ entryId: 'one', filePath: path, preferredLane, expanded: false, fallbackDate });
  return state;
}

function renameInVault(current, file, newPath) {
  const oldPath = file.path;
  const text = current.contents.get(oldPath);
  current.contents.delete(oldPath);
  current.contents.set(newPath, text);
  current.files.delete(oldPath);
  file.path = newPath;
  current.files.set(newPath, file);
  current.app.vault.trigger('rename', file, oldPath);
}

test('legacy migration retains original plugin data and is idempotent after restart', async () => {
  const legacy = { ...stateWithNote(), retainedSetting: { value: 'original' } };
  const before = structuredClone(legacy);
  const first = await harness({}, legacy);
  assert.deepEqual(legacy, before);
  assert.equal(first.contents.has('Noteline.timeline'), true);
  assert.deepEqual(parseTimeline(first.contents.get('Noteline.timeline')), before);
  assert.deepEqual(first.shared.data, { ...before, notelineFiles: { version: 1, migratedPath: 'Noteline.timeline', lastPath: 'Noteline.timeline' } });
  first.plugin.onunload();
  const restarted = await harness({}, null, first.shared);
  assert.deepEqual(restarted.plugin.listTimelines().map(file => file.path), ['Noteline.timeline']);
  assert.deepEqual(restarted.calls.creates, ['Noteline.timeline']);
  assert.equal(restarted.shared.saves.length, 1);
  assert.deepEqual(restarted.plugin.registered.extensions, [{ extensions: ['timeline'], type: 'noteline-timeline' }]);
});

test('extension registration collisions fail before legacy migration or preference writes', async () => {
  const legacy = stateWithNote();
  const shared = storage({}, legacy);
  shared.hooks.extensionCollision = true;
  await assert.rejects(harness({}, null, shared), /extension collision/);
  assert.deepEqual(shared.data, legacy);
  assert.deepEqual(shared.calls.creates, []);
  assert.deepEqual(shared.calls.writes, []);
  assert.deepEqual(shared.saves, []);
});

test('interrupted migration reuses an existing identical timeline without overwriting it', async () => {
  const legacy = stateWithNote();
  const compactText = JSON.stringify(legacy);
  const current = await harness({ 'Noteline.timeline': compactText }, legacy);
  assert.deepEqual(current.calls.creates, []);
  assert.deepEqual(current.calls.writes, []);
  assert.equal(current.contents.get('Noteline.timeline'), compactText);
  assert.equal(current.shared.data.notelineFiles.migratedPath, 'Noteline.timeline');
});

test('migration name collisions allocate a unique filename and preserve unrelated files', async () => {
  const legacy = stateWithNote();
  const unrelated = serializeTimeline({ ...createDefaultState(), owner: 'existing file' });
  const current = await harness({ 'Noteline.timeline': unrelated, 'Noteline 2.timeline': 'Do not overwrite' }, legacy);
  assert.equal(current.contents.get('Noteline.timeline'), unrelated);
  assert.equal(current.contents.get('Noteline 2.timeline'), 'Do not overwrite');
  assert.deepEqual(current.calls.creates, ['Noteline 3.timeline']);
  assert.deepEqual(parseTimeline(current.contents.get('Noteline 3.timeline')), legacy);
  assert.equal(current.shared.data.notelineFiles.migratedPath, 'Noteline 3.timeline');
});

test('migration recovers after a local preference save failure and preserves invalid legacy data', async () => {
  const legacy = stateWithNote();
  const shared = storage({}, legacy);
  shared.hooks.failPreferences = true;
  const first = await harness({}, null, shared);
  assert.equal(first.contents.has('Noteline.timeline'), true);
  assert.deepEqual(shared.data, legacy);
  first.plugin.onunload();
  shared.hooks.failPreferences = false;
  const restarted = await harness({}, null, shared);
  assert.deepEqual(restarted.calls.creates, ['Noteline.timeline']);
  assert.equal(shared.data.notelineFiles.migratedPath, 'Noteline.timeline');
  const invalid = { schemaVersion: 999, unknown: 'Keep original' };
  const broken = await harness({}, invalid);
  assert.deepEqual(broken.shared.data, invalid);
  assert.deepEqual(broken.calls.creates, []);
  assert.deepEqual(broken.shared.saves, []);
});

test('retrying an interrupted migration with a name collision reuses its earlier recovery file', async () => {
  const legacy = stateWithNote();
  const unrelated = serializeTimeline({ ...createDefaultState(), unrelated: 'Keep original' });
  const shared = storage({ 'Noteline.timeline': unrelated }, legacy);
  shared.hooks.failPreferences = true;
  const first = await harness({}, null, shared);
  assert.deepEqual(shared.calls.creates, ['Noteline 2.timeline']);
  first.plugin.onunload();
  shared.hooks.failPreferences = false;
  const restarted = await harness({}, null, shared);
  assert.deepEqual(restarted.calls.creates, ['Noteline 2.timeline'], 'Retry must not manufacture a duplicate migration file');
  assert.equal(restarted.shared.data.notelineFiles.migratedPath, 'Noteline 2.timeline');
  assert.equal(restarted.contents.get('Noteline.timeline'), unrelated);
});

test('two timeline files isolate layout, fallback dates and settings for the same note', async () => {
  const firstState = stateWithNote('shared.md', '2026-09-01', 1);
  const secondState = stateWithNote('shared.md', '2026-10-02', 7);
  const current = await harness({ 'A.timeline': serializeTimeline(firstState), 'B.timeline': serializeTimeline(secondState), 'shared.md': 'Body' });
  const first = await current.plugin.acquireSession(current.files.get('A.timeline'));
  const second = await current.plugin.acquireSession(current.files.get('B.timeline'));
  assert.notEqual(first, second);
  assert.notEqual(first.entry('one'), second.entry('one'));
  first.refreshAll();
  second.refreshAll();
  await settle(current.plugin);
  assert.equal(first.records.get('one').effectiveDate.value, '2026-09-01');
  assert.equal(second.records.get('one').effectiveDate.value, '2026-10-02');
  first.updateEntry('one', entry => { entry.preferredLane = 5; entry.expanded = true; });
  first.store.change(state => { state.settings.dateProperties = ['custom-date']; state.timeline.orientation = 'vertical'; state.timeline.reverse = true; });
  await settle(current.plugin);
  assert.equal(second.entry('one').preferredLane, 7);
  assert.equal(second.entry('one').expanded, false);
  assert.deepEqual(second.store.state.settings.dateProperties, ['timeline-date', 'date']);
  assert.deepEqual(parseTimeline(current.contents.get('B.timeline')), secondState);
  assert.equal(parseTimeline(current.contents.get('A.timeline')).timeline.entries[0].preferredLane, 5);
  assert.equal(current.contents.get('shared.md'), 'Body');
});

test('concurrent acquisition of one file shares one loaded session until the final release', async () => {
  const text = serializeTimeline(createDefaultState());
  const current = await harness({ 'A.timeline': text });
  const file = current.files.get('A.timeline');
  const gate = deferred();
  current.hooks.read = () => gate.promise;
  const firstRead = current.plugin.acquireSession(file);
  const secondRead = current.plugin.acquireSession(file);
  gate.resolve();
  const [first, second] = await Promise.all([firstRead, secondRead]);
  assert.equal(first, second);
  assert.deepEqual(current.calls.reads, ['A.timeline']);
  current.hooks.read = undefined;
  await current.plugin.releaseSession(first);
  assert.equal(second.store.writable, true);
  await current.plugin.releaseSession(second);
  assert.equal(second.store.writable, false);
  const reopened = await current.plugin.acquireSession(file);
  assert.notEqual(reopened, first);
});

test('plugin unload during a pending session load cannot publish a late writable session', async () => {
  const current = await harness({ 'A.timeline': serializeTimeline(createDefaultState()) });
  const file = current.files.get('A.timeline');
  const release = deferred();
  current.hooks.read = () => release.promise;
  const loading = current.plugin.acquireSession(file);
  current.plugin.onunload();
  release.resolve();
  await assert.rejects(loading, /закрыт|выгружен|остановлен/);
  assert.equal(current.plugin.handles.size, 0);
  assert.deepEqual(current.calls.writes, []);
});

test('a modify echo while a local write is still pending never produces an external conflict', async () => {
  const current = await harness({ 'A.timeline': serializeTimeline(createDefaultState()) });
  const session = await current.plugin.acquireSession(current.files.get('A.timeline'));
  const arrived = deferred();
  const release = deferred();
  current.hooks.afterProcess = async () => { arrived.resolve(); await release.promise; };
  session.store.change(state => { state.settings.dateProperties = ['local-date']; });
  await arrived.promise;
  await reloads(current.plugin);
  assert.equal(session.store.status, 'saving');
  release.resolve();
  await settle(current.plugin);
  assert.equal(session.store.status, 'saved');
  assert.deepEqual(session.store.state.settings.dateProperties, ['local-date']);
});

test('a foreign change during a pending local save blocks compare-and-swap and preserves both states', async () => {
  const current = await harness({ 'A.timeline': serializeTimeline(createDefaultState()) });
  const file = current.files.get('A.timeline');
  const session = await current.plugin.acquireSession(file);
  const entered = deferred();
  const release = deferred();
  current.hooks.beforeProcess = async () => { entered.resolve(); await release.promise; };
  session.store.change(state => { state.settings.dateProperties = ['local-date']; });
  await entered.promise;
  const foreign = serializeTimeline({ ...createDefaultState(), foreignData: 'Do not overwrite' });
  await current.external(file.path, foreign);
  assert.equal(session.store.status, 'conflict');
  release.resolve();
  await session.store.flush();
  assert.equal(session.store.status, 'conflict');
  assert.equal(current.contents.get(file.path), foreign);
  assert.deepEqual(session.store.state.settings.dateProperties, ['local-date']);
  assert.deepEqual(current.calls.writes, []);
  assert.throws(() => session.store.change(() => {}));
});

test('clean external reload advances the expected text so the next local save succeeds', async () => {
  const current = await harness({ 'A.timeline': serializeTimeline(createDefaultState()) });
  const file = current.files.get('A.timeline');
  const session = await current.plugin.acquireSession(file);
  const externalState = { ...createDefaultState(), foreignData: 'Retain me' };
  externalState.settings.dateProperties = ['remote-date'];
  await current.external(file.path, serializeTimeline(externalState));
  assert.deepEqual(session.store.state, externalState);
  assert.equal(session.store.status, 'saved');
  session.store.change(state => { state.timeline.reverse = true; });
  await settle(current.plugin);
  assert.equal(session.store.status, 'saved');
  assert.equal(parseTimeline(current.contents.get(file.path)).foreignData, 'Retain me');
  assert.equal(parseTimeline(current.contents.get(file.path)).timeline.reverse, true);
});

test('bad JSON opens read-only and release retains the unsavable session without changing the file', async () => {
  const text = '{broken JSON';
  const current = await harness({ 'Broken.timeline': text });
  const file = current.files.get('Broken.timeline');
  const session = await current.plugin.acquireSession(file);
  assert.equal(session.store.status, 'readonly');
  assert.match(session.store.error, /Файл не изменён|JSON/);
  assert.throws(() => session.store.change(() => {}));
  await current.plugin.releaseSession(session);
  assert.equal(await current.plugin.acquireSession(file), session);
  assert.equal(current.contents.get(file.path), text);
  assert.deepEqual(current.calls.writes, []);
});

test('releasing failed or conflicted sessions retains the local unsaved state for recovery', async () => {
  for (const conflict of [false, true]) {
    const current = await harness({ 'A.timeline': serializeTimeline(createDefaultState()) });
    const file = current.files.get('A.timeline');
    const session = await current.plugin.acquireSession(file);
    if (conflict) current.contents.set(file.path, serializeTimeline({ ...createDefaultState(), foreignData: true }));
    else current.hooks.beforeProcess = () => { throw new Error('Controlled disk failure'); };
    session.store.change(state => { state.settings.dateProperties = ['unsaved']; });
    await session.store.flush();
    assert.equal(session.store.status, conflict ? 'conflict' : 'error');
    await current.plugin.releaseSession(session);
    assert.equal(await current.plugin.acquireSession(file), session);
    assert.deepEqual(session.store.state.settings.dateProperties, ['unsaved']);
    assert.deepEqual(current.calls.writes, []);
  }
});

test('confirmed deletion trashes an initially invalid read-only document when there are no local edits', async () => {
  const current = await harness({ 'Broken.timeline': '{broken original', 'Note.md': 'Keep the source note' });
  const file = current.files.get('Broken.timeline');
  const session = await current.plugin.acquireSession(file);
  assert.equal(session.store.status, 'readonly');
  assert.equal(session.store.hasUnsavedChanges, false);
  current.plugin.confirmDelete(file);
  const modal = ValueModal.opened.at(-1);
  await modal.action();
  assert.deepEqual(current.calls.trash, ['Broken.timeline']);
  assert.equal(current.files.has('Broken.timeline'), false);
  assert.equal(current.contents.get('Note.md'), 'Keep the source note');
});

test('confirmed deletion refuses a conflicted session with unsaved local edits', async () => {
  const current = await harness({ 'Axis.timeline': serializeTimeline(createDefaultState()) });
  const file = current.files.get('Axis.timeline');
  const session = await current.plugin.acquireSession(file);
  const foreign = serializeTimeline({ ...createDefaultState(), remoteOwner: 'Keep foreign data' });
  current.contents.set(file.path, foreign);
  session.store.change(state => { state.settings.dateProperties = ['unsaved-local']; });
  await session.store.flush();
  assert.equal(session.store.status, 'conflict');
  assert.equal(session.store.hasUnsavedChanges, true);
  current.plugin.confirmDelete(file);
  const modal = ValueModal.opened.at(-1);
  await assert.rejects(modal.action(), /несохранённой оси|конфликт/);
  assert.deepEqual(current.calls.trash, []);
  assert.equal(current.contents.get(file.path), foreign);
  assert.deepEqual(session.store.state.settings.dateProperties, ['unsaved-local']);
});

test('saving a conflict recovery copy preserves local state independently of the original file and session', async () => {
  const initial = stateWithNote('Note.md', '2026-10-01', 1);
  const current = await harness({ 'Source.timeline': serializeTimeline(initial), 'Note.md': 'Keep body' });
  const file = current.files.get('Source.timeline');
  const session = await current.plugin.acquireSession(file);
  const foreign = serializeTimeline({ ...initial, remoteField: 'Keep remote source' });
  current.contents.set(file.path, foreign);
  session.store.change(state => {
    state.settings.dateProperties = ['local-date'];
    state.timeline.entries[0].preferredLane = 5;
    state.timeline.orientation = 'vertical';
    state.timeline.reverse = true;
  });
  await session.store.flush();
  assert.equal(session.store.status, 'conflict');
  current.plugin.createTimelineDialog(session, file);
  const modal = ValueModal.opened.at(-1);
  assert.match(modal.title, /копию/);
  await modal.action('Recovered');
  assert.equal(current.contents.get(file.path), foreign);
  const copyFile = current.files.get('Recovered.timeline');
  const copy = await current.plugin.acquireSession(copyFile);
  assert.notEqual(copy, session);
  assert.deepEqual(copy.store.state, session.store.state);
  assert.equal(copy.store.hasUnsavedChanges, false);
  assert.equal(copy.store.status, 'saved');
  copy.updateEntry('one', entry => { entry.preferredLane = 9; });
  await settle(current.plugin);
  assert.equal(session.entry('one').preferredLane, 5);
  assert.equal(parseTimeline(current.contents.get('Recovered.timeline')).timeline.entries[0].preferredLane, 9);
  assert.equal(current.contents.get(file.path), foreign);
  assert.equal(current.contents.get('Note.md'), 'Keep body');
});

test('confirmed reload waits for a pending writer before reading the replacement or advancing expected text', async () => {
  const original = serializeTimeline(createDefaultState());
  const current = await harness({ 'Axis.timeline': original });
  const file = current.files.get('Axis.timeline');
  const session = await current.plugin.acquireSession(file);
  const entered = deferred();
  const release = deferred();
  current.hooks.beforeProcess = async () => { entered.resolve(); await release.promise; };
  session.store.change(state => { state.settings.dateProperties = ['unsaved-local']; });
  await entered.promise;
  const replacement = { ...createDefaultState(), replacementField: 'Reload this' };
  const replacementText = serializeTimeline(replacement);
  current.contents.set(file.path, replacementText);
  current.plugin.confirmReload(file, session);
  const modal = ValueModal.opened.at(-1);
  const reloading = modal.action();
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  assert.deepEqual(current.calls.reads, ['Axis.timeline'], 'Reload cannot read while the previous writer is active');
  assert.equal(current.plugin.findHandle(file).expectedText, original);
  release.resolve();
  await reloading;
  assert.deepEqual(session.store.state, replacement);
  assert.equal(session.store.status, 'saved');
  assert.equal(session.store.hasUnsavedChanges, false);
  assert.equal(current.plugin.findHandle(file).expectedText, replacementText);
  current.hooks.beforeProcess = undefined;
  session.store.change(state => { state.timeline.reverse = true; });
  await settle(current.plugin);
  assert.equal(session.store.status, 'saved');
  assert.equal(parseTimeline(current.contents.get(file.path)).replacementField, 'Reload this');
  assert.equal(parseTimeline(current.contents.get(file.path)).timeline.reverse, true);
});

test('renaming notes and folders updates closed timeline files without changing unrelated entries', async () => {
  const first = stateWithNote('Old/note.md');
  const second = stateWithNote('Old/nested/other.md');
  second.timeline.entries.push({ entryId: 'unrelated', filePath: 'Old-other/note.md', preferredLane: 4, expanded: true });
  const current = await harness({ 'A.timeline': serializeTimeline(first), 'B.timeline': serializeTimeline(second), 'Old/note.md': 'Body' });
  const note = current.files.get('Old/note.md');
  note.path = 'Old/renamed.md';
  await current.plugin.renameReferences(note, 'Old/note.md');
  assert.equal(parseTimeline(current.contents.get('A.timeline')).timeline.entries[0].filePath, 'Old/renamed.md');
  await current.plugin.renameReferences(new TFolder('New'), 'Old');
  assert.equal(parseTimeline(current.contents.get('A.timeline')).timeline.entries[0].filePath, 'New/renamed.md');
  const entries = parseTimeline(current.contents.get('B.timeline')).timeline.entries;
  assert.equal(entries[0].filePath, 'New/nested/other.md');
  assert.equal(entries[1].filePath, 'Old-other/note.md');
  assert.equal(current.contents.get('Old/note.md'), 'Body');
  assert.equal(current.plugin.handles.size, 0, 'Closed-file updates must not create view sessions');
});

test('one malformed closed timeline does not prevent rename repairs in other valid timelines', async () => {
  const malformed = '{broken, preserve these bytes';
  const current = await harness({ 'A-broken.timeline': malformed, 'Z-valid.timeline': serializeTimeline(stateWithNote('Old.md')) });
  await assert.doesNotReject(current.plugin.renameReferences(new TFile('Renamed.md'), 'Old.md'));
  assert.equal(current.contents.get('A-broken.timeline'), malformed);
  assert.equal(parseTimeline(current.contents.get('Z-valid.timeline')).timeline.entries[0].filePath, 'Renamed.md');
});

test('native rename events retain their captured target paths when the same TFile changes again immediately', async () => {
  const current = await harness({ 'Axis.timeline': serializeTimeline(stateWithNote('A.md')), 'A.md': 'Keep body' });
  const file = current.files.get('A.md');
  renameInVault(current, file, 'B.md');
  renameInVault(current, file, 'C.md');
  await current.plugin.renameQueue;
  assert.equal(file.path, 'C.md');
  assert.deepEqual(current.calls.writeTexts.map(write => parseTimeline(write.text).timeline.entries[0].filePath), ['B.md', 'C.md']);
  assert.equal(parseTimeline(current.contents.get('Axis.timeline')).timeline.entries[0].filePath, 'C.md');
  assert.equal(current.contents.get('C.md'), 'Keep body');
});

test('concurrent rename events for distinct notes serialize updates to their shared closed timeline', async () => {
  const state = stateWithNote('A.md');
  state.timeline.entries.push({ entryId: 'two', filePath: 'C.md', preferredLane: 3, expanded: true });
  const current = await harness({ 'Axis.timeline': serializeTimeline(state), 'A.md': 'First body', 'C.md': 'Second body' });
  renameInVault(current, current.files.get('A.md'), 'B.md');
  renameInVault(current, current.files.get('C.md'), 'D.md');
  await current.plugin.renameQueue;
  const entries = parseTimeline(current.contents.get('Axis.timeline')).timeline.entries;
  assert.deepEqual(entries.map(entry => entry.filePath), ['B.md', 'D.md']);
  assert.deepEqual(current.calls.writes, ['Axis.timeline', 'Axis.timeline']);
  assert.equal(current.contents.get('B.md'), 'First body');
  assert.equal(current.contents.get('D.md'), 'Second body');
});
