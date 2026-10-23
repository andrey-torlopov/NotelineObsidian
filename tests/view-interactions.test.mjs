import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { dateToX, fitRange, layoutCards, xToDate } from '../src/domain/timeline.ts';
import { createDefaultState } from '../src/domain/state.ts';

const moduleUrl = code => `data:text/javascript,${encodeURIComponent(code)}`;
const obsidian = moduleUrl(`
  export class Component {}
  export class EditableFileView { constructor(leaf) { this.leaf = leaf; } }
  export class MarkdownRenderer {}
  export class Menu {}
  export class Notice {}
  export function setIcon() {}
`);
const dialogs = moduleUrl('export class ValueModal {}');
const source = new URL('../src/ui/timeline-view.ts', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'obsidian') return { url: obsidian, shortCircuit: true };
  if (context.parentURL === source && specifier === './dialogs.ts') return { url: dialogs, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { TimelineView } = await import('../src/ui/timeline-view.ts');

function harness() {
  const state = createDefaultState();
  state.timeline.entries = [{ entryId: 'one', filePath: 'one.md', preferredLane: 0, expanded: false }];
  state.timeline.viewport = { start: 0, end: 86400000, scrollTop: 17 };
  const reports = [];
  const plugin = {
    externalRevision: 0,
    store: { state, writable: true, change(update) { update(state); } },
    records: new Map([['one', { effectiveDate: { coordinate: 43200000 } }]]),
    updateEntry(id, update) { update(state.timeline.entries.find(item => item.entryId === id)); },
    report(error) { reports.push(error); },
  };
  const owner = {};
  const view = new TimelineView({}, owner);
  view.plugin = plugin;
  view.range = { ...state.timeline.viewport };
  view.scroll = { clientWidth: 800, clientHeight: 600, scrollTop: 17, scrollLeft: 0, scrollHeight: 1000 };
  view.items = layoutCards([{ id: 'one', coordinate: 43200000, preferredLane: 0, width: 300, height: 150 }], state.timeline.viewport, 800).items;
  return { view, plugin, owner, reports, entry: state.timeline.entries[0] };
}

test('last pointer position is committed even when pointerup precedes scheduled rendering', () => {
  const { view, entry } = harness();
  view.previewLane('one', 3);
  assert.equal(view.lane('one'), 0, 'Last rendered geometry is deliberately stale');
  view.finishMove('one', true);
  assert.equal(entry.preferredLane, 3);
  assert.equal(view.revealId, 'one');
});

test('canceling a pointer move does not change persistent lane preference', () => {
  const { view, entry } = harness();
  view.previewLane('one', 3);
  view.finishMove('one', false);
  assert.equal(entry.preferredLane, 0);
  assert.equal(view.drag, undefined);
});

test('keyboard and mobile up button update lane and request a visible card', () => {
  const { view, entry } = harness();
  view.stepLane('one', 1);
  assert.equal(entry.preferredLane, 1);
  assert.equal(view.revealId, 'one');
});

test('fit defers bottom scrolling until the new scene height is known', () => {
  const { view } = harness();
  view.fit();
  assert.equal(view.scroll.scrollTop, 17);
  assert.equal(view.scrollToBottom, true);
});

test('UI zoom retains the calendar coordinate beneath the requested pointer ratio', () => {
  const { view } = harness();
  const before = xToDate(200, view.range, 800);
  view.zoom(2, 0.25);
  assert.equal(xToDate(200, view.range, 800), before);
});

test('zoom-out limit allows the complete fitted view on a narrow mobile viewport', () => {
  const { view, plugin } = harness();
  view.scroll.clientWidth = 375;
  plugin.records.set('two', { effectiveDate: { coordinate: 43200000 + 20 * 86400000 } });
  view.fit();
  assert.ok(view.range.end - view.range.start <= view.maximumSpan());
});

test('vertical projection uses viewport height while lanes extend right from the fixed axis', () => {
  const { view, plugin } = harness();
  plugin.store.state.timeline.orientation = 'vertical';
  const input = [{ id: 'one', coordinate: 43200000, preferredLane: 0, width: 300, height: 150 }];
  const layout = view.layout(input);
  assert.equal(view.extent, 600);
  assert.equal(layout.height, 600);
  assert.equal(layout.items[0].x, 24);
  assert.equal(layout.items[0].y + 75, dateToX(43200000, view.range, 600));
  assert.ok(layout.width >= layout.items[0].x + layout.items[0].width);
  view.stepLane('one', 1);
  assert.equal(plugin.store.state.timeline.entries[0].preferredLane, 1);
  assert.equal(view.revealId, 'one');
});

test('reverse UI zoom preserves the time under the pointer in both orientations', () => {
  for (const orientation of ['horizontal', 'vertical']) {
    const { view, plugin } = harness();
    plugin.store.state.timeline.orientation = orientation;
    plugin.store.state.timeline.reverse = true;
    const extent = orientation === 'vertical' ? view.scroll.clientHeight : view.scroll.clientWidth;
    const pointer = extent * 0.2;
    const before = xToDate(pointer, view.range, extent, true);
    view.zoom(2, 0.2);
    assert.ok(Math.abs(xToDate(pointer, view.range, extent, true) - before) < 1);
  }
});

test('reverse vertical layout changes y projection without rewriting source dates or lane preference', () => {
  const { view, plugin } = harness();
  plugin.store.state.timeline.orientation = 'vertical';
  const input = [{ id: 'one', coordinate: 21600000, preferredLane: 1, width: 300, height: 150 }];
  const forward = view.layout(input).items[0];
  plugin.store.state.timeline.reverse = true;
  const reverse = view.layout(input).items[0];
  assert.equal(reverse.x, forward.x);
  assert.equal(reverse.y + forward.y + forward.height, view.scroll.clientHeight);
  assert.equal(reverse.coordinate, input[0].coordinate);
  assert.equal(reverse.preferredLane, 1);
  assert.equal(input[0].coordinate, 21600000);
});

test('vertical fit uses measured card heights and the vertical extent for its zoom limit', () => {
  const { view, plugin } = harness();
  plugin.store.state.timeline.orientation = 'vertical';
  view.scroll.clientWidth = 1000;
  view.scroll.clientHeight = 375;
  view.heights.set('one:true', 343);
  plugin.records.set('two', { effectiveDate: { coordinate: 43200000 + 20 * 86400000 } });
  const expected = fitRange([43200000, 43200000 + 20 * 86400000], 375, 343);
  view.fit();
  assert.deepEqual(view.range, expected);
  assert.ok(view.range.end - view.range.start <= view.maximumSpan());
  assert.equal(view.scroll.scrollLeft, 0);
  assert.equal(view.scrollToBottom, true);
});

test('orientation changes keep the calendar window while resetting cross-axis camera and drag state', () => {
  const { view, plugin, reports } = harness();
  const before = { start: view.range.start, end: view.range.end };
  plugin.store.state.timeline.viewport.scrollLeft = 80;
  view.orientation = { value: 'vertical' };
  view.initializedScroll = true;
  view.drag = { id: 'one', lane: 4 };
  view.changeOrientation();
  assert.equal(view.vertical, true);
  assert.equal(plugin.store.state.timeline.viewport.scrollTop, 0);
  assert.equal(plugin.store.state.timeline.viewport.scrollLeft, 0);
  assert.equal(plugin.store.state.timeline.viewport.start, before.start);
  assert.equal(plugin.store.state.timeline.viewport.end, before.end);
  assert.equal(view.initializedScroll, false);
  assert.equal(view.drag, undefined);
  assert.equal(reports.length, 0);
  view.orientation.value = 'horizontal';
  view.changeOrientation();
  assert.equal(view.vertical, false);
  assert.equal(view.range.start, before.start);
  assert.equal(view.range.end, before.end);
});

test('a later file request wins when a previous load is still detaching its old session', async () => {
  const { view, owner, plugin } = harness();
  let releaseOld;
  const oldRelease = new Promise(resolve => { releaseOld = resolve; });
  const previousFile = { path: 'previous.timeline' };
  const firstFile = { path: 'first.timeline' };
  const latestFile = { path: 'latest.timeline' };
  const mounted = [];
  const session = file => ({ file, store: { state: createDefaultState() }, refreshAll() {} });
  owner.acquireSession = async file => session(file);
  owner.releaseSession = async current => { if (current === plugin) await oldRelease; };
  view.contentEl = { empty() {}, win: { cancelAnimationFrame() {} } };
  view.boundFile = previousFile;
  view.mount = () => { mounted.push(view.file.path); };
  const firstLoad = view.onLoadFile(firstFile);
  const latestLoad = view.onLoadFile(latestFile);
  await latestLoad;
  releaseOld();
  await firstLoad;
  assert.equal(view.file.path, latestFile.path);
  assert.equal(view.plugin.file.path, latestFile.path);
  assert.deepEqual(mounted, [latestFile.path]);
});

function focusedRenderHarness() {
  const current = harness();
  const { view, plugin } = current;
  const nothing = () => {};
  const geometry = new Map();
  let unloaded = false;
  let removed = false;
  const focusedCard = {
    element: {
      contains: () => true,
      ownerDocument: { activeElement: {} },
      remove() { removed = true; },
      style: { setProperty(name, value) { geometry.set(name, value); } },
      toggleClass: nothing,
    },
    update: nothing,
  };
  view.cards.set('one', focusedCard);
  view.removeChild = child => { assert.equal(child, focusedCard); unloaded = true; };
  view.closed = false;
  view.seenExternal = 0;
  plugin.externalRevision = 0;
  plugin.entry = id => plugin.store.state.timeline.entries.find(entry => entry.entryId === id);
  plugin.store.status = 'saved';
  plugin.store.error = '';
  view.renderProblems = nothing;
  view.contentEl = {
    toggleClass: nothing,
    ownerDocument: { createElementNS: () => ({ setAttribute: nothing, classList: { add: nothing } }) },
  };
  view.scene = { style: { setProperty: nothing }, querySelector: () => ({ remove: nothing }) };
  view.lines = { replaceChildren: nothing, setAttribute: nothing, appendChild: nothing };
  view.axis = { empty: nothing, createDiv: () => ({ style: { setProperty: nothing }, toggleClass: nothing }) };
  view.orientation = {};
  view.direction = {};
  view.status = { setText: nothing, setAttribute: nothing, toggleClass: nothing };
  view.zoomIn = {};
  view.zoomOut = {};
  return { ...current, geometry, get unloaded() { return unloaded; }, get removed() { return removed; } };
}

test('removing a note removes its focused card rather than retaining a stale visible element', () => {
  const current = focusedRenderHarness();
  current.plugin.store.state.timeline.entries = [];
  current.plugin.records.clear();
  current.view.render();
  assert.equal(current.view.cards.has('one'), false);
  assert.equal(current.unloaded, true);
  assert.equal(current.removed, true);
});

test('invalid metadata removes a focused card and its renderer while the entry remains in the document', () => {
  const current = focusedRenderHarness();
  current.plugin.records.set('one', { entryId: 'one', error: 'Invalid source date' });
  current.view.render();
  assert.equal(current.plugin.store.state.timeline.entries.length, 1);
  assert.equal(current.view.cards.has('one'), false);
  assert.equal(current.unloaded, true);
  assert.equal(current.removed, true);
});

test('virtualization still retains a focused card for an existing valid offscreen note', () => {
  const current = focusedRenderHarness();
  current.plugin.records.set('one', { entryId: 'one', effectiveDate: { coordinate: -100 * 86400000 } });
  current.view.render();
  assert.equal(current.view.cards.has('one'), true);
  assert.equal(current.unloaded, false);
  assert.equal(current.removed, false);
});

test('panning a focused card offscreen still updates its time projection in both orientations', () => {
  for (const orientation of ['horizontal', 'vertical']) {
    const current = focusedRenderHarness();
    current.plugin.store.state.timeline.orientation = orientation;
    current.plugin.records.set('one', { entryId: 'one', effectiveDate: { coordinate: 43200000 } });
    current.view.render();
    const property = orientation === 'vertical' ? '--noteline-card-y' : '--noteline-card-x';
    const before = Number.parseFloat(current.geometry.get(property));
    assert.ok(before >= 0);
    current.view.range = { start: 10 * 86400000, end: 11 * 86400000 };
    current.view.render();
    const item = current.view.items.find(item => item.id === 'one');
    const expected = orientation === 'vertical' ? item.y : item.x;
    assert.equal(Number.parseFloat(current.geometry.get(property)), expected);
    assert.ok(expected < -500);
    assert.equal(current.view.cards.has('one'), true);
    assert.equal(current.unloaded, false);
  }
});

test('external file refresh cancels touch without flushing the old camera and clears its pending save', () => {
  const h = focusedRenderHarness();
  const canceled = [];
  const cleared = [];
  h.view.cancelTouch = persist => canceled.push(persist);
  h.view.saveTimer = 42;
  h.view.contentEl.win = { clearTimeout: id => cleared.push(id) };
  h.plugin.externalRevision = 1;
  h.plugin.store.state.timeline.viewport = { start: 86400000, end: 172800000, scrollTop: 0 };
  h.view.render();
  assert.deepEqual(canceled, [false]);
  assert.deepEqual(cleared, [42]);
  assert.equal(h.view.saveTimer, undefined);
  assert.equal(h.view.range.start, 86400000);
  assert.equal(h.view.range.end, 172800000);
});

test('a gesture end or save timer before external refresh renders cannot overwrite its new viewport', () => {
  const h = harness();
  const nextViewport = { start: 86400000, end: 172800000, scrollTop: 0 };
  h.plugin.store.state.timeline.viewport = { ...nextViewport };
  h.plugin.externalRevision = 1;
  let writes = 0;
  h.plugin.store.change = () => { writes++; };
  h.view.saveCamera();
  assert.equal(writes, 0);
  assert.deepEqual(h.plugin.store.state.timeline.viewport, nextViewport);
});
