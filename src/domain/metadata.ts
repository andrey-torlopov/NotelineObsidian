/** Pure calendar and Markdown metadata logic. Coordinates are UTC milliseconds. */
export interface CalendarDate {
  /** Canonical source text, retaining exactly the components supplied by the note. */
  value: string;
  coordinate: number;
  precision: 'minute' | 'day' | 'month' | 'year' | 'century';
}

export type DateResolution =
  | { kind: 'valid'; date: CalendarDate; source: string; warnings: string[] }
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string };

export interface MetadataOptions {
  dateProperties: readonly string[];
  /** Parsed from this exact Markdown revision by Obsidian's parseYaml. */
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
  /** Authoritative inline tags from Obsidian's ready metadata cache, when available. */
  inlineTags?: readonly string[];
}

export interface NoteMetadata {
  date: DateResolution;
  tags: string[];
  body: string;
  missingTags: boolean;
  warnings: string[];
}

export type TagAddition =
  | { kind: 'noop' }
  | { kind: 'text'; text: string }
  | { kind: 'frontmatter'; tag: string };

interface Line {
  text: string;
  start: number;
  end: number;
  ending: string;
}

interface Header {
  dates: Line[];
  tagLines: Line[];
  bodyStart: number;
  insertStart: number;
  hasMetadata: boolean;
}

const DATE_EXAMPLE = 'Допустимые форматы: YYYY-MM-DD, YYYY-MM-DD HH:mm, YYYY-MM, год 1–9999 или римский век I–C. Для года и века допускается BC, BCE, д.н.э. или до н.э.';
const TAG_PATTERN = /^[\p{L}\p{M}\p{N}_-]+(?:\/[\p{L}\p{M}\p{N}_-]+)*$/u;

