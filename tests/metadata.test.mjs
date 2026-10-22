import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  analyzeNote,
  calendarDateToday,
  extractFrontmatter,
  normalizeTag,
  parseCalendarDate,
  planTagAddition,
} from '../src/domain/metadata.ts';

const options = { dateProperties: ['timeline-date', 'date'] };
const analyze = (text, overrides = {}) => analyzeNote(text, { ...options, ...overrides });
const add = (text, tag, overrides = {}) => planTagAddition(text, { ...options, ...overrides }, tag);

test('calendar accepts Gregorian boundary years and preserves minute precision', () => {
  for (const input of ['0001-01-01', '0099-12-31', '0100-01-01', '9999-12-31', '2000-02-29', '2024-02-29']) {
    const date = parseCalendarDate(input);
    assert.ok(date, input);
    assert.equal(date.value, input);
    assert.equal(date.precision, 'day');
    assert.equal(new Date(date.coordinate).getUTCFullYear(), Number(input.slice(0, 4)));
  }
  for (const input of ['2026-10-22 15:30', '2026-10-22T15:30', '2026-10-22T15:30:00']) {
    const date = parseCalendarDate(input);
    assert.equal(date?.value, '2026-10-22 15:30');
    assert.equal(date?.precision, 'minute');
  }
  const day = parseCalendarDate('2026-10-22');
  const minute = parseCalendarDate('2026-10-22 00:01');
  assert.equal(minute.coordinate - day.coordinate, 60_000);
});

test('calendar rejects impossible, ambiguous and unsupported absolute dates', () => {
  for (const value of [
    '0000-01-01', '10000-01-01', '1900-02-29', '2100-02-29', '2026-02-29',
    '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-01-32',
    '2026-1-01', '26-01-01', '22/10/26', '2026-10-22 24:00', '2026-10-22 12:60',
    '2026-10-22T15:30:01', '2026-10-22T15:30:00.000', '2026-10-22T15:30Z',
    '2026-10-22T15:30+03:00', '2026-10-22 15:30:00', ' 2026-10-22', '2026-10-22 ',
  ]) assert.equal(parseCalendarDate(value), null, value);
});

