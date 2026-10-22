import { Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, type App } from 'obsidian';
import { calendarDateToday, normalizeTag, parseCalendarDate, type CalendarDate, type NoteMetadata } from './domain/metadata.ts';
import type { TimelineEntry } from './domain/state.ts';
import { StateStore } from './services/persistence.ts';
import { addTag, parseNote } from './services/notes.ts';
import { NotePicker, ValueModal } from './ui/dialogs.ts';
import { TimelineView, VIEW_TYPE } from './ui/timeline-view.ts';

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

export default class NotelinePlugin extends Plugin {
  store!: StateStore;
  records = new Map<string, NoteRecord>();
  requestedFocus: string | null = null;
  externalRevision = 0;
  private listeners = new Set<() => void>();
  private generations = new Map<string, number>();
  private queue = new Set<string>();
  private activeReads = 0;
  private stopped = false;

  async onload(): Promise<void> {
    this.store = new StateStore(state => this.saveData(state), () => this.emit());
    try { this.store.load(await this.loadData()); }
    catch (error) {
      this.store.load({ schemaVersion: -1 });
      this.store.error = `Не удалось прочитать состояние: ${error instanceof Error ? error.message : String(error)}. Файл не изменен.`;
      new Notice(this.store.error);
    }
    this.registerView(VIEW_TYPE, leaf => new TimelineView(leaf, this));
    this.addRibbonIcon('git-commit-horizontal', 'Открыть временную ось', () => { void this.openTimeline(); });
    this.addCommand({ id: 'open-timeline', name: 'Открыть временную ось', callback: () => { void this.openTimeline(); } });
    this.addCommand({ id: 'add-active-note', name: 'Добавить активную заметку на ось', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (!checking) void this.addNote(file);
      return true;
    } });
    this.addSettingTab(new NotelineSettings(this.app, this));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') menu.addItem(item => item.setTitle('Добавить на временную ось').setIcon('git-commit-horizontal').onClick(() => this.addNote(file)));
    }));
    this.registerEvent(this.app.metadataCache.on('changed', file => this.refreshPath(file.path)));
    this.registerEvent(this.app.vault.on('modify', file => this.refreshPath(file.path)));
    this.registerEvent(this.app.vault.on('create', file => this.refreshPath(file.path)));
    this.registerEvent(this.app.vault.on('delete', file => {
      for (const entry of this.store.state.timeline.entries) if (entry.filePath === file.path || (file instanceof TFolder && entry.filePath.startsWith(`${file.path}/`))) this.refresh(entry.entryId);
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!this.store.writable) return;
      const affected = this.store.state.timeline.entries.filter(entry => entry.filePath === oldPath || (file instanceof TFolder && entry.filePath.startsWith(`${oldPath}/`)));
      if (!affected.length) return;
      this.store.change(() => {
        for (const entry of affected) entry.filePath = file.path + entry.filePath.slice(oldPath.length);
      });
      for (const entry of affected) this.refresh(entry.entryId);
    }));
    this.app.workspace.onLayoutReady(() => { if (!this.stopped) this.refreshAll(); });
  }

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

  private refreshPath(path: string): void {
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

  async openTimeline(): Promise<void> {
    try {
      let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
      if (!leaf) {
        leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
      }
      await this.app.workspace.revealLeaf(leaf);
      this.emit();
    } catch (error) { this.report(error); }
  }

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

  async onExternalSettingsChange(): Promise<void> {
    try {
      await this.store.external(await this.loadData());
      this.externalRevision++;
      this.refreshAll();
    } catch (error) { this.store.status = 'readonly'; this.store.error = `Не удалось перечитать внешние настройки: ${String(error)}`; this.emit(); }
  }

  report(error: unknown): void { new Notice(error instanceof Error ? error.message : String(error)); }

  onunload(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof TimelineView) leaf.view.flushCamera();
    this.stopped = true;
    this.queue.clear();
    this.store.dispose();
    this.listeners.clear();
    this.records.clear();
  }
}

class NotelineSettings extends PluginSettingTab {
  private plugin: NotelinePlugin;
  constructor(app: App, plugin: NotelinePlugin) { super(app, plugin); this.plugin = plugin; }
  display(): void {
    this.containerEl.empty();
    this.containerEl.addClass('noteline-settings');
    let value = this.plugin.store.state.settings.dateProperties.join(', ');
    new Setting(this.containerEl).setName('Свойства даты').setDesc('Имена через запятую в порядке приоритета. Если свойства пусты, читается начальная строка 📅.').addText(text => text.setValue(value).onChange(next => { value = next; }));
    new Setting(this.containerEl).addButton(button => button.setButtonText('Применить').setCta().onClick(() => {
      const names = value.split(',').map(name => name.trim()).filter(Boolean);
      if (new Set(names).size !== names.length) { new Notice('Имена свойств не должны повторяться.'); return; }
      try {
        this.plugin.store.change(state => { state.settings.dateProperties = names; });
        this.plugin.refreshAll();
        new Notice('Свойства даты обновлены.');
      } catch (error) { this.plugin.report(error); }
    }));
    new Setting(this.containerEl).setName('Отсутствующие метаданные').setDesc('Без даты используется сохраненная дата добавления. Без даты или тегов карточка имеет серую рамку. Исходная заметка автоматически не меняется.');
    new Setting(this.containerEl).setName('Открыть временную ось').addButton(button => button.setButtonText('Открыть').onClick(() => { void this.plugin.openTimeline(); }));
    new Setting(this.containerEl).setName('Повторить сохранение').setDesc(this.plugin.store.error || 'Настройки и раскладка сохраняются отдельно от заметок.').addButton(button => button.setButtonText('Повторить').onClick(() => { void this.plugin.store.flush(); }));
  }
}
