import { Component, EditableFileView, MarkdownRenderer, Menu, Notice, setIcon, type TFile, type WorkspaceLeaf } from 'obsidian';
import type NotelinePlugin from '../main.ts';
import type { NoteRecord, TimelineSession } from '../services/timeline-session.ts';
import type { TimelineEntry } from '../domain/state.ts';
import { calendarDateToday, formatCalendarDate, parseCalendarDate } from '../domain/metadata.ts';
import { MIN_SPAN, clampRange, dateToX, fitRange, generateTicks, layoutCards, layoutVerticalCards, maxSpanForCoordinates, panRange, zoomRange, type LayoutInput, type LayoutItem, type TimeRange } from '../domain/timeline.ts';
import { ValueModal } from './dialogs.ts';
import { bindTimelineTouch } from './timeline-touch.ts';

export const VIEW_TYPE = 'noteline-timeline';
const STATUS = { saved: 'Сохранено', saving: 'Сохранение…', error: 'Ошибка сохранения — нажмите для повтора', conflict: 'Конфликт файла', readonly: 'Только чтение' };
function button(parent: HTMLElement, label: string, icon: string, action: () => void): HTMLButtonElement {
  const element = parent.createEl('button', { cls: 'noteline-icon-button', attr: { type: 'button', 'aria-label': label, title: label } });
  setIcon(element, icon); element.addEventListener('click', action); return element;
}
function currentMonth(): TimeRange {
  const today = parseCalendarDate(calendarDateToday(new Date()));
  const start = new Date(today?.coordinate ?? 0); start.setUTCDate(1);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  return clampRange({ start: start.getTime(), end: end.getTime() });
}