test('calendar coordinates are identical across UTC, Moscow and DST zones', () => {
  const moduleUrl = new URL('../src/domain/metadata.ts', import.meta.url).href;
  const script = `import {parseCalendarDate} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(['0001-01-01','0099-12-31','2026-03-08 02:30','2026-11-01 01:30'].map(value=>parseCalendarDate(value))));`;
  const values = ['UTC', 'Europe/Moscow', 'America/New_York'].map((TZ) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  assert.deepEqual(values[0], values[1]);
  assert.deepEqual(values[0], values[2]);
});

test('today uses injected local calendar values and rejects invalid clocks', () => {
  const now = new Date(2026, 9, 22, 23, 59);
  assert.equal(calendarDateToday(now), '2026-10-22');
  const earlyYear = new Date(0);
  earlyYear.setFullYear(1, 0, 1);
  assert.equal(calendarDateToday(earlyYear), '0001-01-01');
  assert.throws(() => calendarDateToday(new Date(Number.NaN)), /часы/);
});

test('frontmatter boundaries preserve BOM, CRLF and Markdown body', () => {
  const text = '\uFEFF---\r\ndate: 2026-10-22\r\ntags: [one]\r\n---\r\n# Body\r\n';
  const frontmatter = extractFrontmatter(text);
  assert.equal(frontmatter.start, 1);
  assert.equal(frontmatter.text, 'date: 2026-10-22\r\ntags: [one]\r\n');
  assert.equal(text.slice(frontmatter.end), '# Body\r\n');
  assert.equal(extractFrontmatter('\n---\ndate: test\n---'), null);
  assert.equal(extractFrontmatter('Text\n---\n'), null);
});

test('malformed YAML delimiters and parser errors are never masked by a marker', () => {
  assert.throws(() => extractFrontmatter('---\ndate: broken'), /закрывающая/);
  assert.equal(analyze('---\ndate: broken').date.kind, 'invalid');
  const value = analyze('---\ndate: [\n---\n📅 2026-10-22', { frontmatterError: 'Unclosed sequence' });
  assert.equal(value.date.kind, 'invalid');
  assert.match(value.date.message, /Unclosed sequence/);
  assert.throws(() => add('---\ndate: broken', 'test'), /закрывающая/);
});

test('provided sample header yields one date, empty tags and only the visible body', () => {
  const text = '\uFEFF📅 2026-10-22\r\n🧭 MOC:\r\n\r\n📍 Tags:\r\n🔗 Links:\r\n\r\n---\r\n\r\n# Идеи\r\nТекст';
  const value = analyze(text);
  assert.deepEqual(value.date, { kind: 'valid', date: parseCalendarDate('2026-10-22'), source: 'marker', warnings: [] });
  assert.deepEqual(value.tags, []);
  assert.equal(value.missingTags, true);
  assert.equal(value.body, '# Идеи\r\nТекст');
});

test('date source priority reports lower source conflicts without silent fallback', () => {
  const text = '📅 2026-10-22\nBody';
  const value = analyze(text, { frontmatter: { 'timeline-date': '2026-10-23', date: '2026-10-24' } });
  assert.equal(value.date.kind, 'valid');
  assert.equal(value.date.source, 'property:timeline-date');
  assert.equal(value.date.date.value, '2026-10-23');
  assert.equal(value.date.warnings.length, 2);
  const invalid = analyze(text, { frontmatter: { 'timeline-date': '2026-02-30', date: '2026-10-24' } });
  assert.equal(invalid.date.kind, 'invalid');
  assert.match(invalid.date.message, /timeline-date/);
});

test('empty properties are skipped, non-string properties are rejected', () => {
  const value = analyze('📅 2026-10-22', { frontmatter: { 'timeline-date': '  ', date: null } });
  assert.equal(value.date.source, 'marker');
  for (const invalid of [123, true, [], {}, new Date()]) {
    assert.equal(analyze('📅 2026-10-22', { frontmatter: { 'timeline-date': invalid } }).date.kind, 'invalid');
  }
  assert.equal(analyze('Body', { frontmatter: { 'timeline-date': '', date: '2026-10-22T12:00:00' } }).date.source, 'property:date');
});

test('same source value has no conflict; invalid lower source produces a warning', () => {
  const same = analyze('📅 2026-10-22', { frontmatter: { date: '2026-10-22' } });
  assert.deepEqual(same.date.warnings, []);
  const invalid = analyze('📅 2026-02-30', { frontmatter: { date: '2026-10-22' } });
  assert.equal(invalid.date.kind, 'valid');
  assert.match(invalid.date.warnings[0], /некорректную/);
});

test('header requires exact marker grammar and treats duplicates as ambiguity', () => {
  assert.equal(analyze('📅 2026-10-22 15:30  \nBody').date.date.precision, 'minute');
  for (const line of ['📅2026-10-22', '📅 2026-10-22T15:30', '📅 2026-10-22 15:30:00', '📅 yesterday', '📅']) {
    assert.equal(analyze(line).date.kind, 'invalid', line);
  }
  const duplicate = analyze('📅 2026-10-22\n📅 2026-10-22\nBody');
  assert.equal(duplicate.date.kind, 'invalid');
  assert.match(duplicate.body, /^📅/);
  const property = analyze('📅 2026-10-22\n📅 2026-10-22', { frontmatter: { date: '2026-10-22' } });
  assert.equal(property.date.kind, 'valid');
  assert.equal(property.date.warnings.length, 1);
});

test('headings, separators, quotes, code, other text and line 33 stop initial metadata', () => {
  for (const prefix of ['# Heading\n', '> quoted\n', '```\n', '~~~\n', '    code\n', 'Text\n']) {
    assert.equal(analyze(`${prefix}📅 2026-10-22`).date.kind, 'missing', prefix);
  }
  assert.equal(analyze(`${'\n'.repeat(32)}📅 2026-10-22`).date.kind, 'missing');
  assert.equal(analyze(`${'\n'.repeat(31)}📅 2026-10-22`).date.kind, 'valid');
  const yaml = `---\n${'field: x\n'.repeat(40)}---\n📅 2026-10-22`;
  assert.equal(analyze(yaml).date.kind, 'valid');
  assert.equal(analyze('🧭 MOC:\n---\n📅 2026-10-22').date.kind, 'missing');
});

test('the four missing-field combinations keep date and tags independent', () => {
  const cases = [
    ['📅 2026-10-22\n📍 Tags: #one', 'valid', false],
    ['📍 Tags: #one', 'missing', false],
    ['📅 2026-10-22\n📍 Tags:', 'valid', true],
    ['Text', 'missing', true],
  ];
  for (const [text, dateKind, missingTags] of cases) {
    const value = analyze(text);
    assert.equal(value.date.kind, dateKind);
    assert.equal(value.missingTags, missingTags);
  }
});

test('tags support Unicode and nesting but reject spaces, invalid segments and pure numbers', () => {
  for (const [value, expected] of [['#идеи/аудио', 'идеи/аудио'], ['Ёжик', 'Ёжик'], ['a-b_c', 'a-b_c'], [' #Tag ', 'Tag'], ['2026/10', '2026/10']]) {
    assert.equal(normalizeTag(value), expected);
  }
  for (const value of ['', '#', '##tag', '123', '١٢٣', 'hello world', 'a//b', '/tag', 'tag/', 'tag.', 'x:y']) {
    assert.equal(normalizeTag(value), null, value);
  }
});

test('tag union deduplicates case and preserves first source spelling', () => {
  const value = analyze('📍 Tags: #ONE #идеи/аудио\nText #three', {
    frontmatter: { tags: ['One', 'Two'] }, inlineTags: ['#two', '#three'],
  });
  assert.deepEqual(value.tags, ['One', 'Two', 'three', 'идеи/аудио']);
  assert.equal(value.missingTags, false);
  assert.deepEqual(analyze('Text', { frontmatter: { tags: 'one, two #three' } }).tags, ['one', 'two', 'three']);
});

test('cache tags are authoritative; malformed YAML tags retain readable values and diagnostics', () => {
  assert.deepEqual(analyze('Text #not-in-cache', { inlineTags: [] }).tags, []);
  const value = analyze('Text #body', { frontmatter: { tags: ['valid', 123, null] } });
  assert.deepEqual(value.tags, ['valid', 'body']);
  assert.match(value.warnings[0], /tags/);
  assert.equal(analyze('Text', { frontmatter: { tags: [] } }).missingTags, true);
  assert.equal(analyze('Text', { frontmatter: { tags: null } }).missingTags, true);
});

test('fallback inline scanning excludes code, links, URLs, comments and headings', () => {
  const text = [
    '# Heading', '##heading', 'Text #visible #идеи/аудио', '`#inline` ``x ` #nested``',
    '```js', '#fenced', '~~~', '#still-fenced', '```', '~~~', '#tilde', '~~~',
    '    #indented', '\t#tab', '\\#escaped', '[#label](https://example.com/#fragment)',
    '[[Note#heading|#alias]]', 'https://example.com/a?x=#query', '<!-- #hidden', '#still-hidden --> #shown',
    '#123 #a//b',
  ].join('\n');
  assert.deepEqual(analyze(text).tags, ['visible', 'идеи/аудио', 'shown']);
});

test('Obsidian comments and reference links do not become tags or block a real addition', () => {
  const text = [
    '%% #hidden %% #visible', '%% multiline', '```', '#also-hidden', '%% #shown',
    '`%%` #after-code', '`<!--` #after-html-code',
    '[#label][target] [#collapsed][] [#shortcut]', '[#not-a-link]',
    '[target]: https://example.com/#anchor', '[#collapsed]: /path', '[#shortcut]: /path',
  ].join('\n');
  assert.deepEqual(analyze(text).tags, ['visible', 'shown', 'after-code', 'after-html-code', 'not-a-link']);
  assert.equal(add('%% #hidden %%', 'hidden').kind, 'text');
  assert.equal(add('[#label][ref]\n\n[ref]: https://example.com', 'label').kind, 'text');
});

test('tag marker writes preserve all bytes outside a single insertion, including BOM and CRLF', () => {
  const text = '\uFEFF📅 2026-10-22\r\n📍 Tags: #one   \r\n---\r\nBody\r\n';
  const result = add(text, 'идеи/аудио');
  assert.equal(result.kind, 'text');
  assert.equal(result.text, text.replace('#one', '#one #идеи/аудио'));
  assert.equal(result.text.replace(' #идеи/аудио', ''), text);
  const empty = add('📍 Tags:\nBody', 'first');
  assert.equal(empty.text, '📍 Tags: #first\nBody');
});

test('existing correct marker has priority over YAML tags', () => {
  const text = '---\ntags: [yaml]\n---\n📍 Tags: #marker\nBody';
  const result = add(text, 'new', { frontmatter: { tags: ['yaml'] } });
  assert.equal(result.kind, 'text');
  assert.equal(result.text, text.replace('#marker', '#marker #new'));
});

test('existing YAML tags use a structured frontmatter operation', () => {
  const text = '---\ntags: [one]\nother: untouched\n---\nBody';
  for (const tags of [['one'], 'one', [], '', null]) {
    assert.deepEqual(add(text, '#two', { frontmatter: { tags } }), { kind: 'frontmatter', tag: 'two' });
  }
  assert.throws(() => add(text, 'two', { frontmatter: { tags: { invalid: true } } }), /неподдерживаемые/);
  assert.throws(() => add(text, 'two', { frontmatter: { tags: ['one', 123] } }), /неподдерживаемые/);
});

test('new marker goes after date or frontmatter and leading blank lines', () => {
  assert.equal(add('📅 2026-10-22\r\n🧭 MOC:\r\nBody', 'one').text,
    '📅 2026-10-22\r\n📍 Tags: #one\r\n🧭 MOC:\r\nBody');
  assert.equal(add('📅 2026-10-22', 'one').text, '📅 2026-10-22\n📍 Tags: #one');
  assert.equal(add('\uFEFF---\r\nother: one\r\n---\r\n\r\n# Body', 'one', { frontmatter: { other: 'one' } }).text,
    '\uFEFF---\r\nother: one\r\n---\r\n\r\n📍 Tags: #one\r\n# Body');
  assert.equal(add('', 'one').text, '📍 Tags: #one\n');
  assert.equal(add('\uFEFFBody', 'one').text, '\uFEFF📍 Tags: #one\nBody');
  assert.equal(add('🧭 MOC:\nBody', 'one').text, '📍 Tags: #one\n🧭 MOC:\nBody');
});

test('transaction revalidation ignores stale cache and observes current source', () => {
  assert.equal(add('Body #existing', 'EXISTING', { inlineTags: [] }).kind, 'noop');
  const result = add('Body without tag', 'fresh', { inlineTags: ['#fresh'] });
  assert.equal(result.kind, 'text');
  assert.equal(result.text, '📍 Tags: #fresh\nBody without tag');
  assert.equal(add('📍 Tags: #Existing\nBody', 'existing').kind, 'noop');
});

test('ambiguous destinations and invalid input never produce a write', () => {
  assert.throws(() => add('📍 Tags: #one\n📍 Tags: #two', 'three'), /несколько строк/);
  assert.throws(() => add('📍 Tags: words without hashtags', 'three'), /неоднозначна/);
  assert.throws(() => add('📅 2026-10-22\n📅 2026-10-23', 'three'), /неоднозначным/);
  assert.throws(() => add('Body', '123'), /Некорректный тег/);
  assert.throws(() => add('---\nbroken: [\n---\nBody', 'one', { frontmatterError: 'Parse failure' }), /Parse failure/);
});

test('tag operations never modify original date or use tags outside the initial block as destinations', () => {
  const text = '# Body\n📍 Tags: #later\n📅 2026-10-22\n';
  const result = add(text, 'one');
  assert.equal(result.text, `📍 Tags: #one\n${text}`);
  assert.equal(analyze(result.text).date.kind, 'missing');
});