/** Gregorian components use astronomical years internally: historical 1 BC is year 0. */
export function calendarCoordinate(astronomicalYear: number, month = 1, day = 1, hour = 0, minute = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(astronomicalYear, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getTime();
}

// C BC starts in historical 10000 BC; C CE finishes in year 10000.
export const MIN_SUPPORTED_COORDINATE = calendarCoordinate(-9999);
export const MAX_SUPPORTED_COORDINATE = calendarCoordinate(10001) - 1;

function romanCentury(value: number): string {
  const numerals: readonly (readonly [number, string])[] = [[100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let remaining = value;
  let result = '';
  for (const [amount, numeral] of numerals) {
    while (remaining >= amount) { result += numeral; remaining -= amount; }
  }
  return result;
}

function parseRomanCentury(value: string): number | null {
  if (!/^[IVXLC]+$/.test(value)) return null;
  const amounts: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    const amount = amounts[value[index] ?? ''] ?? 0;
    const following = amounts[value[index + 1] ?? ''] ?? 0;
    result += amount < following ? -amount : amount;
  }
  return result >= 1 && result <= 100 && romanCentury(result) === value ? result : null;
}

function assertDisplayYear(astronomicalYear: number): void {
  if (!Number.isSafeInteger(astronomicalYear) || astronomicalYear < -9999 || astronomicalYear > 10000) {
    throw new Error('Год вне поддерживаемого диапазона календаря.');
  }
}

export function formatCalendarYear(astronomicalYear: number, locale: 'ru' | 'en' = 'ru'): string {
  assertDisplayYear(astronomicalYear);
  return astronomicalYear > 0 ? String(astronomicalYear) : `${1 - astronomicalYear} ${locale === 'ru' ? 'до н. э.' : 'BC'}`;
}

export function formatCalendarCentury(astronomicalYear: number, locale: 'ru' | 'en' = 'ru'): string {
  assertDisplayYear(astronomicalYear);
  const century = astronomicalYear > 0 ? Math.floor((astronomicalYear - 1) / 100) + 1 : Math.floor(-astronomicalYear / 100) + 1;
  return `${romanCentury(century)} ${locale === 'ru' ? 'век' : 'century'}${astronomicalYear <= 0 ? locale === 'ru' ? ' до н. э.' : ' BC' : ''}`;
}

/** Display the source value, never reconstruct missing components from the sorting coordinate. */
export function formatCalendarDate(date: CalendarDate, locale: 'ru' | 'en' = 'ru'): string {
  if (!Number.isFinite(date.coordinate) || date.coordinate < MIN_SUPPORTED_COORDINATE || date.coordinate > MAX_SUPPORTED_COORDINATE) {
    throw new Error('Некорректная календарная координата.');
  }
  const source = parseCalendarDate(date.value);
  if (!source) throw new Error('Некорректное исходное значение даты.');
  const beforeCommonEra = source.value.endsWith(' BC');
  const value = beforeCommonEra ? source.value.slice(0, -3) : source.value;
  const era = beforeCommonEra ? locale === 'ru' ? ' до н. э.' : ' BC' : '';
  if (source.precision === 'year') return `${Number(value)}${era}`;
  if (source.precision === 'century') return `${value} ${locale === 'ru' ? 'век' : 'century'}${era}`;
  return source.value;
}

function linesOf(text: string, start = 0): Line[] {
  const lines: Line[] = [];
  const expression = /\r\n|\n|\r/g;
  expression.lastIndex = start;
  let position = start;
  for (let match = expression.exec(text); match; match = expression.exec(text)) {
    lines.push({ text: text.slice(position, match.index), start: position,
      end: match.index + match[0].length, ending: match[0] });
    position = match.index + match[0].length;
  }
  if (position < text.length || lines.length === 0) {
    lines.push({ text: text.slice(position), start: position, end: text.length, ending: '' });
  }
  return lines;
}

/** Offsets include delimiters and their final newline, while text contains only YAML. */
export function extractFrontmatter(markdown: string): { text: string; start: number; end: number } | null {
  const start = markdown.startsWith('\uFEFF') ? 1 : 0;
  const lines = linesOf(markdown, start);
  const first = lines[0];
  if (!first || !/^---[ \t]*$/.test(first.text)) return null;
  for (const line of lines.slice(1)) {
    if (/^---[ \t]*$/.test(line.text)) {
      return { text: markdown.slice(first.end, line.start), start, end: line.end };
    }
  }
  throw new Error('Поврежден YAML: отсутствует закрывающая строка --- frontmatter.');
}

/** Strict Gregorian wall-calendar parser. Never delegates to Date.parse or the host timezone. */
export function parseCalendarDate(value: string | number): CalendarDate | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1 || value > 9999) return null;
    return { value: String(value).padStart(4, '0'), coordinate: calendarCoordinate(value), precision: 'year' };
  }
  const era = /[ \t]+(?:BC|BCE|д\.[ \t]*н\.[ \t]*э\.|до[ \t]+н\.[ \t]*э\.)$/iu.exec(value);
  const historical = era ? value.slice(0, era.index) : value;
  const beforeCommonEra = era !== null;
  if (/^\d{1,4}$/.test(historical)) {
    const year = Number(historical);
    if (year < 1 || year > 9999) return null;
    return { value: `${String(year).padStart(4, '0')}${beforeCommonEra ? ' BC' : ''}`,
      coordinate: calendarCoordinate(beforeCommonEra ? 1 - year : year), precision: 'year' };
  }
  const century = parseRomanCentury(historical);
  if (century !== null) {
    return { value: `${historical}${beforeCommonEra ? ' BC' : ''}`,
      coordinate: calendarCoordinate(beforeCommonEra ? 1 - century * 100 : (century - 1) * 100 + 1), precision: 'century' };
  }
  if (beforeCommonEra) return null;
  const monthOnly = /^(\d{4})-(\d{2})$/.exec(value);
  if (monthOnly) {
    const year = Number(monthOnly[1]);
    const month = Number(monthOnly[2]);
    if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
    return { value, coordinate: calendarCoordinate(year, month), precision: 'month' };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:([ T])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[5] ?? 0);
  const minute = Number(match[6] ?? 0);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 ||
    hour > 23 || minute > 59 || (match[7] !== undefined && (match[4] !== 'T' || match[7] !== '00'))) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > (monthDays[month - 1] ?? 0)) return null;
  const precision = match[4] ? 'minute' : 'day';
  return { value: `${match[1]}-${match[2]}-${match[3]}${precision === 'minute' ? ` ${match[5]}:${match[6]}` : ''}`,
    coordinate: calendarCoordinate(year, month, day, hour, minute), precision };
}