export class TimelineView extends EditableFileView {
  plugin!: TimelineSession;
  private owner: NotelinePlugin;
  private boundFile: TFile | null = null;
  private binding = 0;
  private events?: Component;
  private unsubscribe?: () => void;
  private unsubscribeCollection?: () => void;
  private scroll!: HTMLElement;
  private scene!: HTMLElement;
  private axis!: HTMLElement;
  private lines!: SVGSVGElement;
  private problems!: HTMLElement;
  private status!: HTMLButtonElement;
  private zoomOut!: HTMLButtonElement;
  private zoomIn!: HTMLButtonElement;
  private orientation!: HTMLSelectElement;
  private direction!: HTMLSelectElement;
  private range: TimeRange = currentMonth();
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
  private cancelTouch?: (persist?: boolean) => void;
  constructor(leaf: WorkspaceLeaf, owner: NotelinePlugin) { super(leaf); this.owner = owner; this.allowNoFile = false; }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file?.basename ?? 'Временная ось'; }
  getIcon(): string { return 'git-commit-horizontal'; }
  canAcceptExtension(extension: string): boolean { return extension === 'timeline'; }
  get vertical(): boolean { return this.plugin?.store.state.timeline.orientation === 'vertical'; }
  private get reverse(): boolean { return this.plugin?.store.state.timeline.reverse ?? false; }

  async onOpen(): Promise<void> { this.contentEl.addClass('noteline'); }
  async onLoadFile(file: TFile): Promise<void> {
    const binding = ++this.binding;
    await this.detachSession(false);
    if (binding !== this.binding) return;
    this.closed = false;
    const session = await this.owner.acquireSession(file);
    if (this.closed || this.binding !== binding) { await this.owner.releaseSession(session); return; }
    this.file = file; this.boundFile = file; this.plugin = session;
    this.range = session.store.state.timeline.viewport ?? currentMonth();
    this.mount(); session.refreshAll();
  }
  async onUnloadFile(): Promise<void> { await this.detachSession(); }
  async onClose(): Promise<void> { await this.detachSession(); }

  private mount(): void {
    this.contentEl.empty(); this.contentEl.addClass('noteline');
    this.contentEl.toggleClass('is-vertical', this.vertical);
    this.events = this.addChild(new Component());
    const toolbar = this.contentEl.createDiv({ cls: 'noteline-toolbar', attr: { role: 'toolbar', 'aria-label': 'Временная ось' } });
    const brand = toolbar.createDiv({ cls: 'noteline-brand' }); brand.createSpan({ text: 'Noteline' });
    const select = brand.createEl('select', { cls: 'noteline-file-select', attr: { 'aria-label': 'Выбрать временную ось' } });
    const updateFiles = (): void => {
      select.empty();
      for (const file of this.owner.listTimelines()) select.createEl('option', { value: file.path, text: file.path });
      select.value = this.boundFile?.path ?? '';
    };
    updateFiles(); this.unsubscribeCollection = this.owner.subscribeCollection(updateFiles);
    this.events.registerDomEvent(select, 'change', () => {
      const file = this.owner.listTimelines().find(item => item.path === select.value);
      if (file) void this.owner.openTimeline(file);
    });
    button(toolbar, 'Создать ось', 'file-plus-2', () => this.owner.createTimelineDialog());
    button(toolbar, 'Сохранить копию оси', 'copy', () => this.owner.createTimelineDialog(this.plugin, this.boundFile ?? undefined));
    button(toolbar, 'Перечитать файл оси', 'refresh-cw', () => { if (this.boundFile) this.owner.confirmReload(this.boundFile, this.plugin); });
    button(toolbar, 'Удалить ось', 'trash-2', () => { if (this.boundFile) this.owner.confirmDelete(this.boundFile); });
    const add = toolbar.createEl('button', { cls: 'mod-cta noteline-add', text: 'Добавить заметку', attr: { type: 'button' } });
    this.events.registerDomEvent(add, 'click', () => this.plugin.chooseNote());
    this.orientation = toolbar.createEl('select', { attr: { 'aria-label': 'Ориентация оси' } });
    this.orientation.createEl('option', { value: 'horizontal', text: 'Горизонтальная' });
    this.orientation.createEl('option', { value: 'vertical', text: 'Вертикальная' });
    this.events.registerDomEvent(this.orientation, 'change', () => this.changeOrientation());
    this.direction = toolbar.createEl('select', { attr: { 'aria-label': 'Направление дат' } });
    this.direction.createEl('option', { value: 'forward', text: 'От старых к новым' });
    this.direction.createEl('option', { value: 'reverse', text: 'От новых к старым' });
    this.events.registerDomEvent(this.direction, 'change', () => {
      this.cancelTouch?.();
      try { this.plugin.store.change(state => { state.timeline.reverse = this.direction.value === 'reverse'; }); }
      catch (error) { this.plugin.report(error); }
    });
    this.zoomOut = button(toolbar, 'Уменьшить масштаб', 'minus', () => this.zoom(1 / 1.5));
    this.zoomIn = button(toolbar, 'Увеличить масштаб', 'plus', () => this.zoom(1.5));
    button(toolbar, 'Сдвинуть в прошлое', 'chevron-left', () => this.pan(-0.4));
    button(toolbar, 'Сдвинуть в будущее', 'chevron-right', () => this.pan(0.4));
    button(toolbar, 'Показать все', 'scan', () => this.fit());
    button(toolbar, 'Сегодня', 'calendar-check', () => this.goToday());
    button(toolbar, 'К дате', 'calendar-search', () => this.dateDialog());
    button(toolbar, 'Параметры даты', 'settings-2', () => this.propertyDialog());
    this.status = toolbar.createEl('button', { cls: 'noteline-save-state', attr: { type: 'button' } });
    this.events.registerDomEvent(this.status, 'click', () => { if (this.plugin.store.status === 'error') void this.plugin.store.flush(); else if (this.plugin.store.error) new Notice(this.plugin.store.error); });
    this.problems = this.contentEl.createDiv({ cls: 'noteline-problems' });
    const stage = this.contentEl.createDiv({ cls: 'noteline-stage' });
    this.scroll = stage.createDiv({ cls: 'noteline-scroll', attr: { tabindex: '0', 'aria-label': 'Поле карточек. Кнопки меняют масштаб и даты, прокрутка перемещает поперечные уровни.' } });
    this.scene = this.scroll.createDiv({ cls: 'noteline-scene' });
    this.lines = this.contentEl.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.lines.classList.add('noteline-connectors'); this.lines.setAttribute('aria-hidden', 'true'); this.scene.appendChild(this.lines);
    this.axis = stage.createDiv({ cls: 'noteline-axis', attr: { 'aria-label': 'Шкала времени' } });
    this.cancelTouch = bindTimelineTouch(this.events, [this.scroll, this.axis],
      () => ({ range: this.range, extent: this.extent, vertical: this.vertical, reverse: this.reverse }),
      range => this.setRange(range), () => this.flushCamera());
    this.unsubscribe = this.plugin.subscribe(() => this.schedule());
    this.events.registerDomEvent(this.scroll, 'scroll', () => { this.schedule(); this.saveCameraLater(); });
    this.events.registerDomEvent(this.scroll, 'wheel', event => {
      const onBody = (event.targetNode?.nodeType === 1 ? event.targetNode as Element : event.targetNode?.parentElement)?.closest('.noteline-card-body');
      const card = (event.targetNode?.nodeType === 1 ? event.targetNode as Element : event.targetNode?.parentElement)?.closest<HTMLElement>('.noteline-card');
      const scrollableCard = card && card.scrollHeight > card.clientHeight;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const bounds = this.scroll.getBoundingClientRect();
        const extent = this.vertical ? bounds.height : bounds.width;
        if (extent > 0) this.zoom(Math.exp(Math.max(-4, Math.min(4, -event.deltaY * 0.002))), (this.vertical ? event.clientY - bounds.top : event.clientX - bounds.left) / extent);
      } else if (event.shiftKey || (!this.vertical && Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
        event.preventDefault();
        const pixels = event.deltaX || event.deltaY;
        this.setRange(panRange(this.range, (this.reverse ? -1 : 1) * pixels / Math.max(1, this.extent) * (this.range.end - this.range.start)));
      } else if (this.vertical && !onBody && !scrollableCard) {
        event.preventDefault(); this.scroll.scrollLeft += event.deltaX || event.deltaY;
      }
    }, { passive: false });
    const Observer = (this.contentEl.win as Window & typeof globalThis).ResizeObserver;
    this.observer = new Observer(() => this.schedule()); this.observer.observe(this.scroll);
    this.seenExternal = this.plugin.externalRevision; this.schedule();
  }

  private get width(): number { return this.scroll?.clientWidth ?? 0; }
  private get extent(): number { return this.vertical ? this.scroll?.clientHeight ?? 0 : this.width; }
  private get cardWidth(): number { return Math.max(180, Math.min(300, this.width - 32)); }
  private coordinates(): number[] { return [...this.plugin.records.values()].flatMap(record => record.effectiveDate ? [record.effectiveDate.coordinate] : []); }
  private cardExtent(): number { return this.vertical ? Math.max(150, ...this.heights.values()) : this.cardWidth; }
  private maximumSpan(): number {
    const coordinates = this.coordinates(); const fitted = fitRange(coordinates, this.extent, this.cardExtent());
    return Math.max(maxSpanForCoordinates(coordinates, parseCalendarDate(calendarDateToday(new Date()))?.coordinate ?? 0), fitted.end - fitted.start);
  }
  schedule(): void { if (this.closed || this.frame) return; this.frame = this.contentEl.win.requestAnimationFrame(() => { this.frame = 0; this.render(); }); }
  private setRange(range: TimeRange): void { this.range = range; this.schedule(); this.saveCameraLater(); }
  private zoom(factor: number, anchor = 0.5): void { this.setRange(zoomRange(this.range, factor, anchor, this.maximumSpan(), this.reverse)); }
  private pan(fraction: number): void { this.setRange(panRange(this.range, fraction * (this.range.end - this.range.start))); }
  private fit(): void { const coordinates = this.coordinates(); this.setRange(coordinates.length ? fitRange(coordinates, this.extent, this.cardExtent()) : currentMonth()); this.scrollToBottom = true; }
  private goToday(): void { const date = parseCalendarDate(calendarDateToday(new Date())); if (date) this.center(date.coordinate); }
  private center(coordinate: number): void { const half = (this.range.end - this.range.start) / 2; this.setRange(clampRange({ start: coordinate - half, end: coordinate + half })); }
  private dateDialog(): void {
    new ValueModal(this.app, 'Перейти к дате', 'Дата и время, дата, YYYY-MM, год, римский век. Для годов и веков допустимы BC или д.н.э.', calendarDateToday(new Date()), async value => {
      const date = parseCalendarDate(value); if (!date) throw new Error('Некорректная дата. Примеры: 2026-10-23 15:30, 2026-10, 2026, XIX, II BC.'); this.center(date.coordinate);
    }).open();
  }
  private propertyDialog(): void {
    new ValueModal(this.app, 'Свойства даты', 'Имена через запятую в порядке приоритета; затем начальная строка 📅. Настройка относится к этому файлу оси.', this.plugin.store.state.settings.dateProperties.join(', '), async value => {
      const properties = value.split(',').map(name => name.trim()).filter(Boolean);
      if (new Set(properties).size !== properties.length) throw new Error('Имена свойств повторяются.');
      this.plugin.store.change(state => { state.settings.dateProperties = properties; }); this.plugin.refreshAll();
    }).open();
  }
  private changeOrientation(): void {
    try {
      this.cancelTouch?.();
      this.flushCamera();
      this.plugin.store.change(state => { state.timeline.orientation = this.orientation.value === 'vertical' ? 'vertical' : 'horizontal'; if (state.timeline.viewport) { state.timeline.viewport.scrollTop = 0; state.timeline.viewport.scrollLeft = 0; } });
      this.initializedScroll = false; this.drag = undefined; this.schedule();
    } catch (error) { this.plugin.report(error); }
  }
  private saveCameraLater(): void {
    if (this.closed || !this.plugin.store.writable) return;
    if (this.saveTimer !== undefined) this.contentEl.win.clearTimeout(this.saveTimer);
    this.saveTimer = this.contentEl.win.setTimeout(() => { this.saveTimer = undefined; this.saveCamera(); }, 350);
  }
  private saveCamera(): void {
    // An external state can arrive before the next render cancels a pending gesture/timer.
    if (!this.plugin.store.writable || this.seenExternal !== this.plugin.externalRevision) return;
    const viewport = { start: this.range.start, end: this.range.end, scrollTop: this.scroll.scrollTop, scrollLeft: this.scroll.scrollLeft };
    try { this.plugin.store.change(state => { state.timeline.viewport = viewport; }); } catch (error) { this.plugin.report(error); }
  }
  private layout(inputs: LayoutInput[]): { items: LayoutItem[]; height: number; width: number } {
    if (this.vertical) { const layout = layoutVerticalCards(inputs, this.range, this.extent, this.reverse); return { ...layout, height: this.extent }; }
    return { ...layoutCards(inputs, this.range, this.width, this.reverse), width: this.width };
  }
  private render(): void {
    if (this.closed || this.width <= 0 || this.extent <= 0) return;
    if (this.seenExternal !== this.plugin.externalRevision) {
      this.cancelTouch?.(false);
      if (this.saveTimer !== undefined) { this.contentEl.win.clearTimeout(this.saveTimer); this.saveTimer = undefined; }
      this.seenExternal = this.plugin.externalRevision; this.range = this.plugin.store.state.timeline.viewport ?? currentMonth(); this.initializedScroll = false; this.drag = undefined;
    }
    const store = this.plugin.store;
    this.contentEl.toggleClass('is-vertical', this.vertical);
    this.orientation.value = this.vertical ? 'vertical' : 'horizontal'; this.direction.value = this.reverse ? 'reverse' : 'forward';
    this.orientation.disabled = this.direction.disabled = !store.writable;
    this.status.setText(STATUS[store.status]); this.status.setAttribute('title', store.error || STATUS[store.status]);
    this.status.toggleClass('noteline-error', store.status === 'error' || store.status === 'readonly' || store.status === 'conflict');
    const records = [...this.plugin.records.values()]; const valid = records.filter(record => record.effectiveDate && !record.error); this.renderProblems(records);
    const inputs = valid.flatMap(record => {
      const entry = this.plugin.entry(record.entryId); if (!entry || !record.effectiveDate) return [];
      return [{ id: entry.entryId, coordinate: record.effectiveDate.coordinate, preferredLane: this.drag?.id === entry.entryId ? this.drag.lane : entry.preferredLane, width: this.cardWidth, height: this.heights.get(`${entry.entryId}:${entry.expanded}`) ?? (entry.expanded ? 460 : 180) }];
    });
    const focused = this.plugin.requestedFocus;
    if (focused) {
      const target = valid.find(record => record.entryId === focused);
      if (target?.effectiveDate) { const half = (this.range.end - this.range.start) / 2; this.range = clampRange({ start: target.effectiveDate.coordinate - half, end: target.effectiveDate.coordinate + half }); }
    }
    const layout = this.layout(inputs); this.items = layout.items;
    const height = Math.max(this.scroll.clientHeight, layout.height); const width = Math.max(this.width, layout.width);
    const wasAtBottom = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 48;
    this.scene.style.setProperty('--noteline-scene-height', `${height}px`); this.scene.style.setProperty('--noteline-scene-width', `${width}px`); this.scene.style.setProperty('--noteline-card-width', `${this.cardWidth}px`);
    const shift = this.vertical ? 0 : height - layout.height;
    if (!this.initializedScroll) { this.initializedScroll = true; this.scroll.scrollTop = this.vertical ? 0 : store.state.timeline.viewport?.scrollTop ?? height; this.scroll.scrollLeft = this.vertical ? store.state.timeline.viewport?.scrollLeft ?? 0 : 0; }
    else if (!this.vertical && height !== this.previousHeight && wasAtBottom) this.scroll.scrollTop = height;
    this.previousHeight = height;
    if (this.scrollToBottom) { if (this.vertical) this.scroll.scrollLeft = 0; else this.scroll.scrollTop = height; this.scrollToBottom = false; }
    const reveal = focused ?? this.revealId;
    if (reveal) {
      const target = layout.items.find(item => item.id === reveal);
      if (target) { if (this.vertical) this.scroll.scrollLeft = Math.max(0, target.x - 24); else this.scroll.scrollTop = Math.max(0, target.y + shift - 24); this.plugin.requestedFocus = null; this.revealId = undefined; this.saveCameraLater(); }
    }
    this.lines.replaceChildren(); this.lines.setAttribute('width', String(width)); this.lines.setAttribute('height', String(height));
    const wanted = new Set<string>();
    for (const item of layout.items) {
      const top = item.y + shift;
      const existing = this.cards.get(item.id);
      const focusedCard = existing?.element.contains(existing.element.ownerDocument.activeElement);
      if (!focusedCard && (item.x + item.width < this.scroll.scrollLeft - 300 || item.x > this.scroll.scrollLeft + this.width + 300 || top + item.height < this.scroll.scrollTop - 500 || top > this.scroll.scrollTop + this.scroll.clientHeight + 500)) continue;
      const record = this.plugin.records.get(item.id); const entry = this.plugin.entry(item.id); if (!record || !entry) continue;
      wanted.add(item.id); let card = existing;
      if (!card) { card = this.addChild(new NoteCard(this, entry, record)); this.cards.set(item.id, card); this.scene.appendChild(card.element); }
      card.update(entry, record); card.element.style.setProperty('--noteline-card-x', `${item.x}px`); card.element.style.setProperty('--noteline-card-y', `${top}px`); card.element.toggleClass('is-dragging', this.drag?.id === item.id);
      const time = dateToX(item.coordinate, this.range, this.extent, this.reverse);
      const line = this.contentEl.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(this.vertical ? 0 : time)); line.setAttribute('x2', String(this.vertical ? item.x : time));
      line.setAttribute('y1', String(this.vertical ? time : top + item.height)); line.setAttribute('y2', String(this.vertical ? time : height));
      line.classList.add(record.missingDate || record.metadata?.missingTags ? 'is-incomplete' : 'is-complete'); this.lines.appendChild(line);
    }
    const validIds = new Set(layout.items.map(item => item.id));
    for (const [id, card] of this.cards) if (!wanted.has(id) && (!validIds.has(id) || !card.element.contains(card.element.ownerDocument.activeElement))) { this.removeChild(card); card.element.remove(); this.cards.delete(id); }
    let empty = this.scene.querySelector<HTMLElement>('.noteline-empty');
    if (!inputs.length) { if (!empty) { empty = this.scene.createDiv({ cls: 'noteline-empty' }); empty.createDiv({ text: 'Каждая заметка — точка во времени', cls: 'noteline-empty-title' }); empty.createEl('p', { text: 'Добавьте заметки из любой папки. Ориентация и направление меняются на панели.' }); empty.createEl('button', { text: 'Добавить заметку', cls: 'mod-cta' }).addEventListener('click', () => this.plugin.chooseNote()); } } else empty?.remove();
    this.axis.empty();
    for (const record of valid) {
      if (!record.effectiveDate) continue; const position = dateToX(record.effectiveDate.coordinate, this.range, this.extent, this.reverse); if (position < 0 || position > this.extent) continue;
      const point = this.axis.createDiv({ cls: 'noteline-axis-point', attr: { 'aria-hidden': 'true' } }); point.style.setProperty('--noteline-point-x', `${position}px`); point.toggleClass('is-incomplete', record.missingDate || !!record.metadata?.missingTags);
    }
    for (const tick of generateTicks(this.range, this.extent)) { const element = this.axis.createDiv({ cls: 'noteline-tick', text: tick.label }); element.style.setProperty('--noteline-tick-x', `${dateToX(tick.coordinate, this.range, this.extent, this.reverse)}px`); }
    const today = parseCalendarDate(calendarDateToday(new Date()))?.coordinate;
    if (today !== undefined && today >= this.range.start && today <= this.range.end) { const marker = this.axis.createDiv({ cls: 'noteline-today', text: 'Сегодня' }); marker.style.setProperty('--noteline-tick-x', `${dateToX(today, this.range, this.extent, this.reverse)}px`); }
    this.zoomIn.disabled = this.range.end - this.range.start <= MIN_SPAN; this.zoomOut.disabled = this.range.end - this.range.start >= this.maximumSpan() - 1;
  }

  private renderProblems(records: NoteRecord[]): void {
    const problems = this.plugin.store.state.timeline.entries.flatMap(entry => { const record = records.find(item => item.entryId === entry.entryId); if (!record) return [{ entry, message: 'Чтение заметки…', error: false }]; if (record.error) return [{ entry, message: record.error, error: true }]; return []; });
    const key = JSON.stringify(problems.map(item => [item.entry.entryId, item.entry.filePath, item.message])); if (key === this.lastProblemKey) return; this.lastProblemKey = key;
    this.problems.empty(); if (!problems.length) return;
    const details = this.problems.createEl('details'); details.createEl('summary', { text: `Требуют внимания: ${problems.length}` });
    for (const item of problems) { const row = details.createDiv({ cls: 'noteline-problem-row' }); row.createSpan({ text: `${item.entry.filePath}: ${item.message}` }); if (item.error) { button(row, 'Открыть заметку', 'external-link', () => { void this.plugin.openNote(item.entry.filePath); }); button(row, 'Выбрать другой файл', 'file-search', () => this.plugin.relink(item.entry.entryId)); button(row, 'Убрать с оси', 'x', () => this.plugin.remove(item.entry.entryId)); } }
  }
  measure(id: string, expanded: boolean, height: number): void { const key = `${id}:${expanded}`; if (height > 0 && Math.abs((this.heights.get(key) ?? 0) - height) > 1) { this.heights.set(key, height); if (this.revealAfterMeasure === id) { this.revealId = id; this.revealAfterMeasure = undefined; } this.schedule(); } }
  lane(id: string): number { return this.items.find(item => item.id === id)?.lane ?? 0; }
  reveal(id: string): void { this.revealId = id; this.revealAfterMeasure = id; this.schedule(); }
  previewLane(id: string, lane: number): void { this.drag = { id, lane: Math.max(0, lane) }; this.schedule(); }
  finishMove(id: string, commit: boolean): void {
    const pending = this.drag; const input = this.items.map(item => ({ ...item, preferredLane: pending?.id === item.id ? pending.lane : item.preferredLane }));
    const lane = this.layout(input).items.find(item => item.id === id)?.lane ?? this.lane(id); this.drag = undefined;
    if (commit) this.plugin.updateEntry(id, entry => { entry.preferredLane = lane; }); this.reveal(id); this.schedule();
  }
  stepLane(id: string, delta: number): void { const input = this.items.map(item => ({ ...item, preferredLane: item.id === id ? Math.max(0, item.lane + delta) : item.preferredLane })); const result = this.layout(input).items.find(item => item.id === id); if (result) { this.reveal(id); this.plugin.updateEntry(id, entry => { entry.preferredLane = result.lane; }); } }
  flushCamera(): void { if (this.saveTimer !== undefined) { this.contentEl.win.clearTimeout(this.saveTimer); this.saveTimer = undefined; this.saveCamera(); } }
  private async detachSession(invalidate = true): Promise<void> {
    if (invalidate) this.binding++;
    this.cancelTouch?.(); this.cancelTouch = undefined;
    this.flushCamera(); this.closed = true;
    if (this.frame) this.contentEl.win.cancelAnimationFrame(this.frame); this.frame = 0;
    this.observer?.disconnect(); this.unsubscribe?.(); this.unsubscribeCollection?.(); this.unsubscribe = undefined; this.unsubscribeCollection = undefined;
    for (const card of this.cards.values()) this.removeChild(card); this.cards.clear(); this.heights.clear();
    if (this.events) { this.removeChild(this.events); this.events = undefined; }
    const file = this.boundFile; this.boundFile = null;
    this.initializedScroll = false; this.lastProblemKey = ''; this.previousHeight = 0; this.drag = undefined; this.revealId = undefined; this.revealAfterMeasure = undefined;
    this.contentEl.empty(); if (file) await this.owner.releaseSession(this.plugin);
  }
}

