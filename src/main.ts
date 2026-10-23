import { Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, type App } from 'obsidian';
import { createDefaultState, validateState, type PluginState } from './domain/state.ts';
import { StateStore } from './services/persistence.ts';
import { TimelineFileRepository, parseTimeline, serializeTimeline } from './services/timeline-files.ts';
import { TimelineSession } from './services/timeline-session.ts';
import { ConfirmationModal, TimelinePicker, ValueModal } from './ui/dialogs.ts';
import { TimelineView, VIEW_TYPE } from './ui/timeline-view.ts';
export type { NoteRecord } from './services/timeline-session.ts';

interface SessionHandle {
  file: TFile;
  session: TimelineSession;
  expectedText: string;
  pendingText: string | null;
  references: number;
  reload: Promise<void>;
}

/** File-backed timelines are shared vault data. Plugin data only remembers local navigation and the legacy backup. */
export default class NotelinePlugin extends Plugin {
  repository!: TimelineFileRepository;
  private handles = new Map<TFile, SessionHandle>();
  private loading = new Map<TFile, Promise<SessionHandle>>();
  private collectionListeners = new Set<() => void>();
  private localData: Record<string, unknown> = {};
  private preferencesWritable = true;
  private preferenceWrite: Promise<void> = Promise.resolve();
  private renameQueue: Promise<void> = Promise.resolve();
  private stopped = false;