/** Only the point of insertion uses local calendar time; persisted fallback values stay fixed. */
export function calendarDateToday(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('Невозможно получить текущую дату: часы вернули некорректное значение.');
  const year = now.getFullYear();
  if (year < 1 || year > 9999) throw new Error('Текущая дата вне поддерживаемого диапазона 0001–9999.');
  return `${String(year).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function normalizeTag(input: string): string | null {
  const value = input.trim().replace(/^#/, '');
  if (!TAG_PATTERN.test(value) || /^\p{N}+$/u.test(value)) return null;
  return value;
}

function parseHeader(markdown: string, start: number): Header {
  const header: Header = { dates: [], tagLines: [], bodyStart: start, insertStart: start, hasMetadata: false };
  const lines = linesOf(markdown, start);
  let position = start;
  let passedInitialBlanks = false;
  for (let index = 0; index < lines.length && index < 32; index += 1) {
    const line = lines[index];
    if (!line) break;
    if (/^[ \t]*$/.test(line.text)) {
      position = line.end;
      if (!passedInitialBlanks) header.insertStart = line.end;
      continue;
    }
    passedInitialBlanks = true;
    if (line.text.startsWith('📅')) header.dates.push(line);
    else if (line.text.startsWith('📍 Tags:')) header.tagLines.push(line);
    else if (!line.text.startsWith('🧭 MOC:') && !line.text.startsWith('🔗 Links:')) {
      if (header.hasMetadata && /^---[ \t]*$/.test(line.text)) {
        position = line.end;
        for (const following of lines.slice(index + 1)) {
          if (!/^[ \t]*$/.test(following.text)) break;
          position = following.end;
        }
      }
      break;
    }
    header.hasMetadata = true;
    position = line.end;
  }
  if (header.hasMetadata) header.bodyStart = position;
  return header;
}

function markerTags(line: Line): { tags: string[]; valid: boolean } {
  const contents = line.text.slice('📍 Tags:'.length).trim();
  if (!contents) return { tags: [], valid: true };
  const tokens = contents.split(/[\s,]+/u).filter(Boolean);
  const tags = tokens.map((token) => token.startsWith('#') ? normalizeTag(token) : null);
  return { tags: tags.filter((tag): tag is string => tag !== null), valid: tags.every((tag) => tag !== null) };
}

function frontmatterTags(frontmatter: Record<string, unknown> | undefined): { tags: string[]; valid: boolean; exists: boolean } {
  if (!frontmatter || !Object.prototype.hasOwnProperty.call(frontmatter, 'tags')) return { tags: [], valid: true, exists: false };
  const value = frontmatter.tags;
  if (value === undefined || value === null || value === '') return { tags: [], valid: true, exists: true };
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/u).filter(Boolean) : [value];
  const tags = values.map((entry: unknown) => typeof entry === 'string' ? normalizeTag(entry) : null);
  return { tags: tags.filter((tag): tag is string => tag !== null), valid: tags.every((tag) => tag !== null), exists: true };
}

function stripInlineMarkup(line: string, state: { comment: 'html' | 'obsidian' | null }): string {
  let output = '';
  for (let index = 0; index < line.length;) {
    if (state.comment) {
      const ending = state.comment === 'html' ? '-->' : '%%';
      if (line.startsWith(ending, index)) { state.comment = null; index += ending.length; }
      else index += 1;
    } else if (line[index] === '\\' && index + 1 < line.length) {
      output += '  ';
      index += 2;
    } else if (line.startsWith('<!--', index)) {
      state.comment = 'html';
      index += 4;
    } else if (line.startsWith('%%', index)) {
      state.comment = 'obsidian';
      index += 2;
    } else if (line[index] === '`') {
      const run = /^`+/.exec(line.slice(index))?.[0] ?? '`';
      let closing = line.indexOf(run, index + run.length);
      while (closing !== -1 && (line[closing - 1] === '`' || line[closing + run.length] === '`')) {
        closing = line.indexOf(run, closing + run.length);
      }
      if (closing === -1) {
        output += run;
        index += run.length;
      } else {
        output += ' '.repeat(closing + run.length - index);
        index = closing + run.length;
      }
    } else {
      output += line[index];
      index += 1;
    }
  }
  return output;
}

