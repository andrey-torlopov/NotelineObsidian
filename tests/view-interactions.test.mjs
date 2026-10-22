import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { layoutCards, xToDate } from '../src/domain/timeline.ts';
import { createDefaultState } from '../src/domain/state.ts';

const moduleUrl = code => `data:text/javascript,${encodeURIComponent(code)}`;
const obsidian = moduleUrl(`
  export class Component {}
  export class ItemView { constructor(leaf) { this.leaf = leaf; } }
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
  const plugin = {
    store: { state, writable: true },
    records: new Map([['one', { effectiveDate: { coordinate: 43200000 } }]]),
    updateEntry(id, update) { update(state.timeline.entries.find(item => item.entryId === id)); },
  };
  const view = new TimelineView({}, plugin);
  view.scroll = { clientWidth: 800, scrollTop: 17, scrollHeight: 1000 };
  view.items = layoutCards([{ id: 'one', coordinate: 43200000, preferredLane: 0, width: 300, height: 150 }], state.timeline.viewport, 800).items;
  return { view, plugin, entry: state.timeline.entries[0] };
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
