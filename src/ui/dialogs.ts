import { App, Modal, Setting, SuggestModal, TFile } from 'obsidian';

export class NotePicker extends SuggestModal<TFile> {
  private files: TFile[];
  private selectFile: (file: TFile) => Promise<void>;

  constructor(app: App, selectFile: (file: TFile) => Promise<void>) {
    super(app);
    this.files = app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
    this.selectFile = selectFile;
    this.setPlaceholder('Название или путь заметки из любой папки…');
    this.setInstructions([{ command: '↑ ↓', purpose: 'Выбрать' }, { command: '↵', purpose: 'Добавить' }, { command: 'esc', purpose: 'Закрыть' }]);
  }

  getSuggestions(query: string): TFile[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.files.filter(file => terms.every(term => file.path.toLowerCase().includes(term))).slice(0, 100);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createDiv({ text: file.basename });
    el.createDiv({ text: file.path, cls: 'noteline-picker-path' });
    const cache = this.app.metadataCache.getFileCache(file);
    const date = cache?.frontmatter?.['timeline-date'] ?? cache?.frontmatter?.['date'];
    el.createDiv({ text: typeof date === 'string' ? date : 'Дата будет проверена при добавлении', cls: 'noteline-picker-path' });
  }

  onChooseSuggestion(file: TFile): void { void this.selectFile(file); }
}

export class ValueModal extends Modal {
  private titleText: string;
  private description: string;
  private initial: string;
  private action: (value: string) => Promise<void>;
  private suggestions: string[];

  constructor(app: App, title: string, description: string, initial: string, action: (value: string) => Promise<void>, suggestions: string[] = []) {
    super(app);
    this.titleText = title;
    this.description = description;
    this.initial = initial;
    this.action = action;
    this.suggestions = suggestions;
  }

  onOpen(): void {
    this.contentEl.addClass('noteline-modal');
    this.setTitle(this.titleText);
    this.contentEl.createEl('p', { text: this.description });
    let value = this.initial;
    let input: HTMLInputElement;
    const field = new Setting(this.contentEl).setName('Значение').addText(text => {
      text.setValue(value).onChange(next => { value = next; });
      input = text.inputEl;
      text.inputEl.setAttribute('aria-label', this.titleText);
    });
    const errorEl = this.contentEl.createDiv({ cls: 'noteline-error', attr: { role: 'alert' } });
    const submit = async (): Promise<void> => {
      if (!value.trim()) { errorEl.setText('Введите значение.'); return; }
      try { await this.action(value.trim()); this.close(); }
      catch (error) { errorEl.setText(error instanceof Error ? error.message : String(error)); }
    };
    if (this.suggestions.length) {
      const choices = this.contentEl.createDiv({ cls: 'noteline-tag-suggestions' });
      for (const tag of this.suggestions.slice(0, 60)) choices.createEl('button', { text: `#${tag}`, attr: { type: 'button' } }).addEventListener('click', () => {
        value = tag;
        input.value = tag;
      });
    }
    new Setting(this.contentEl).addButton(button => button.setButtonText('Отмена').onClick(() => this.close())).addButton(button => button.setButtonText('Применить').setCta().onClick(() => { void submit(); }));
    field.controlEl.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } });
  }

  onClose(): void { this.contentEl.empty(); }
}

export class TimelinePicker extends SuggestModal<TFile> {
  private files: TFile[];
  private selectFile: (file: TFile) => Promise<void>;
  constructor(app: App, files: TFile[], selectFile: (file: TFile) => Promise<void>) {
    super(app);
    this.files = files;
    this.selectFile = selectFile;
    this.setPlaceholder('Название или путь временной оси…');
  }
  getSuggestions(query: string): TFile[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.files.filter(file => terms.every(term => file.path.toLowerCase().includes(term)));
  }
  renderSuggestion(file: TFile, el: HTMLElement): void { el.createDiv({ text: file.basename }); el.createDiv({ text: file.path, cls: 'noteline-picker-path' }); }
  onChooseSuggestion(file: TFile): void { void this.selectFile(file); }
}

export class ConfirmationModal extends Modal {
  private heading: string;
  private description: string;
  private action: () => Promise<void>;
  constructor(app: App, heading: string, description: string, action: () => Promise<void>) { super(app); this.heading = heading; this.description = description; this.action = action; }
  onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl('p', { text: this.description });
    const errorEl = this.contentEl.createDiv({ cls: 'noteline-error', attr: { role: 'alert' } });
    new Setting(this.contentEl).addButton(button => button.setButtonText('Отмена').onClick(() => this.close())).addButton(button => button.setButtonText('Подтвердить').setCta().onClick(async () => {
      try { await this.action(); this.close(); }
      catch (error) { errorEl.setText(error instanceof Error ? error.message : String(error)); }
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}
