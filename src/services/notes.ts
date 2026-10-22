import { App, MarkdownView, TFile, parseYaml } from 'obsidian';
import { analyzeNote, extractFrontmatter, normalizeTag, planTagAddition, type MetadataOptions, type NoteMetadata } from '../domain/metadata.ts';

export function metadataOptions(markdown: string, dateProperties: readonly string[]): MetadataOptions {
  try {
    const block = extractFrontmatter(markdown);
    if (!block) return { dateProperties };
    const parsed: unknown = parseYaml(block.text);
    if (parsed == null) return { dateProperties, frontmatter: {} };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('YAML должен содержать свойства заметки.');
    return { dateProperties, frontmatter: parsed as Record<string, unknown> };
  } catch (error) {
    return { dateProperties, frontmatterError: error instanceof Error ? error.message : String(error) };
  }
}

export function parseNote(markdown: string, dateProperties: readonly string[], inlineTags?: readonly string[]): NoteMetadata {
  return analyzeNote(markdown, { ...metadataOptions(markdown, dateProperties), inlineTags });
}

function openEditor(app: App, file: TFile): MarkdownView | undefined {
  let found: MarkdownView | undefined;
  app.workspace.iterateAllLeaves(leaf => {
    if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path && leaf.view.getMode() === 'source') found = leaf.view;
  });
  return found;
}

/** Replaces only the changed span, retaining the editor's undo and selection handling. */
export function replaceChangedSpan(view: MarkdownView, before: string, after: string): void {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  view.editor.replaceRange(after.slice(start, newEnd), view.editor.offsetToPos(start), view.editor.offsetToPos(oldEnd));
}

export async function addTag(app: App, file: TFile, dateProperties: readonly string[], tag: string): Promise<void> {
  const view = openEditor(app, file);
  if (view) {
    const current = view.editor.getValue();
    const plan = planTagAddition(current, metadataOptions(current, dateProperties), tag);
    if (plan.kind === 'noop') return;
    if (plan.kind === 'frontmatter') throw new Error('Свойство tags открытой заметки измените через Properties или закройте редактор заметки и повторите добавление. Это защищает текущий буфер от перезаписи.');
    replaceChangedSpan(view, current, plan.text);
    return;
  }

  const current = await app.vault.read(file);
  const plan = planTagAddition(current, metadataOptions(current, dateProperties), tag);
  if (plan.kind === 'noop') return;
  if (plan.kind === 'frontmatter') {
    if (openEditor(app, file)) throw new Error('Заметка открыта в редакторе. Измените tags через Properties или закройте редактор.');
    await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      if (openEditor(app, file)) throw new Error('Заметка открылась в редакторе. Повторите добавление тега после закрытия редактора.');
      const value = frontmatter.tags;
      const tags = value == null || value === '' ? [] : typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
      if (!Array.isArray(tags) || !tags.every(item => typeof item === 'string' && normalizeTag(item))) throw new Error('Свойство tags изменилось: требуется список допустимых тегов.');
      if (!tags.some(value => value.replace(/^#/, '').toLowerCase() === plan.tag.toLowerCase())) tags.push(plan.tag);
      frontmatter.tags = tags;
    });
  } else {
    await app.vault.process(file, actual => {
      if (openEditor(app, file)) throw new Error('Заметка открылась в редакторе. Повторите добавление тега.');
      const fresh = planTagAddition(actual, metadataOptions(actual, dateProperties), tag);
      if (fresh.kind === 'noop') return actual;
      if (fresh.kind !== 'text') throw new Error('Место записи тега изменилось. Повторите добавление.');
      return fresh.text;
    });
  }
}
