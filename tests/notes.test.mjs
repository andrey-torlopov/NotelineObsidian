import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extractFrontmatter } from '../src/domain/metadata.ts';

// This tests service transactions, not Obsidian itself. JSON is a valid YAML subset;
// its controlled parser keeps the harness independent of Obsidian's private runtime.
const stubUrl = `data:text/javascript,${encodeURIComponent(`
  export class App {}
  export class TFile { constructor(path) { this.path = path; this.extension = 'md'; } }
  export class MarkdownView {
    constructor(file, editor, mode = 'source') { this.file = file; this.editor = editor; this.mode = mode; }
    getMode() { return this.mode; }
  }
  export function parseYaml(text) { return text.trim() ? JSON.parse(text) : undefined; }
`)}`;
registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === 'obsidian' ? { url: stubUrl, shortCircuit: true } : nextResolve(specifier, context);
} });

const { MarkdownView, TFile } = await import('obsidian');
const { addTag, metadataOptions, parseNote, replaceChangedSpan } = await import('../src/services/notes.ts');
const dateProperties = ['timeline-date', 'date'];

function editorWith(initial) {
  let value = initial;
  const replacements = [];
  const offsetToPos = offset => {
    const lines = value.slice(0, offset).split('\n');
    return { line: lines.length - 1, ch: lines.at(-1).length };
  };
  const posToOffset = position => value.split('\n').slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.ch;
  return {
    getValue: () => value,
    offsetToPos,
    replacements,
    replaceRange(inserted, from, to) {
      const start = posToOffset(from);
      const end = posToOffset(to);
      replacements.push({ inserted, start, end });
      value = value.slice(0, start) + inserted + value.slice(end);
    },
  };
}

