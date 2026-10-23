import { Notice, TFile, TFolder, type App } from 'obsidian';
import { calendarDateToday, normalizeTag, parseCalendarDate, type CalendarDate, type NoteMetadata } from '../domain/metadata.ts';
import type { TimelineEntry } from '../domain/state.ts';
import { StateStore } from './persistence.ts';
import { addTag, parseNote } from './notes.ts';
import { NotePicker, ValueModal } from '../ui/dialogs.ts';

export interface NoteRecord {
  entryId: string;
  path: string;
  title: string;
  metadata?: NoteMetadata;
  effectiveDate?: CalendarDate;
  missingDate: boolean;
  pending: boolean;
  error?: string;
}

/** One isolated controller per .timeline file; views of the same file share this session. */
export class TimelineSession {
  app: App;
  store: StateStore;
  records = new Map<string, NoteRecord>();
  requestedFocus: string | null = null;
  externalRevision = 0;
  private listeners = new Set<() => void>();
  private generations = new Map<string, number>();
  private queue = new Set<string>();
  private activeReads = 0;
  private stopped = false;
  private openAction: () => Promise<void>;

  constructor(app: App, store: StateStore, openAction: () => Promise<void>) {
    this.app = app;
    this.store = store;
    this.openAction = openAction;
  }

  notify(): void { this.emit(); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void { if (!this.stopped) for (const listener of this.listeners) listener(); }

  refreshAll(): void {
    const ids = new Set(this.store.state.timeline.entries.map(entry => entry.entryId));
    for (const id of this.records.keys()) if (!ids.has(id)) this.records.delete(id);
    for (const entry of this.store.state.timeline.entries) this.refresh(entry.entryId);
    this.emit();
  }

  refreshPath(path: string): void {
    for (const entry of this.store.state.timeline.entries) if (entry.filePath === path) this.refresh(entry.entryId);
  }

  refresh(id: string): void {
    if (this.stopped) return;
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.queue.add(id);
    this.drain();
  }

  private drain(): void {
    while (!this.stopped && this.activeReads < 4 && this.queue.size) {
      const id = this.queue.values().next().value as string;
      this.queue.delete(id);
      this.activeReads++;
      void this.readEntry(id).finally(() => { this.activeReads--; this.drain(); });
    }
  }

  private async readEntry(id: string): Promise<void> {
    const entry = this.entry(id);
    if (!entry) return;
    const path = entry.filePath;
    const generation = this.generations.get(id);
    const file = this.app.vault.getAbstractFileByPath(path);
    const record: NoteRecord = { entryId: id, path, title: file instanceof TFile ? file.basename : path, missingDate: false, pending: false };
    try {
      if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('Файл не найден. Откройте его или выберите новый путь.');
      const markdown = await this.app.vault.cachedRead(file);
      if (this.stopped || this.generations.get(id) !== generation || this.entry(id)?.filePath !== path) return;
      const cache = this.app.metadataCache.getFileCache(file);
      const metadata = parseNote(markdown, this.store.state.settings.dateProperties, cache ? (cache.tags ?? []).map(item => item.tag) : undefined);
      record.metadata = metadata;
      if (metadata.date.kind === 'invalid') record.error = metadata.date.message;
      else if (metadata.date.kind === 'valid') {
        record.effectiveDate = metadata.date.date;
        if (entry.fallbackDate && this.store.writable) this.store.change(() => { delete entry.fallbackDate; });
      } else {
        record.missingDate = true;
        if (!entry.fallbackDate) {
          if (!this.store.writable) throw new Error('Нет даты и невозможно сохранить дату подстановки: состояние доступно только для чтения.');
          this.store.change(() => { entry.fallbackDate = calendarDateToday(new Date()); });
        }
        record.effectiveDate = parseCalendarDate(entry.fallbackDate ?? '') ?? undefined;
      }
    } catch (error) { record.error = error instanceof Error ? error.message : String(error); }
    if (this.stopped || this.generations.get(id) !== generation || this.entry(id)?.filePath !== path) return;
    this.records.set(id, record);
    this.emit();
  }

  entry(id: string): TimelineEntry | undefined { return this.store.state.timeline.entries.find(entry => entry.entryId === id); }

  async openTimeline(): Promise<void> { await this.openAction(); }

  chooseNote(): void { new NotePicker(this.app, file => this.addNote(file)).open(); }

  async addNote(file: TFile): Promise<void> {
    try {
      if (!this.store.writable) throw new Error(this.store.error || 'Ось доступна только для чтения.');
      let entry = this.store.state.timeline.entries.find(item => item.filePath === file.path);
      if (!entry) {
        const metadata = parseNote(await this.app.vault.cachedRead(file), this.store.state.settings.dateProperties);
        if (this.stopped) return;
        if (metadata.date.kind === 'invalid') throw new Error(metadata.date.message);
        entry = this.store.state.timeline.entries.find(item => item.filePath === file.path);
        if (!entry) {
          const bytes = new Uint8Array(16);
          globalThis.crypto.getRandomValues(bytes);
          entry = { entryId: Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''), filePath: file.path, preferredLane: 0, expanded: false };
          if (metadata.date.kind === 'missing') entry.fallbackDate = calendarDateToday(new Date());
          const added = entry;
          this.store.change(state => { state.timeline.entries.push(added); });
        }
      }
      this.requestedFocus = entry.entryId;
      this.refresh(entry.entryId);
      await this.openTimeline();
    } catch (error) { this.report(error); }
  }

