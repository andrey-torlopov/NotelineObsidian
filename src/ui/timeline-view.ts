import { Component, ItemView, MarkdownRenderer, Menu, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
import type NotelinePlugin from '../main.ts';
import type { NoteRecord } from '../main.ts';
import type { TimelineEntry } from '../domain/state.ts';
import { calendarDateToday, parseCalendarDate } from '../domain/metadata.ts';
import { MIN_SPAN, clampRange, dateToX, fitRange, generateTicks, layoutCards, maxSpanForCoordinates, panRange, zoomRange, type LayoutItem, type TimeRange } from '../domain/timeline.ts';
import { ValueModal } from './dialogs.ts';

export const VIEW_TYPE = 'noteline-timeline';
const STATUS = { saved: 'Сохранено', saving: 'Сохранение…', error: 'Ошибка сохранения — нажмите для повтора', conflict: 'Конфликт настроек', readonly: 'Только чтение' };

function button(parent: HTMLElement, label: string, icon: string, action: () => void): HTMLButtonElement {
  const element = parent.createEl('button', { cls: 'noteline-icon-button', attr: { type: 'button', 'aria-label': label, title: label } });
  setIcon(element, icon);
  element.addEventListener('click', action);
  return element;
}

function currentMonth(): TimeRange {
  const today = parseCalendarDate(calendarDateToday(new Date()));
  const start = new Date(today?.coordinate ?? 0);
  start.setUTCDate(1);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return clampRange({ start: start.getTime(), end: end.getTime() });
}

export class TimelineView extends ItemView {
  plugin: NotelinePlugin;
  private scroll!: HTMLElement;
  private scene!: HTMLElement;
  private axis!: HTMLElement;
  private lines!: SVGSVGElement;
  private problems!: HTMLElement;
  private status!: HTMLButtonElement;
  private zoomOut!: HTMLButtonElement;
  private zoomIn!: HTMLButtonElement;
  private range: TimeRange;
  private cards = new Map<string, NoteCard>();
  private heights = new Map<string, number>();
  private items: LayoutItem[] = [];
  private observer?: ResizeObserver;
  private frame = 0;
  private saveTimer?: number;
  private closed = true;
  private initializedScroll = false;
  private seenExternal = 0;
  private drag?: { id: string; lane: number };
  private lastProblemKey = '';
  private scrollToBottom = false;
  private revealId?: string;
  private revealAfterMeasure?: string;
  private previousHeight = 0;

  constructor(leaf: WorkspaceLeaf, plugin: NotelinePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.range = plugin.store.state.timeline.viewport ?? currentMonth();
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Временная ось'; }
  getIcon(): string { return 'git-commit-horizontal'; }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.addClass('noteline');
    const toolbar = this.contentEl.createDiv({ cls: 'noteline-toolbar', attr: { role: 'toolbar', 'aria-label': 'Временная ось' } });
    const brand = toolbar.createDiv({ cls: 'noteline-brand' });
    brand.createSpan({ text: 'Noteline' });
    brand.createSpan({ text: 'Заметки во времени', cls: 'noteline-subtitle' });
    const add = toolbar.createEl('button', { cls: 'mod-cta noteline-add', text: 'Добавить заметку', attr: { type: 'button' } });
    add.addEventListener('click', () => this.plugin.chooseNote());
    this.zoomOut = button(toolbar, 'Уменьшить масштаб', 'minus', () => this.zoom(1 / 1.5));
    this.zoomIn = button(toolbar, 'Увеличить масштаб', 'plus', () => this.zoom(1.5));
    button(toolbar, 'Сдвинуть в прошлое', 'chevron-left', () => this.pan(-0.4));
    button(toolbar, 'Сдвинуть в будущее', 'chevron-right', () => this.pan(0.4));
    button(toolbar, 'Показать все', 'scan', () => this.fit());
    button(toolbar, 'Сегодня', 'calendar-check', () => this.goToday());
    button(toolbar, 'К дате', 'calendar-search', () => this.dateDialog());
    button(toolbar, 'Параметры даты', 'settings-2', () => this.propertyDialog());
    this.status = toolbar.createEl('button', { cls: 'noteline-save-state', attr: { type: 'button' } });
    this.status.addEventListener('click', () => { if (this.plugin.store.status === 'error') void this.plugin.store.flush(); else if (this.plugin.store.error) new Notice(this.plugin.store.error); });
    this.problems = this.contentEl.createDiv({ cls: 'noteline-problems' });
    this.scroll = this.contentEl.createDiv({ cls: 'noteline-scroll', attr: { tabindex: '0', 'aria-label': 'Поле карточек. Прокрутка по вертикали; кнопки панели меняют временной диапазон.' } });
    this.scene = this.scroll.createDiv({ cls: 'noteline-scene' });
    this.lines = this.contentEl.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.lines.classList.add('noteline-connectors');
    this.lines.setAttribute('aria-hidden', 'true');
    this.scene.appendChild(this.lines);
    this.axis = this.contentEl.createDiv({ cls: 'noteline-axis', attr: { 'aria-label': 'Шкала времени' } });
    this.register(this.plugin.subscribe(() => this.schedule()));
    this.registerDomEvent(this.scroll, 'scroll', () => { this.schedule(); this.saveCameraLater(); });
    this.registerDomEvent(this.scroll, 'wheel', event => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const bounds = this.scroll.getBoundingClientRect();
        if (bounds.width > 0) this.zoom(Math.exp(Math.max(-4, Math.min(4, -event.deltaY * 0.002))), (event.clientX - bounds.left) / bounds.width);
      } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        const pixels = event.deltaX || event.deltaY;
        this.setRange(panRange(this.range, pixels / Math.max(1, this.scroll.clientWidth) * (this.range.end - this.range.start)));
      }
    }, { passive: false });
    const Observer = (this.contentEl.win as Window & typeof globalThis).ResizeObserver;
    this.observer = new Observer(() => this.schedule());
    this.observer.observe(this.scroll);
    this.seenExternal = this.plugin.externalRevision;
    this.schedule();
  }

  private get width(): number { return this.scroll?.clientWidth ?? 0; }
  private get cardWidth(): number { return Math.max(180, Math.min(300, this.width - 32)); }
  private coordinates(): number[] { return [...this.plugin.records.values()].flatMap(record => record.effectiveDate ? [record.effectiveDate.coordinate] : []); }
  private maximumSpan(): number {
    const coordinates = this.coordinates();
    const fitted = fitRange(coordinates, this.width, this.cardWidth);
    return Math.max(maxSpanForCoordinates(coordinates, parseCalendarDate(calendarDateToday(new Date()))?.coordinate ?? 0), fitted.end - fitted.start);
  }

  schedule(): void {
    if (this.closed || this.frame) return;
    this.frame = this.contentEl.win.requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  private setRange(range: TimeRange): void { this.range = range; this.schedule(); this.saveCameraLater(); }
  private zoom(factor: number, anchor = 0.5): void { this.setRange(zoomRange(this.range, factor, anchor, this.maximumSpan())); }
  private pan(fraction: number): void { this.setRange(panRange(this.range, fraction * (this.range.end - this.range.start))); }

  private fit(): void {
    const coordinates = this.coordinates();
    this.setRange(coordinates.length ? fitRange(coordinates, this.width, this.cardWidth) : currentMonth());
    this.scrollToBottom = true;
  }

  private goToday(): void {
    const coordinate = parseCalendarDate(calendarDateToday(new Date()))?.coordinate;
    if (coordinate !== undefined) this.center(coordinate);
  }

  private center(coordinate: number): void {
    const half = (this.range.end - this.range.start) / 2;
    this.setRange(clampRange({ start: coordinate - half, end: coordinate + half }));
  }

  private dateDialog(): void {
    new ValueModal(this.app, 'Перейти к дате', 'Формат YYYY-MM-DD или YYYY-MM-DD HH:mm. Масштаб сохраняется.', calendarDateToday(new Date()), async value => {
      const date = parseCalendarDate(value);
      if (!date) throw new Error('Некорректная дата. Используйте YYYY-MM-DD или YYYY-MM-DD HH:mm.');
      this.center(date.coordinate);
    }).open();
  }

  private propertyDialog(): void {
    new ValueModal(this.app, 'Свойства даты', 'Имена через запятую в порядке приоритета. Затем проверяется начальная строка 📅.', this.plugin.store.state.settings.dateProperties.join(', '), async value => {
      const properties = value.split(',').map(name => name.trim()).filter(Boolean);
      if (new Set(properties).size !== properties.length) throw new Error('Имена свойств повторяются.');
      this.plugin.store.change(state => { state.settings.dateProperties = properties; });
      this.plugin.refreshAll();
    }).open();
  }

  private saveCameraLater(): void {
    if (this.closed || !this.plugin.store.writable) return;
    if (this.saveTimer !== undefined) this.contentEl.win.clearTimeout(this.saveTimer);
    this.saveTimer = this.contentEl.win.setTimeout(() => { this.saveTimer = undefined; this.saveCamera(); }, 350);
  }

  private saveCamera(): void {
    if (!this.plugin.store.writable) return;
    const viewport = { start: this.range.start, end: this.range.end, scrollTop: this.scroll.scrollTop };
    try { this.plugin.store.change(state => { state.timeline.viewport = viewport; }); }
    catch (error) { this.plugin.report(error); }
  }

  private render(): void {
    if (this.closed || this.width <= 0) return;
    if (this.seenExternal !== this.plugin.externalRevision) {
      this.seenExternal = this.plugin.externalRevision;
      this.range = this.plugin.store.state.timeline.viewport ?? currentMonth();
      this.initializedScroll = false;
    }
    const store = this.plugin.store;
    this.status.setText(STATUS[store.status]);
    this.status.setAttribute('title', store.error || STATUS[store.status]);
    this.status.toggleClass('noteline-error', store.status === 'error' || store.status === 'readonly' || store.status === 'conflict');
    const records = [...this.plugin.records.values()];
    const valid = records.filter(record => record.effectiveDate && !record.error);
    this.renderProblems(records);
    const inputs = valid.flatMap(record => {
      const entry = this.plugin.entry(record.entryId);
      if (!entry || !record.effectiveDate) return [];
      return [{ id: entry.entryId, coordinate: record.effectiveDate.coordinate, preferredLane: this.drag?.id === entry.entryId ? this.drag.lane : entry.preferredLane, width: this.cardWidth, height: this.heights.get(`${entry.entryId}:${entry.expanded}`) ?? (entry.expanded ? 460 : 150) }];
    });
    const focused = this.plugin.requestedFocus;
    if (focused) {
      const target = valid.find(record => record.entryId === focused);
      if (target?.effectiveDate) {
        const half = (this.range.end - this.range.start) / 2;
        this.range = clampRange({ start: target.effectiveDate.coordinate - half, end: target.effectiveDate.coordinate + half });
      }
    }
    const layout = layoutCards(inputs, this.range, this.width);
    this.items = layout.items;
    const height = Math.max(this.scroll.clientHeight, layout.height);
    const wasAtBottom = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 48;
    this.scene.style.setProperty('--noteline-scene-height', `${height}px`);
    this.scene.style.setProperty('--noteline-card-width', `${this.cardWidth}px`);
    const shift = height - layout.height;
    if (!this.initializedScroll) {
      this.initializedScroll = true;
      this.scroll.scrollTop = store.state.timeline.viewport?.scrollTop ?? height;
    } else if (height !== this.previousHeight && wasAtBottom) {
      this.scroll.scrollTop = height;
    }
    this.previousHeight = height;
    if (this.scrollToBottom) { this.scroll.scrollTop = height; this.scrollToBottom = false; }
    const reveal = focused ?? this.revealId;
    if (reveal) {
      const target = layout.items.find(item => item.id === reveal);
      if (target) {
        this.scroll.scrollTop = Math.max(0, target.y + shift - 24);
        this.plugin.requestedFocus = null;
        this.revealId = undefined;
        this.saveCameraLater();
      }
    }
    this.lines.replaceChildren();
    this.lines.setAttribute('width', String(this.width));
    this.lines.setAttribute('height', String(height));
    const wanted = new Set<string>();
    for (const item of layout.items) {
      const top = item.y + shift;
      if (item.x + item.width < -300 || item.x > this.width + 300 || top + item.height < this.scroll.scrollTop - 500 || top > this.scroll.scrollTop + this.scroll.clientHeight + 500) continue;
      const record = this.plugin.records.get(item.id);
      const entry = this.plugin.entry(item.id);
      if (!record || !entry) continue;
      wanted.add(item.id);
      let card = this.cards.get(item.id);
      if (!card) {
        card = this.addChild(new NoteCard(this, entry, record));
        this.cards.set(item.id, card);
        this.scene.appendChild(card.element);
      }
      card.update(entry, record);
      // Geometry comes from the current viewport; visual constants live in styles.css.
      card.element.style.setProperty('--noteline-card-x', `${item.x}px`);
      card.element.style.setProperty('--noteline-card-y', `${top}px`);
      card.element.toggleClass('is-dragging', this.drag?.id === item.id);
      const x = dateToX(item.coordinate, this.range, this.width);
      const line = this.contentEl.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x));
      line.setAttribute('y1', String(top + item.height)); line.setAttribute('y2', String(height));
      line.classList.add(record.missingDate || record.metadata?.missingTags ? 'is-incomplete' : 'is-complete');
      this.lines.appendChild(line);
    }
    for (const [id, card] of this.cards) if (!wanted.has(id) && !card.element.contains(card.element.ownerDocument.activeElement)) { this.removeChild(card); card.element.remove(); this.cards.delete(id); }
    let empty = this.scene.querySelector<HTMLElement>('.noteline-empty');
    if (!inputs.length) {
      if (!empty) {
        empty = this.scene.createDiv({ cls: 'noteline-empty' });
        empty.createDiv({ text: 'Каждая заметка — точка во времени', cls: 'noteline-empty-title' });
        empty.createEl('p', { text: 'Добавьте заметки из любой папки. Дата задает положение по горизонтали, высоту карточки выбираете вы.' });
        empty.createEl('button', { text: 'Добавить заметку', cls: 'mod-cta' }).addEventListener('click', () => this.plugin.chooseNote());
      }
    } else empty?.remove();
    this.axis.empty();
    for (const record of valid) {
      if (!record.effectiveDate) continue;
      const x = dateToX(record.effectiveDate.coordinate, this.range, this.width);
      if (x < 0 || x > this.width) continue;
      const point = this.axis.createDiv({ cls: 'noteline-axis-point', attr: { 'aria-hidden': 'true' } });
      point.style.setProperty('--noteline-point-x', `${x}px`);
      point.toggleClass('is-incomplete', record.missingDate || !!record.metadata?.missingTags);
    }
    for (const tick of generateTicks(this.range, this.width)) {
      const element = this.axis.createDiv({ cls: 'noteline-tick', text: tick.label });
      element.style.setProperty('--noteline-tick-x', `${dateToX(tick.coordinate, this.range, this.width)}px`);
    }
    const today = parseCalendarDate(calendarDateToday(new Date()))?.coordinate;
    if (today !== undefined && today >= this.range.start && today <= this.range.end) {
      const marker = this.axis.createDiv({ cls: 'noteline-today', text: 'Сегодня' });
      marker.style.setProperty('--noteline-tick-x', `${dateToX(today, this.range, this.width)}px`);
    }
    this.zoomIn.disabled = this.range.end - this.range.start <= MIN_SPAN;
    this.zoomOut.disabled = this.range.end - this.range.start >= this.maximumSpan() - 1;
  }

  private renderProblems(records: NoteRecord[]): void {
    const problems = this.plugin.store.state.timeline.entries.flatMap(entry => {
      const record = records.find(item => item.entryId === entry.entryId);
      if (!record) return [{ entry, message: 'Чтение заметки…', error: false }];
      if (record.error) return [{ entry, message: record.error, error: true }];
      return [];
    });
    const key = JSON.stringify(problems.map(item => [item.entry.entryId, item.entry.filePath, item.message]));
    if (key === this.lastProblemKey) return;
    this.lastProblemKey = key;
    this.problems.empty();
    if (!problems.length) return;
    const details = this.problems.createEl('details');
    details.createEl('summary', { text: `Требуют внимания: ${problems.length}` });
    for (const item of problems) {
      const row = details.createDiv({ cls: 'noteline-problem-row' });
      row.createSpan({ text: `${item.entry.filePath}: ${item.message}` });
      if (item.error) {
        button(row, 'Открыть заметку', 'external-link', () => { void this.plugin.openNote(item.entry.filePath); });
        button(row, 'Выбрать другой файл', 'file-search', () => this.plugin.relink(item.entry.entryId));
        button(row, 'Убрать с оси', 'x', () => this.plugin.remove(item.entry.entryId));
      }
    }
  }

  measure(id: string, expanded: boolean, height: number): void {
    const key = `${id}:${expanded}`;
    if (height > 0 && Math.abs((this.heights.get(key) ?? 0) - height) > 1) {
      this.heights.set(key, height);
      if (this.revealAfterMeasure === id) { this.revealId = id; this.revealAfterMeasure = undefined; }
      this.schedule();
    }
  }

  lane(id: string): number { return this.items.find(item => item.id === id)?.lane ?? 0; }
  reveal(id: string): void { this.revealId = id; this.revealAfterMeasure = id; this.schedule(); }
  previewLane(id: string, lane: number): void { this.drag = { id, lane: Math.max(0, lane) }; this.schedule(); }
  finishMove(id: string, commit: boolean): void {
    const pending = this.drag;
    const input = this.items.map(item => ({ ...item, preferredLane: pending?.id === item.id ? pending.lane : item.preferredLane }));
    const lane = layoutCards(input, this.range, this.width).items.find(item => item.id === id)?.lane ?? this.lane(id);
    this.drag = undefined;
    if (commit) this.plugin.updateEntry(id, entry => { entry.preferredLane = lane; });
    this.reveal(id);
    this.schedule();
  }
  stepLane(id: string, delta: number): void {
    const input = this.items.map(item => ({ ...item, preferredLane: item.id === id ? Math.max(0, item.lane + delta) : item.preferredLane }));
    const result = layoutCards(input, this.range, this.width).items.find(item => item.id === id);
    if (result) {
      this.reveal(id);
      this.plugin.updateEntry(id, entry => { entry.preferredLane = result.lane; });
    }
  }

  async onClose(): Promise<void> {
    this.flushCamera();
    this.closed = true;
    if (this.frame) this.contentEl.win.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.observer?.disconnect();
    for (const card of this.cards.values()) this.removeChild(card);
    this.cards.clear();
    this.contentEl.empty();
  }

  flushCamera(): void {
    if (this.saveTimer !== undefined) { this.contentEl.win.clearTimeout(this.saveTimer); this.saveTimer = undefined; this.saveCamera(); }
  }
}

