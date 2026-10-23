import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDefaultState, validateState } from '../src/domain/state.ts';

const stubUrl = `data:text/javascript,${encodeURIComponent(`
  export class TFolder { constructor(path) { this.path = path; } }
  export class TFile {
    constructor(path) { this.path = path; this.extension = path.split('.').at(-1); }
  }
`)}`;
registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === 'obsidian' ? { url: stubUrl, shortCircuit: true } : nextResolve(specifier, context);
} });
const { TFile, TFolder } = await import('obsidian');
const { TimelineConflictError, TimelineFileRepository, parseTimeline, serializeTimeline } = await import('../src/services/timeline-files.ts');

function harness(initial = {}) {
  const files = new Map();
  const contents = new Map();
  for (const [path, text] of Object.entries(initial)) {
    files.set(path, new TFile(path));
    contents.set(path, text);
  }
  const calls = { create: [], folders: [], read: [], process: [], trash: [] };
  const hooks = { create: undefined, folder: undefined, process: undefined };
  const app = {
    vault: {
      getFiles() { return [...files.values()].filter(file => file instanceof TFile); },
      getAbstractFileByPath(path) { return files.get(path) ?? null; },
      async createFolder(path) {
        calls.folders.push(path);
        if (hooks.folder) await hooks.folder(path);
        if (files.has(path)) throw new Error('Controlled existing folder');
        const folder = new TFolder(path);
        files.set(path, folder);
        return folder;
      },
      async create(path, text) {
        calls.create.push(path);
        if (hooks.create) await hooks.create(path);
        if (files.has(path)) throw new Error('Controlled existing file');
        const file = new TFile(path);
        files.set(path, file);
        contents.set(path, text);
        return file;
      },
      async read(file) {
        calls.read.push(file.path);
        if (!contents.has(file.path)) throw new Error('Controlled missing file');
        return contents.get(file.path);
      },
      async process(file, update) {
        calls.process.push(file.path);
        if (hooks.process) await hooks.process(file);
        if (!contents.has(file.path)) throw new Error('Controlled missing file');
        const next = update(contents.get(file.path));
        contents.set(file.path, next);
        return next;
      },
    },
    fileManager: {
      async trashFile(file) {
        calls.trash.push(file.path);
        if (!files.has(file.path)) throw new Error('Controlled missing file');
        files.delete(file.path);
        contents.delete(file.path);
      },
    },
  };
  return { repository: new TimelineFileRepository(app), files, contents, calls, hooks };
}

function populatedState() {
  const state = createDefaultState();
  state.timeline.entries.push({ entryId: 'note-one', filePath: 'notes/Один.md', preferredLane: 2, expanded: true, fallbackDate: '2026-10-23' });
  state.timeline.orientation = 'vertical';
  state.timeline.reverse = true;
  state.timeline.extension = { futureOption: 'retained' };
  return state;
}

test('timeline JSON round trip validates and retains orientation, reversal and unknown compatible fields', () => {
  const state = populatedState();
  const text = serializeTimeline(state);
  assert.equal(text.endsWith('\n'), true);
  assert.match(text, /\n {2}"schemaVersion": 1,/);
  assert.deepEqual(parseTimeline(text), validateState(state));
  assert.deepEqual(state, populatedState(), 'Serialization must not mutate the input state');
});

test('invalid JSON, null roots and incompatible states fail without silently resetting a file', () => {
  for (const text of ['', '{broken', 'null', '42', '[]', '{"schemaVersion":99}']) {
    assert.throws(() => parseTimeline(text), /JSON|состояни|объект|Версия/);
  }
  assert.throws(() => serializeTimeline(null), /объект состояния/);
  const state = populatedState();
  state.timeline.entries[0].filePath = '../outside.md';
  assert.throws(() => serializeTimeline(state), /неверная запись/);
});

test('list returns only timeline files in deterministic path order without modifying the vault list', () => {
  const state = harness({ 'z.timeline': '{}', 'notes/A.md': '', 'a.timeline': '{}', 'B.timeline': '{}', 'upper.TIMELINE': '' });
  const original = [...state.files.keys()];
  assert.deepEqual(state.repository.list().map(file => file.path), ['B.timeline', 'a.timeline', 'z.timeline']);
  assert.deepEqual([...state.files.keys()], original);
});

test('create writes a validated document and creates missing parent folders in order', async () => {
  const state = harness();
  const file = await state.repository.create('Timelines/Работа/Ось.timeline', populatedState());
  assert.equal(file.path, 'Timelines/Работа/Ось.timeline');
  assert.deepEqual(state.calls.folders, ['Timelines', 'Timelines/Работа']);
  assert.deepEqual(parseTimeline(state.contents.get(file.path)), validateState(populatedState()));
  const empty = await state.repository.create('Empty.timeline');
  assert.deepEqual(parseTimeline(state.contents.get(empty.path)), createDefaultState());
});

test('create rejects unsafe paths before touching the vault', async () => {
  for (const path of ['outside.md', '/absolute.timeline', '../outside.timeline', 'a/../b.timeline', './a.timeline', 'a//b.timeline', 'a\\b.timeline', 'C:/outside.timeline', 'a/ b.timeline', 'a/b.timeline ', 'a/\0b.timeline', 'a/b\nb.timeline', '.timeline']) {
    const state = harness();
    await assert.rejects(state.repository.create(path), /относительный путь/);
    assert.deepEqual(state.calls, { create: [], folders: [], read: [], process: [], trash: [] });
  }
});