function noteWithYaml(frontmatter, body = '# Body\nUnchanged body\n') {
  return `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
}

function harness(initial) {
  const file = new TFile('folder/note.md');
  let text = initial;
  const leaves = [];
  const calls = { read: 0, process: 0, frontmatter: 0 };
  const hooks = { beforeProcess: null, beforeFrontmatter: null };
  const app = {
    workspace: { iterateAllLeaves(callback) { for (const leaf of leaves) callback(leaf); } },
    vault: {
      async read() { calls.read += 1; return text; },
      async process(_file, update) {
        calls.process += 1;
        if (hooks.beforeProcess) await hooks.beforeProcess();
        const result = update(text);
        text = result;
        return result;
      },
    },
    fileManager: {
      async processFrontMatter(_file, update) {
        calls.frontmatter += 1;
        if (hooks.beforeFrontmatter) await hooks.beforeFrontmatter();
        const block = extractFrontmatter(text);
        assert.ok(block, 'A frontmatter operation requires frontmatter');
        const properties = JSON.parse(block.text);
        update(properties);
        text = `${text.slice(0, block.start)}${noteWithYaml(properties, text.slice(block.end))}`;
      },
    },
  };
  return { app, file, calls, hooks, leaves, get text() { return text; }, set text(next) { text = next; },
    openEditor(value = text) {
      const editor = editorWith(value);
      leaves.push({ view: new MarkdownView(file, editor) });
      return editor;
    } };
}

test('metadata adapter reports invalid YAML roots and errors instead of guessing dates', () => {
  assert.deepEqual(metadataOptions('Body', dateProperties), { dateProperties });
  assert.equal(parseNote(noteWithYaml({ date: '2026-10-22', tags: ['one'] }), dateProperties).date.kind, 'valid');
  for (const text of ['---\n[]\n---\n📅 2026-10-22', '---\n42\n---', '---\n{broken\n---', '---\nnot closed']) {
    const options = metadataOptions(text, dateProperties);
    assert.equal(typeof options.frontmatterError, 'string');
    assert.equal(parseNote(text, dateProperties).date.kind, 'invalid');
  }
});

test('metadata adapter keeps numeric YAML years, partial dates and BCE precision', () => {
  const cases = [[2026, 'year', '2026'], [44, 'year', '0044'], ['2026-10', 'month', '2026-10'], ['XIX', 'century', 'XIX'], ['44 до н.э.', 'year', '0044 BC'], ['II BC', 'century', 'II BC']];
  for (const [date, precision, canonical] of cases) {
    const metadata = parseNote(noteWithYaml({ date, tags: ['one'] }), dateProperties);
    assert.equal(metadata.date.kind, 'valid', String(date));
    assert.equal(metadata.date.date.precision, precision);
    assert.equal(metadata.date.date.value, canonical);
  }
});

test('changed span retains surrounding bytes and sends a single editor transaction', () => {
  const before = '\uFEFF📅 2026-10-22\n📍 Tags: #old\nUnsaved text 🧭';
  const editor = editorWith(before);
  const after = before.replace('#old', '#old #новый');
  replaceChangedSpan(new MarkdownView(new TFile('note.md'), editor), before, after);
  assert.equal(editor.getValue(), after);
  assert.deepEqual(editor.replacements, [{ inserted: ' #новый', start: before.indexOf('#old') + '#old'.length, end: before.indexOf('#old') + '#old'.length }]);
});

test('source editor writes use current unsaved buffer and never overwrite the disk revision', async () => {
  const state = harness('📍 Tags: #disk\nSaved text');
  const editor = state.openEditor('📍 Tags: #buffer\nUnsaved text');
  await addTag(state.app, state.file, dateProperties, 'new');
  assert.equal(editor.getValue(), '📍 Tags: #buffer #new\nUnsaved text');
  assert.equal(state.text, '📍 Tags: #disk\nSaved text');
  assert.deepEqual(state.calls, { read: 0, process: 0, frontmatter: 0 });
});

test('open editor frontmatter operation is rejected without touching buffer or disk', async () => {
  const initial = noteWithYaml({ tags: ['existing'], unrelated: true });
  const state = harness(initial);
  const editor = state.openEditor();
  await assert.rejects(addTag(state.app, state.file, dateProperties, 'new'), /Properties|редактор/);
  assert.equal(state.text, initial);
  assert.equal(editor.getValue(), initial);
  assert.deepEqual(editor.replacements, []);
  assert.deepEqual(state.calls, { read: 0, process: 0, frontmatter: 0 });
});

test('Vault.process recomputes a marker edit against the actual concurrent revision', async () => {
  const state = harness('📍 Tags: #one\nOld body');
  state.hooks.beforeProcess = () => { state.text = '📍 Tags: #one #concurrent\nCurrent body'; };
  await addTag(state.app, state.file, dateProperties, 'new');
  assert.equal(state.text, '📍 Tags: #one #concurrent #new\nCurrent body');
  assert.deepEqual(state.calls, { read: 1, process: 1, frontmatter: 0 });
});

test('a concurrent addition becomes a noop without creating a second tag', async () => {
  const state = harness('📍 Tags: #one\nBody');
  state.hooks.beforeProcess = () => { state.text = '📍 Tags: #one #NEW\nCurrent body'; };
  await addTag(state.app, state.file, dateProperties, 'new');
  assert.equal(state.text, '📍 Tags: #one #NEW\nCurrent body');
});

test('a destination change aborts the marker transaction and preserves current contents', async () => {
  const state = harness('📍 Tags: #one\nBody');
  const concurrent = noteWithYaml({ tags: ['one'], unrelated: 'current' });
  state.hooks.beforeProcess = () => { state.text = concurrent; };
  await assert.rejects(addTag(state.app, state.file, dateProperties, 'new'), /Место записи/);
  assert.equal(state.text, concurrent);
});

test('an editor opened during a pending text transaction prevents a disk write', async () => {
  const initial = '📍 Tags: #one\nSaved body';
  const state = harness(initial);
  let editor;
  state.hooks.beforeProcess = () => { editor = state.openEditor('📍 Tags: #one\nNew buffer'); };
  await assert.rejects(addTag(state.app, state.file, dateProperties, 'new'), /редактор/);
  assert.equal(state.text, initial);
  assert.equal(editor.getValue(), '📍 Tags: #one\nNew buffer');
});

test('YAML accepts each supported tags shape and preserves body and other properties', async () => {
  const cases = [
    [['one'], ['one', 'new']],
    ['one', ['one', 'new']],
    ['one, two', ['one', 'two', 'new']],
    ['#one #two', ['#one', '#two', 'new']],
    [[], ['new']],
    ['', ['new']],
    [null, ['new']],
  ];
  for (const [tags, expectedTags] of cases) {
    const state = harness(noteWithYaml({ tags, other: { nested: true }, date: '2026-10-22' }));
    const body = state.text.slice(extractFrontmatter(state.text).end);
    await addTag(state.app, state.file, dateProperties, 'new');
    const options = metadataOptions(state.text, dateProperties);
    assert.deepEqual(options.frontmatter.tags, expectedTags, JSON.stringify(tags));
    assert.deepEqual(options.frontmatter.other, { nested: true });
    assert.equal(options.frontmatter.date, '2026-10-22');
    assert.equal(state.text.slice(extractFrontmatter(state.text).end), body);
  }
});

test('tag writes preserve numeric and partial source date values and precision', async () => {
  for (const date of [2026, '2026-10', '44 BCE', 'II д.н.э.']) {
    const state = harness(noteWithYaml({ date, tags: ['one'] }));
    await addTag(state.app, state.file, dateProperties, 'new');
    assert.equal(metadataOptions(state.text, dateProperties).frontmatter.date, date);
    assert.equal(parseNote(state.text, dateProperties).date.kind, 'valid');
  }
  for (const date of ['2026-10', '44 BC', 'II до н.э.']) {
    const state = harness(`📅 ${date}\n📍 Tags: #one\nBody`);
    await addTag(state.app, state.file, dateProperties, 'new');
    assert.equal(state.text, `📅 ${date}\n📍 Tags: #one #new\nBody`);
  }
});