class NoteCard extends Component {
  element: HTMLElement;
  private view: TimelineView;
  private id: string;
  private record?: NoteRecord;
  private expanded?: boolean;
  private title!: HTMLButtonElement;
  private date!: HTMLElement;
  private reasons!: HTMLElement;
  private tags!: HTMLElement;
  private body!: HTMLElement;
  private expand!: HTMLButtonElement;
  private renderer?: Component;
  private observer?: ResizeObserver;
  private generation = 0;
  private alive = true;

  constructor(view: TimelineView, entry: TimelineEntry, record: NoteRecord) {
    super();
    this.view = view;
    this.id = entry.entryId;
    this.element = view.contentEl.ownerDocument.createElement('article');
    this.element.className = 'noteline-card';
    this.element.setAttribute('aria-label', record.title);
    const controls = this.element.createDiv({ cls: 'noteline-card-controls' });
    const handle = button(controls, 'Переместить выше или ниже. Стрелки вверх и вниз меняют уровень.', 'grip-vertical', () => {});
    handle.addClass('noteline-drag-handle');
    let drag: { pointerId: number; y: number; lane: number } | undefined;
    this.registerDomEvent(handle, 'pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      drag = { pointerId: event.pointerId, y: event.clientY, lane: view.lane(this.id) };
      handle.setPointerCapture(event.pointerId);
    });
    this.registerDomEvent(handle, 'pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      view.previewLane(this.id, drag.lane + Math.round((drag.y - event.clientY) / Math.max(64, this.element.offsetHeight + 16)));
    });
    this.registerDomEvent(handle, 'pointerup', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = undefined;
      view.finishMove(this.id, true);
    });
    this.registerDomEvent(handle, 'pointercancel', () => { drag = undefined; view.finishMove(this.id, false); });
    this.registerDomEvent(handle, 'keydown', event => {
      if (event.key === 'Escape') { drag = undefined; view.finishMove(this.id, false); }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); view.stepLane(this.id, event.key === 'ArrowUp' ? 1 : -1); }
    });
    this.expand = button(controls, 'Развернуть заметку', 'chevrons-up-down', () => {
      view.reveal(this.id);
      view.plugin.updateEntry(this.id, item => { item.expanded = !item.expanded; });
    });
    button(controls, 'Выше', 'arrow-up', () => view.stepLane(this.id, 1));
    button(controls, 'Ниже', 'arrow-down', () => view.stepLane(this.id, -1));
    button(controls, 'Действия с карточкой', 'ellipsis', () => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle('Открыть заметку').setIcon('external-link').onClick(() => view.plugin.openNote(this.record?.path ?? '')));
      menu.addItem(item => item.setTitle('Добавить тег').setIcon('tag').onClick(() => view.plugin.tagDialog(this.id)));
      menu.addItem(item => item.setTitle('Убрать с оси').setIcon('x').onClick(() => view.plugin.remove(this.id)));
      const bounds = this.element.getBoundingClientRect();
      menu.showAtPosition({ x: bounds.right - 20, y: bounds.top + 24 });
    });
    this.title = this.element.createEl('button', { cls: 'noteline-card-title', attr: { type: 'button' } });
    this.title.addEventListener('click', () => { if (this.record) void view.plugin.openNote(this.record.path); });
    this.date = this.element.createDiv({ cls: 'noteline-card-date' });
    this.reasons = this.element.createDiv({ cls: 'noteline-card-reasons' });
    this.tags = this.element.createDiv({ cls: 'noteline-card-tags' });
    this.body = this.element.createDiv({ cls: 'noteline-card-body markdown-rendered' });
    const Observer = (this.element.win as Window & typeof globalThis).ResizeObserver;
    this.observer = new Observer(() => view.measure(this.id, this.expanded ?? false, this.element.getBoundingClientRect().height));
    this.observer.observe(this.element);
    this.update(entry, record);
  }

  update(entry: TimelineEntry, record: NoteRecord): void {
    if (this.record === record && this.expanded === entry.expanded) return;
    this.record = record;
    this.expanded = entry.expanded;
    this.title.setText(record.title);
    this.title.setAttribute('title', record.path);
    this.element.setAttribute('aria-label', record.title);
    this.date.setText(`${record.missingDate ? 'Дата подставлена: ' : ''}${record.effectiveDate?.value ?? ''}`);
    const dateSource = record.metadata?.date;
    this.date.setAttribute('title', dateSource?.kind === 'valid' ? `Источник: ${dateSource.source}` : 'Нет даты в заметке — сохранена дата добавления');
    const reasons: string[] = [];
    if (record.missingDate) reasons.push('Нет даты');
    if (record.metadata?.missingTags) reasons.push('Нет тегов');
    if (dateSource?.kind === 'valid') reasons.push(...dateSource.warnings);
    reasons.push(...(record.metadata?.warnings ?? []));
    this.reasons.setText(reasons.join(' · '));
    this.element.toggleClass('is-incomplete', record.missingDate || !!record.metadata?.missingTags);
    const firstTag = record.metadata?.tags[0]?.toLowerCase();
    const color = firstTag ? [...firstTag].reduce((hash, char) => (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0, 0) % 6 : -1;
    for (let index = 0; index < 6; index++) this.element.toggleClass(`noteline-accent-${index}`, color === index);
    this.tags.empty();
    for (const tag of record.metadata?.tags ?? []) this.tags.createSpan({ cls: 'noteline-tag', text: `#${tag}` });
    button(this.tags, 'Добавить тег', 'plus', () => this.view.plugin.tagDialog(this.id));
    this.expand.setAttribute('aria-expanded', String(entry.expanded));
    this.expand.setAttribute('aria-label', entry.expanded ? 'Свернуть заметку' : 'Развернуть заметку');
    this.element.toggleClass('is-expanded', entry.expanded);
    this.generation++;
    const generation = this.generation;
    if (this.renderer) this.removeChild(this.renderer);
    this.body.empty();
    if (entry.expanded && record.metadata) {
      const renderer = this.addChild(new Component());
      this.renderer = renderer;
      const renderTarget = this.body.createDiv();
      void MarkdownRenderer.render(this.view.app, record.metadata.body, renderTarget, record.path, renderer).then(() => {
        if (!this.alive || generation !== this.generation) { renderer.unload(); return; }
        for (const checkbox of renderTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) checkbox.disabled = true;
        this.view.measure(this.id, true, this.element.getBoundingClientRect().height);
      }).catch(error => {
        if (!this.alive || generation !== this.generation) return;
        this.body.setText(`Не удалось показать Markdown: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  onunload(): void { this.alive = false; this.generation++; this.observer?.disconnect(); this.element.remove(); }
}