  async onload(): Promise<void> {
    this.repository = new TimelineFileRepository(this.app);
    this.registerView(VIEW_TYPE, leaf => new TimelineView(leaf, this));
    this.registerExtensions(['timeline'], VIEW_TYPE);
    try {
      const raw: unknown = await this.loadData();
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.localData = { ...raw as Record<string, unknown> };
      else if (raw != null) { this.preferencesWritable = false; new Notice('Данные старой версии повреждены. Исходный data.json не изменён.'); }
      await this.migrateLegacy();
    } catch (error) { this.preferencesWritable = false; this.report(error); }
    this.addRibbonIcon('git-commit-horizontal', 'Открыть временную ось', () => { void this.openTimeline(); });
    this.addCommand({ id: 'open-timeline', name: 'Открыть временную ось', callback: () => { void this.openTimeline(); } });
    this.addCommand({ id: 'choose-timeline', name: 'Выбрать временную ось', callback: () => this.chooseTimeline() });
    this.addCommand({ id: 'create-timeline', name: 'Создать временную ось', callback: () => this.createTimelineDialog() });
    this.addCommand({ id: 'add-active-note', name: 'Добавить активную заметку на ось', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (!checking) this.chooseTimeline(async target => {
        const session = await this.acquireSession(target);
        try { await session.addNote(file); } finally { await this.releaseSession(session); }
      });
      return true;
    } });
    this.addSettingTab(new NotelineSettings(this.app, this));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') menu.addItem(item => item.setTitle('Добавить на временную ось').setIcon('git-commit-horizontal').onClick(() => {
        this.chooseTimeline(async target => {
          const session = await this.acquireSession(target);
          try { await session.addNote(file); } finally { await this.releaseSession(session); }
        });
      }));
      if (file instanceof TFile && file.extension === 'timeline') menu.addItem(item => item.setTitle('Открыть в Noteline').setIcon('git-commit-horizontal').onClick(() => this.openTimeline(file)));
    }));
    this.registerEvent(this.app.metadataCache.on('changed', file => this.refreshPath(file.path)));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file instanceof TFile && file.extension === 'timeline') {
        const handle = this.findHandle(file);
        if (handle) this.queueReload(handle);
      } else this.refreshPath(file.path);
    }));
    this.registerEvent(this.app.vault.on('create', file => {
      if (file instanceof TFile && file.extension === 'timeline') this.collectionChanged();
      else this.refreshPath(file.path);
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      for (const handle of this.handles.values()) {
        if (handle.file === file || (file instanceof TFolder && handle.file.path.startsWith(`${file.path}/`))) {
          handle.session.store.status = 'readonly';
          handle.session.store.error = 'Файл оси удалён. Несохранённое состояние можно сохранить в новую копию.';
          handle.session.notify();
        } else handle.session.refreshAll();
      }
      this.collectionChanged();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFile) && !(file instanceof TFolder)) return;
      const newPath = file.path;
      this.renameQueue = this.renameQueue.then(() => this.renameReferences(file, oldPath, newPath)).catch(error => this.report(error));
    }));
  }

  private async migrateLegacy(): Promise<void> {
    if (this.localData.notelineFiles !== undefined || this.localData.schemaVersion === undefined) return;
    let legacy: PluginState;
    try { legacy = validateState(this.localData); }
    catch (error) { this.preferencesWritable = false; throw new Error(`Не удалось перенести старую ось. data.json сохранён: ${String(error)}`); }
    let file: TFile | undefined;
    const existing = this.app.vault.getAbstractFileByPath('Noteline.timeline');
    if (existing instanceof TFile) {
      try { if (serializeTimeline((await this.repository.load(existing)).state) === serializeTimeline(legacy)) file = existing; }
      catch (error) { this.report(new Error(`Существующий Noteline.timeline сохранён без изменений: ${String(error)}`)); }
    }
    if (!file) for (const candidate of this.repository.list().filter(item => /^Noteline \d+\.timeline$/.test(item.path))) {
      try { if (serializeTimeline((await this.repository.load(candidate)).state) === serializeTimeline(legacy)) { file = candidate; break; } }
      catch (error) { this.report(new Error(`Файл ${candidate.path} сохранён без изменений: ${String(error)}`)); }
    }
    if (!file) file = await this.repository.create(this.uniquePath('Noteline.timeline'), legacy);
    this.localData.notelineFiles = { version: 1, migratedPath: file.path, lastPath: file.path };
    // All legacy fields remain intact in data.json as a recovery copy.
    await this.savePreferences();
    new Notice(`Старая ось перенесена в ${file.path}. Исходные данные сохранены в data.json.`);
  }

  private get preferences(): Record<string, unknown> {
    const value = this.localData.notelineFiles;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { version: 1 };
  }

  private async savePreferences(): Promise<void> {
    if (!this.preferencesWritable || this.stopped) return;
    const snapshot = JSON.parse(JSON.stringify(this.localData)) as Record<string, unknown>;
    this.preferenceWrite = this.preferenceWrite.then(() => this.saveData(snapshot));
    try { await this.preferenceWrite; }
    catch (error) { this.preferencesWritable = false; throw new Error(`Файл оси сохранён, но локальные настройки не записаны: ${String(error)}`); }
  }

  private remember(file: TFile): void {
    this.localData.notelineFiles = { ...this.preferences, lastPath: file.path };
    void this.savePreferences().catch(error => this.report(error));
  }

  listTimelines(): TFile[] { return this.repository.list(); }
  uniquePath(path: string): string {
    if (!this.app.vault.getAbstractFileByPath(path)) return path;
    const stem = path.replace(/\.timeline$/, '');
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(`${stem} ${suffix}.timeline`)) suffix++;
    return `${stem} ${suffix}.timeline`;
  }

  subscribeCollection(listener: () => void): () => void { this.collectionListeners.add(listener); return () => this.collectionListeners.delete(listener); }
  private collectionChanged(): void { if (!this.stopped) for (const listener of this.collectionListeners) listener(); }

  chooseTimeline(action: (file: TFile) => Promise<void> = file => this.openTimeline(file)): void {
    if (!this.listTimelines().length) { this.createTimelineDialog(); return; }
    new TimelinePicker(this.app, this.listTimelines(), file => action(file).catch(error => this.report(error))).open();
  }

  createTimelineDialog(copy?: TimelineSession, source?: TFile): void {
    const initial = this.uniquePath(copy ? `${source?.basename ?? 'Ось'} копия.timeline` : 'Новая ось.timeline');
    new ValueModal(this.app, copy ? 'Сохранить копию оси' : 'Создать временную ось', 'Путь внутри хранилища. Расширение .timeline добавляется автоматически.', initial, async value => {
      const path = value.endsWith('.timeline') ? value : `${value}.timeline`;
      const file = await this.repository.create(path, copy ? validateState(copy.store.state) : createDefaultState());
      this.collectionChanged();
      await this.openTimeline(file);
    }).open();
  }

  async openTimeline(file?: TFile): Promise<void> {
    try {
      if (!file) {
        const last = this.preferences.lastPath;
        const remembered = typeof last === 'string' ? this.app.vault.getAbstractFileByPath(last) : null;
        file = remembered instanceof TFile && remembered.extension === 'timeline' ? remembered : this.listTimelines()[0];
      }
      if (!file) { this.createTimelineDialog(); return; }
      const target = file;
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE).find(leaf => leaf.view instanceof TimelineView && leaf.view.file?.path === target.path);
      if (existing) await this.app.workspace.revealLeaf(existing);
      else await this.app.workspace.getLeaf('tab').openFile(file);
      this.remember(file);
    } catch (error) { this.report(error); }
  }

  private findHandle(file: TFile): SessionHandle | undefined { return [...this.handles.values()].find(handle => handle.file === file || handle.file.path === file.path); }

  async acquireSession(file: TFile): Promise<TimelineSession> {
    if (this.stopped) throw new Error('Плагин выгружен.');
    let handle = this.findHandle(file);
    if (!handle) {
      let loading = this.loading.get(file);
      if (!loading) {
        loading = this.loadHandle(file);
        this.loading.set(file, loading);
      }
      try { handle = await loading; } finally { this.loading.delete(file); }
    }
    if (this.stopped) { handle.session.dispose(); this.handles.delete(handle.file); throw new Error('Плагин выгружен во время открытия оси.'); }
    handle.references++;
    return handle.session;
  }

  private async loadHandle(file: TFile): Promise<SessionHandle> {
    const handle = { file, expectedText: '', pendingText: null, references: 0, reload: Promise.resolve() } as SessionHandle;
    const store = new StateStore(async state => {
      handle.pendingText = serializeTimeline(state);
      try { handle.expectedText = await this.repository.save(file, state, handle.expectedText); }
      finally { handle.pendingText = null; }
    }, () => handle.session?.notify());
    handle.session = new TimelineSession(this.app, store, () => this.openTimeline(file));
    try {
      handle.expectedText = await this.app.vault.read(file);
      store.load(parseTimeline(handle.expectedText));
    } catch (error) {
      store.load({ schemaVersion: -1 });
      store.error = `Не удалось открыть ${file.path}. Файл не изменён: ${String(error)}`;
    }
    if (this.stopped) { handle.session.dispose(); throw new Error('Плагин выгружен во время чтения оси.'); }
    this.handles.set(file, handle);
    this.app.workspace.onLayoutReady(() => { if (!this.stopped && this.handles.get(file) === handle) handle.session.refreshAll(); });
    return handle;
  }

  async releaseSession(session: TimelineSession): Promise<void> {
    const handle = [...this.handles.values()].find(item => item.session === session);
    if (!handle) return;
    handle.references = Math.max(0, handle.references - 1);
    await session.store.flush();
    if (handle.references === 0 && session.store.status === 'saved') {
      session.dispose();
      this.handles.delete(handle.file);
    }
  }

  private queueReload(handle: SessionHandle): void {
    handle.reload = handle.reload.then(async () => {
      const text = await this.app.vault.read(handle.file);
      if (this.stopped || text === handle.expectedText || text === handle.pendingText) return;
      await handle.session.store.external(parseTimeline(text));
      if (handle.session.store.status === 'saved') handle.expectedText = text;
      handle.session.externalRevision++;
      handle.session.refreshAll();
    }).catch(error => {
      handle.session.store.status = 'readonly';
      handle.session.store.error = `Внешний файл не прочитан; исходные данные не перезаписаны: ${String(error)}`;
      handle.session.notify();
    });
  }

  confirmReload(file: TFile, session: TimelineSession): void {
    new ConfirmationModal(this.app, 'Перечитать ось из файла?', 'Несохранённое расположение будет заменено содержимым файла. Перед этим можно сохранить копию оси.', async () => {
      const handle = this.findHandle(file);
      if (!handle) throw new Error('Ось уже закрыта.');
      await handle.reload;
      await session.store.flush();
      const loaded = await this.repository.load(file);
      handle.expectedText = loaded.text;
      session.store.load(loaded.state);
      session.externalRevision++;
      session.refreshAll();
    }).open();
  }

  confirmDelete(file: TFile): void {
    new ConfirmationModal(this.app, 'Удалить временную ось?', `${file.path} будет перемещён в корзину Obsidian или системы. Исходные заметки останутся на месте.`, async () => {
      const handle = this.findHandle(file);
      if (handle) {
        await handle.session.store.flush();
        if (handle.session.store.hasUnsavedChanges) throw new Error('Сначала сохраните копию несохранённой оси или разрешите конфликт.');
      }
      await this.app.fileManager.trashFile(file);
      this.collectionChanged();
    }).open();
  }

  private refreshPath(path: string): void { for (const handle of this.handles.values()) handle.session.refreshPath(path); }

  private async renameReferences(file: TFile | TFolder, oldPath: string, newPath = file.path): Promise<void> {
    if (this.stopped) return;
    for (const handle of this.handles.values()) handle.session.rename(file, oldPath, newPath);
    // Closed timelines also retain links when a note/folder is renamed while the plugin runs.
    for (const timeline of this.listTimelines()) {
      if (this.findHandle(timeline)) continue;
      try {
      const loaded = await this.repository.load(timeline);
      if (this.stopped) return;
      let changed = false;
      for (const entry of loaded.state.timeline.entries) {
        if (entry.filePath === oldPath || (file instanceof TFolder && entry.filePath.startsWith(`${oldPath}/`))) {
          entry.filePath = newPath + entry.filePath.slice(oldPath.length);
          changed = true;
        }
      }
      if (changed) await this.repository.save(timeline, loaded.state, loaded.text);
      } catch (error) { this.report(new Error(`Не удалось обновить ссылки в ${timeline.path}: ${String(error)}`)); }
    }
    const last = this.preferences.lastPath;
    if (typeof last === 'string' && (last === oldPath || (file instanceof TFolder && last.startsWith(`${oldPath}/`)))) {
      this.localData.notelineFiles = { ...this.preferences, lastPath: newPath + last.slice(oldPath.length) };
      await this.savePreferences();
    }
    this.collectionChanged();
  }

  report(error: unknown): void { new Notice(error instanceof Error ? error.message : String(error)); }
  onunload(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof TimelineView) leaf.view.flushCamera();
    this.stopped = true;
    for (const handle of this.handles.values()) handle.session.dispose();
    this.handles.clear();
    this.collectionListeners.clear();
  }
}

class NotelineSettings extends PluginSettingTab {
  private plugin: NotelinePlugin;
  constructor(app: App, plugin: NotelinePlugin) { super(app, plugin); this.plugin = plugin; }
  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName('Временные оси').setDesc('Каждая ось — отдельный .timeline-файл в хранилище. Настройки дат, ориентация, направление и раскладка сохраняются внутри него.').addButton(button => button.setButtonText('Открыть').onClick(() => this.plugin.chooseTimeline())).addButton(button => button.setButtonText('Создать').onClick(() => this.plugin.createTimelineDialog()));
    new Setting(this.containerEl).setName('Синхронизация').setDesc('Синхронизируйте .timeline вместе с заметками. В Obsidian Sync включите синхронизацию остальных типов файлов на каждом устройстве. Одновременные изменения автоматически не объединяются.');
    new Setting(this.containerEl).setName('Отсутствующие метаданные').setDesc('Без даты сохраняется дата добавления. Отсутствующие дата или теги обозначаются серой рамкой; исходная заметка автоматически не меняется.');
  }
}