test('YAML callback revalidates concurrent tag values before any property mutation', async () => {
  const state = harness(noteWithYaml({ tags: ['one'], other: 'initial' }));
  const concurrent = noteWithYaml({ tags: ['bad value'], other: 'current' });
  state.hooks.beforeFrontmatter = () => { state.text = concurrent; };
  await assert.rejects(addTag(state.app, state.file, dateProperties, 'new'), /tags|тег/);
  assert.equal(state.text, concurrent);
});

test('YAML callback sees concurrent valid tags and avoids case-insensitive duplicates', async () => {
  const state = harness(noteWithYaml({ tags: ['one'], other: 'initial' }));
  state.hooks.beforeFrontmatter = () => { state.text = noteWithYaml({ tags: ['one', '#NEW', 'concurrent'], other: 'current' }); };
  await addTag(state.app, state.file, dateProperties, 'new');
  const values = metadataOptions(state.text, dateProperties).frontmatter;
  assert.equal(values.tags.filter(tag => tag.replace(/^#/, '').toLowerCase() === 'new').length, 1);
  assert.ok(values.tags.includes('concurrent'));
  assert.equal(values.other, 'current');
});

test('an editor opened while processFrontMatter awaits I/O prevents its callback mutation', async () => {
  const initial = noteWithYaml({ tags: ['one'] });
  const state = harness(initial);
  let editor;
  state.hooks.beforeFrontmatter = () => { editor = state.openEditor(`${initial}\nUnsaved changes`); };
  await assert.rejects(addTag(state.app, state.file, dateProperties, 'new'), /редактор|Properties/);
  assert.equal(state.text, initial);
  assert.equal(editor.getValue(), `${initial}\nUnsaved changes`);
});

test('I/O failures propagate and never announce a successful local mutation', async () => {
  const initial = '📍 Tags: #one\nBody';
  const state = harness(initial);
  state.hooks.beforeProcess = () => { throw new Error('Controlled I/O failure'); };
  await assert.rejects(addTag(state.app, state.file, dateProperties, 'new'), /Controlled I\/O failure/);
  assert.equal(state.text, initial);
});

test('comments and reference labels do not suppress addition of a real tag', async () => {
  for (const initial of ['%% #hidden %%', '[#hidden][ref]\n\n[ref]: https://example.com']) {
    const state = harness(initial);
    await addTag(state.app, state.file, dateProperties, 'hidden');
    assert.equal(state.text, `📍 Tags: #hidden\n${initial}`);
  }
});