/** A conservative fallback for transaction-time revalidation, not a replacement for MetadataCache. */
function inlineTags(markdown: string): string[] {
  const tags: string[] = [];
  const visibleLines: string[] = [];
  let fence: { character: string; length: number } | null = null;
  const state: { comment: 'html' | 'obsidian' | null } = { comment: null };
  for (const line of linesOf(markdown)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (fenceMatch && !state.comment) {
      const delimiter = fenceMatch[1] ?? '';
      if (!fence) fence = { character: delimiter[0] ?? '`', length: delimiter.length };
      else if (delimiter[0] === fence.character && delimiter.length >= fence.length && !(fenceMatch[2] ?? '').trim()) fence = null;
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line.text)) continue;
    const text = stripInlineMarkup(line.text, state)
      .replace(/!?\[\[[^\]]*\]\]/g, ' ')
      .replace(/!?\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\\])*\)/g, ' ')
      .replace(/(?:https?:\/\/|mailto:)\S+/g, ' ')
      .replace(/<[^>]*>/g, ' ');
    visibleLines.push(text);
  }
  const referenceLabel = (value: string): string => value.replace(/\\(.)/g, '$1').trim().replace(/\s+/g, ' ').toLowerCase();
  const definitionPattern = /^ {0,3}\[((?:\\.|[^\]\\])+)\]:/;
  const definitions = new Set(visibleLines.flatMap((line) => {
    const label = definitionPattern.exec(line)?.[1];
    return label === undefined ? [] : [referenceLabel(label)];
  }));
  for (const line of visibleLines) {
    if (definitionPattern.test(line)) continue;
    const text = line.replace(/!?\[((?:\\.|[^\]\\])*)\][ \t]*\[((?:\\.|[^\]\\])*)\]/g,
      (whole: string, label: string, reference: string) => definitions.has(referenceLabel(reference || label)) ? ' ' : whole)
      .replace(/!?\[((?:\\.|[^\]\\])*)\]/g,
        (whole: string, label: string) => definitions.has(referenceLabel(label)) ? ' ' : whole);
    const expression = /(?:^|[^\p{L}\p{M}\p{N}_/#-])#([\p{L}\p{M}\p{N}_/-]+)/gu;
    for (const match of text.matchAll(expression)) {
      const tag = normalizeTag(match[1] ?? '');
      if (tag) tags.push(tag);
    }
  }
  return tags;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function resolveDate(header: Header, options: MetadataOptions): DateResolution {
  if (options.frontmatterError) return { kind: 'invalid', message: `Ошибка YAML: ${options.frontmatterError}` };
  const sources: { source: string; date: CalendarDate | null; message: string }[] = [];
  for (const property of options.dateProperties) {
    const value = options.frontmatter?.[property];
    if (isEmpty(value)) continue;
    const date = typeof value === 'string' || typeof value === 'number' ? parseCalendarDate(typeof value === 'string' ? value.trim() : value) : null;
    sources.push({ source: `property:${property}`, date,
      message: `Свойство «${property}»: ${typeof value === 'string' || typeof value === 'number' ? 'некорректная или неподдерживаемая дата' : 'дата должна быть строкой либо целым годом'}. ${DATE_EXAMPLE}` });
  }
  if (header.dates.length > 1) {
    sources.push({ source: 'marker', date: null, message: 'В начальном блоке несколько строк 📅; оставьте одну строку даты.' });
  } else if (header.dates[0]) {
    const marker = /^📅 (\S(?:.*\S)?)[ \t]*$/u.exec(header.dates[0].text);
    const candidate = marker?.[1] ?? '';
    // Keep the original marker grammar for clock values; YAML also accepts ISO T notation.
    const date = marker && !/^\d{4}-\d{2}-\d{2}T/.test(candidate) && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:/.test(candidate)
      ? parseCalendarDate(candidate) : null;
    sources.push({ source: 'marker', date, message: `Строка 📅 содержит некорректную или неподдерживаемую дату. ${DATE_EXAMPLE}` });
  }
  const selected = sources[0];
  if (!selected) return { kind: 'missing' };
  if (!selected.date) return { kind: 'invalid', message: selected.message };
  const warnings = sources.slice(1).filter((other) => !other.date || other.date.coordinate !== selected.date?.coordinate || other.date.precision !== selected.date?.precision)
    .map((other) => other.date ? `Конфликт дат: ${other.source} содержит ${other.date.value}; используется ${selected.source}.` : other.message);
  return { kind: 'valid', date: selected.date, source: selected.source, warnings };
}

export function analyzeNote(markdown: string, options: MetadataOptions): NoteMetadata {
  let frontmatter: ReturnType<typeof extractFrontmatter>;
  try {
    frontmatter = extractFrontmatter(markdown);
  } catch (error) {
    return { date: { kind: 'invalid', message: error instanceof Error ? error.message : 'Поврежден YAML frontmatter.' },
      tags: [], body: markdown.replace(/^\uFEFF/, ''), missingTags: true, warnings: [] };
  }
  const start = frontmatter?.end ?? (markdown.startsWith('\uFEFF') ? 1 : 0);
  const header = parseHeader(markdown, start);
  const yamlTags = frontmatterTags(options.frontmatter);
  const warnings: string[] = [];
  if (!yamlTags.valid) warnings.push('Свойство tags содержит неподдерживаемые значения; исправьте его в исходной заметке.');
  if (header.tagLines.length > 1) warnings.push('В начальном блоке несколько строк 📍 Tags:; добавление тегов заблокировано.');
  const markerValues = header.tagLines.map(markerTags);
  if (markerValues.some((marker) => !marker.valid)) warnings.push('Строка 📍 Tags: содержит неподдерживаемые значения; используйте #тег.');
  const values = [...yamlTags.tags, ...(options.inlineTags ?? inlineTags(markdown.slice(start))), ...markerValues.flatMap((marker) => marker.tags)];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = normalizeTag(value);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  const safeHeader = header.dates.length <= 1 && header.tagLines.length <= 1;
  return { date: resolveDate(header, options), tags,
    body: markdown.slice(safeHeader ? header.bodyStart : start), missingTags: tags.length === 0, warnings };
}

/** Invoke inside the transaction with freshly parsed frontmatter, never with offsets from a form. */
export function planTagAddition(markdown: string, options: MetadataOptions, input: string): TagAddition {
  const tag = normalizeTag(input);
  if (!tag) throw new Error('Некорректный тег: используйте буквы, цифры, дефис, подчеркивание или /; тег не может быть только числом.');
  if (options.frontmatterError) throw new Error(`Добавление тега невозможно: ошибка YAML. ${options.frontmatterError}`);
  const frontmatter = extractFrontmatter(markdown);
  const start = frontmatter?.end ?? (markdown.startsWith('\uFEFF') ? 1 : 0);
  const header = parseHeader(markdown, start);
  if (header.tagLines.length > 1) throw new Error('Добавление тега невозможно: несколько строк 📍 Tags:. Откройте исходную заметку.');
  const marker = header.tagLines[0];
  if (marker && !markerTags(marker).valid) throw new Error('Добавление тега невозможно: строка 📍 Tags: неоднозначна. Откройте исходную заметку.');
  const current = analyzeNote(markdown, { ...options, inlineTags: undefined });
  if (current.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return { kind: 'noop' };
  if (marker) {
    const insertion = marker.start + marker.text.trimEnd().length;
    return { kind: 'text', text: `${markdown.slice(0, insertion)} #${tag}${markdown.slice(insertion)}` };
  }
  const yamlTags = frontmatterTags(options.frontmatter);
  if (frontmatter && yamlTags.exists) {
    if (!yamlTags.valid) throw new Error('Добавление тега невозможно: свойство tags содержит неподдерживаемые значения. Откройте исходную заметку.');
    return { kind: 'frontmatter', tag };
  }
  if (header.dates.length > 1) throw new Error('Добавление тега невозможно: несколько строк 📅 делают начальный блок неоднозначным.');
  const ending = /\r\n|\n|\r/.exec(markdown)?.[0] ?? '\n';
  const date = header.dates[0];
  const insertion = date?.end ?? header.insertStart;
  const needsLeadingEnding = date !== undefined && date.ending === '';
  const text = `${needsLeadingEnding ? ending : ''}📍 Tags: #${tag}${insertion < markdown.length || !needsLeadingEnding ? ending : ''}`;
  return { kind: 'text', text: `${markdown.slice(0, insertion)}${text}${markdown.slice(insertion)}` };
}