test('create never overwrites an existing file or a file winning a creation race', async () => {
  const existing = harness({ 'Old.timeline': 'Original data' });
  await assert.rejects(existing.repository.create('Old.timeline'), /уже существует/);
  assert.equal(existing.contents.get('Old.timeline'), 'Original data');
  assert.deepEqual(existing.calls.create, []);
  const racing = harness();
  racing.hooks.create = path => { racing.files.set(path, new TFile(path)); racing.contents.set(path, 'External data'); };
  await assert.rejects(racing.repository.create('Race.timeline'), /existing file/);
  assert.equal(racing.contents.get('Race.timeline'), 'External data');
});

test('folder creation races are accepted only when the winning object is a verified folder', async () => {
  const winningFolder = harness();
  winningFolder.hooks.folder = path => { winningFolder.files.set(path, new TFolder(path)); };
  await winningFolder.repository.create('Folder/Axis.timeline');
  assert.equal(winningFolder.contents.has('Folder/Axis.timeline'), true);
  const winningFile = harness();
  winningFile.hooks.folder = path => { winningFile.files.set(path, new TFile(path)); };
  await assert.rejects(winningFile.repository.create('Folder/Axis.timeline'), /existing folder/);
  assert.deepEqual(winningFile.calls.create, []);
  const failedFolder = harness();
  const error = new Error('Controlled permission denied');
  failedFolder.hooks.folder = () => { throw error; };
  await assert.rejects(failedFolder.repository.create('Folder/Axis.timeline'), candidate => candidate === error);
});

test('existing parent files and invalid state block create without writing a timeline', async () => {
  const state = harness({ Folder: 'Data' });
  await assert.rejects(state.repository.create('Folder/Axis.timeline'), /путь занят файлом/);
  assert.deepEqual(state.calls.create, []);
  const invalid = populatedState();
  invalid.schemaVersion = 10;
  await assert.rejects(state.repository.create('New/Axis.timeline', invalid), /Версия состояния/);
  assert.deepEqual(state.calls.folders, []);
});

test('load reads the current exact disk text and rejects a corrupt document without modifying it', async () => {
  const text = JSON.stringify(populatedState());
  const state = harness({ 'Axis.timeline': text, 'Broken.timeline': '{broken' });
  assert.deepEqual(await state.repository.load(state.files.get('Axis.timeline')), { state: validateState(populatedState()), text });
  await assert.rejects(state.repository.load(state.files.get('Broken.timeline')), /JSON временной оси/);
  assert.equal(state.contents.get('Broken.timeline'), '{broken');
  assert.deepEqual(state.calls.process, []);
});

test('save writes only through the atomic transaction and accepts a repeated own-content echo', async () => {
  const expected = JSON.stringify(createDefaultState());
  const state = harness({ 'Axis.timeline': expected });
  const file = state.files.get('Axis.timeline');
  const next = await state.repository.save(file, populatedState(), expected);
  assert.equal(next, serializeTimeline(populatedState()));
  assert.equal(state.contents.get(file.path), next);
  assert.equal(await state.repository.save(file, populatedState(), expected), next);
  assert.deepEqual(state.calls.process, ['Axis.timeline', 'Axis.timeline']);
  assert.deepEqual(state.calls.read, []);
});

test('save refuses any unexpected external edit, including an edit between load and transaction', async () => {
  const expected = serializeTimeline(createDefaultState());
  const state = harness({ 'Axis.timeline': expected });
  const file = state.files.get('Axis.timeline');
  const external = { ...createDefaultState(), remoteField: 'Keep this value' };
  const externalText = serializeTimeline(external);
  state.hooks.process = () => { state.contents.set(file.path, externalText); };
  await assert.rejects(state.repository.save(file, populatedState(), expected), error => error instanceof TimelineConflictError && error.name === 'TimelineConflictError');
  assert.equal(state.contents.get(file.path), externalText);
});

test('save validates both expected and next documents before attempting a write', async () => {
  const expected = serializeTimeline(createDefaultState());
  const state = harness({ 'Axis.timeline': expected });
  const file = state.files.get('Axis.timeline');
  await assert.rejects(state.repository.save(file, populatedState(), 'null'), /объект состояния/);
  await assert.rejects(state.repository.save(file, { ...populatedState(), schemaVersion: 77 }, expected), /Версия состояния/);
  assert.equal(state.contents.get(file.path), expected);
  assert.deepEqual(state.calls.process, []);
});

test('corrupt external content and storage failures are preserved rather than reset or swallowed', async () => {
  const expected = serializeTimeline(createDefaultState());
  const state = harness({ 'Axis.timeline': '{externally broken' });
  const file = state.files.get('Axis.timeline');
  await assert.rejects(state.repository.save(file, populatedState(), expected), TimelineConflictError);
  assert.equal(state.contents.get(file.path), '{externally broken');
  state.contents.set(file.path, expected);
  const error = new Error('Controlled storage failure');
  state.hooks.process = () => { throw error; };
  await assert.rejects(state.repository.save(file, populatedState(), expected), candidate => candidate === error);
  assert.equal(state.contents.get(file.path), expected);
});

test('remove delegates to recoverable FileManager trash and never uses permanent deletion', async () => {
  const text = serializeTimeline(createDefaultState());
  const state = harness({ 'Axis.timeline': text });
  await state.repository.remove(state.files.get('Axis.timeline'));
  assert.deepEqual(state.calls.trash, ['Axis.timeline']);
  assert.equal(state.files.has('Axis.timeline'), false);
});
