import { TFolder, type App, type TFile } from 'obsidian';
import { createDefaultState, validateState, type PluginState } from '../domain/state.ts';

export class TimelineConflictError extends Error {
  constructor(path: string) {
    super(`Временная ось «${path}» изменена извне. Исходный файл не перезаписан; перечитайте его перед продолжением.`);
    this.name = 'TimelineConflictError';
  }
}

function documentState(raw: unknown): PluginState {
  // validateState(null) is the legacy settings initializer, not a valid file document.
  if (raw == null) throw new Error('Файл временной оси должен содержать объект состояния Noteline. Исходные данные не изменены.');
  return validateState(raw);
}

/** Validate before serialization, retaining fields understood by newer compatible versions. */
export function serializeTimeline(state: PluginState): string {
  const validated = documentState(state);
  try {
    return `${JSON.stringify(validated, null, 2)}\n`;
  } catch (error) {
    throw new Error(`Не удалось сериализовать временную ось: ${error instanceof Error ? error.message : String(error)}. Исходные данные не изменены.`);
  }
}

export function parseTimeline(text: string): PluginState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Не удалось прочитать JSON временной оси: ${error instanceof Error ? error.message : String(error)}. Исходные данные не изменены.`);
  }
  return documentState(raw);
}

function checkPath(path: string): void {
  const segments = path.split('/');
  if (!path.endsWith('.timeline') || path.startsWith('/') || path.includes('\\') ||
    /[<>:"|?*]/.test(path) || [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    segments.some(segment => !segment || segment === '.' || segment === '..' || segment.trim() !== segment || segment.endsWith('.')) ||
    segments[segments.length - 1] === '.timeline') {
    throw new Error('Укажите относительный путь внутри хранилища с именем файла и расширением .timeline; абсолютные пути и переходы между каталогами запрещены.');
  }
}

/** Vault-only file access works on desktop and mobile without Node.js filesystem APIs. */
export class TimelineFileRepository {
  private app: App;

  constructor(app: App) { this.app = app; }

  list(): TFile[] {
    return this.app.vault.getFiles()
      .filter(file => file.extension === 'timeline')
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }

  async create(path: string, state: PluginState = createDefaultState()): Promise<TFile> {
    checkPath(path);
    const text = serializeTimeline(state);
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`Файл или папка «${path}» уже существует. Выберите другое имя.`);
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index++) {
      const parent = segments.slice(0, index).join('/');
      const existing = this.app.vault.getAbstractFileByPath(parent);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`Невозможно создать папку «${parent}»: этот путь занят файлом.`);
      try {
        await this.app.vault.createFolder(parent);
      } catch (error) {
        // Another creator may have won the race. Only a verified folder makes it safe to continue.
        if (!(this.app.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw error;
      }
    }
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`Файл или папка «${path}» уже существует. Выберите другое имя.`);
    // Vault.create rejects an existing path, including a race after the check above.
    return this.app.vault.create(path, text);
  }

  async load(file: TFile): Promise<{ state: PluginState; text: string }> {
    checkPath(file.path);
    const text = await this.app.vault.read(file);
    return { state: parseTimeline(text), text };
  }

  async save(file: TFile, state: PluginState, expectedText: string): Promise<string> {
    checkPath(file.path);
    const next = serializeTimeline(state);
    parseTimeline(expectedText);
    await this.app.vault.process(file, current => {
      if (current !== expectedText && current !== next) throw new TimelineConflictError(file.path);
      parseTimeline(current);
      return next;
    });
    return next;
  }

  async remove(file: TFile): Promise<void> {
    checkPath(file.path);
    await this.app.fileManager.trashFile(file);
  }
}