  remove(id: string): void {
    try {
      this.store.change(state => { state.timeline.entries = state.timeline.entries.filter(entry => entry.entryId !== id); });
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
      this.records.delete(id);
      this.emit();
    } catch (error) { this.report(error); }
  }

  updateEntry(id: string, update: (entry: TimelineEntry) => void): void {
    try { const entry = this.entry(id); if (entry) this.store.change(() => update(entry)); }
    catch (error) { this.report(error); }
  }

  async openNote(path: string): Promise<void> {
    try { await this.app.workspace.openLinkText(path, '', 'tab'); }
    catch (error) { this.report(error); }
  }

  relink(id: string): void {
    new NotePicker(this.app, async file => {
      const existing = this.store.state.timeline.entries.find(entry => entry.filePath === file.path && entry.entryId !== id);
      if (existing) { new Notice('Эта заметка уже есть на оси.'); return; }
      this.updateEntry(id, entry => { entry.filePath = file.path; delete entry.fallbackDate; });
      this.refresh(id);
    }).open();
  }

  tagDialog(id: string): void {
    const entry = this.entry(id);
    if (!entry) return;
    const intendedPath = entry.filePath;
    const tags = [...new Set([...this.records.values()].flatMap(record => record.metadata?.tags ?? []))].sort();
    new ValueModal(this.app, 'Добавить тег', 'Тег будет записан в исходную заметку: строку 📍 Tags: или свойство tags. Существующие теги сохраняются.', '', async value => {
      const tag = normalizeTag(value);
      if (!tag) throw new Error('Введите один допустимый тег без пробелов, например идеи/аудио.');
      const current = this.entry(id);
      if (!current || current.filePath !== intendedPath || this.stopped) throw new Error('Карточка удалена или связана с другим файлом. Откройте форму заново.');
      if (!this.store.writable) throw new Error(this.store.error || 'Состояние доступно только для чтения.');
      const file = this.app.vault.getAbstractFileByPath(current.filePath);
      if (!(file instanceof TFile)) throw new Error('Заметка не найдена.');
      await addTag(this.app, file, this.store.state.settings.dateProperties, tag);
      this.refresh(id);
    }, tags).open();
  }

  rename(file: TFile | TFolder, oldPath: string, newPath = file.path): void {
    if (!this.store.writable) return;
    const affected = this.store.state.timeline.entries.filter(entry => entry.filePath === oldPath || (file instanceof TFolder && entry.filePath.startsWith(`${oldPath}/`)));
    if (!affected.length) return;
    this.store.change(() => {
      for (const entry of affected) entry.filePath = newPath + entry.filePath.slice(oldPath.length);
    });
    for (const entry of affected) this.refresh(entry.entryId);
  }

  report(error: unknown): void { new Notice(error instanceof Error ? error.message : String(error)); }

  dispose(): void {
    this.stopped = true;
    this.queue.clear();
    this.store.dispose();
    this.listeners.clear();
    this.records.clear();
  }
}