export class NoteCard extends Component {
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
    const handle = button(controls, 'Переместить поперёк оси. В горизонтальном режиме — вверх/вниз; в вертикальном — вправо/влево.', 'grip-vertical', () => {});
    handle.addClass('noteline-drag-handle');
    let drag: { pointerId: number; position: number; lane: number } | undefined;
    this.registerDomEvent(handle, 'pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      drag = { pointerId: event.pointerId, position: view.vertical ? event.clientX : event.clientY, lane: view.lane(this.id) };
      handle.setPointerCapture(event.pointerId);
    });
    this.registerDomEvent(handle, 'pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      view.previewLane(this.id, drag.lane + Math.round((view.vertical ? event.clientX - drag.position : drag.position - event.clientY) / Math.max(64, (view.vertical ? this.element.offsetWidth : this.element.offsetHeight) + 16)));
    });
    this.registerDomEvent(handle, 'pointerup', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = undefined;
      view.finishMove(this.id, true);
    });
    this.registerDomEvent(handle, 'pointercancel', () => { drag = undefined; view.finishMove(this.id, false); });
    this.registerDomEvent(handle, 'keydown', event => {
      if (event.key === 'Escape') { drag = undefined; view.finishMove(this.id, false); }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); view.stepLane(this.id, event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : -1); }
    });
    this.expand = button(controls, 'Развернуть заметку', 'chevrons-up-down', () => {
      view.reveal(this.id);
      view.plugin.updateEntry(this.id, item => { item.expanded = !item.expanded; });
    });
    button(controls, 'Дальше от оси', 'arrow-up-right', () => view.stepLane(this.id, 1));
    button(controls, 'Ближе к оси', 'arrow-down-left', () => view.stepLane(this.id, -1));
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
    this.observer = new Observer(() => this.measure());
    this.observer.observe(this.element);
    this.update(entry, record);
  }

  private measure(): void {
    this.element.toggleClass('is-overflowing', this.element.scrollHeight > this.element.clientHeight + 1);
    this.view.measure(this.id, this.expanded ?? false, this.element.getBoundingClientRect().height);
  }

  update(entry: TimelineEntry, record: NoteRecord): void {
    if (this.record === record && this.expanded === entry.expanded) return;
    this.record = record;
    this.expanded = entry.expanded;
    this.title.setText(record.title);
    this.title.setAttribute('title', record.path);
    this.element.setAttribute('aria-label', record.title);
    this.date.setText(`${record.missingDate ? 'Дата подставлена: ' : ''}${record.effectiveDate ? formatCalendarDate(record.effectiveDate) : ''}`);
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
        this.measure();
      }).catch(error => {
        if (!this.alive || generation !== this.generation) return;
        this.body.setText(`Не удалось показать Markdown: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    this.measure();
  }

  onunload(): void { this.alive = false; this.generation++; this.observer?.disconnect(); this.element.remove(); }
}
