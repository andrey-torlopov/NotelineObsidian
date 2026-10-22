import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultState, validateState, StateValidationError } from '../src/domain/state.ts';
import { MIN_COORDINATE, MAX_COORDINATE, MIN_SPAN } from '../src/domain/timeline.ts';

function example() {
  const state = createDefaultState();
  state.timeline.entries.push({ entryId: 'stable-1', filePath: 'Вложенные/Заметка.md', preferredLane: 2, expanded: true, fallbackDate: '2026-10-22' });
  state.timeline.viewport = { start: 0, end: 86_400_000, scrollTop: 120 };
  return state;
}

test('first install receives independent default objects', () => {
  assert.deepEqual(validateState(null), createDefaultState());
  assert.deepEqual(validateState(undefined), createDefaultState());
  const first = createDefaultState();
  first.settings.dateProperties.push('created');
  assert.deepEqual(createDefaultState().settings.dateProperties, ['timeline-date', 'date']);
});

test('state and saved fallback date survive JSON round trip and unknown fields survive validation', () => {
  const state = example();
  state.compatibleExtension = { enabled: true };
  state.settings.extension = 1;
  state.timeline.extension = ['future'];
  state.timeline.entries[0].extension = 'keep';
  state.timeline.viewport.extension = 2;
  const saved = JSON.parse(JSON.stringify(state));
  const validated = validateState(saved);
  assert.deepEqual(validated, state);
  assert.notEqual(validated.timeline.entries[0], saved.timeline.entries[0]);
  assert.notEqual(validated.settings.dateProperties, saved.settings.dateProperties);
  assert.equal(validated.timeline.entries[0].fallbackDate, '2026-10-22');
});

test('newer schema, broken shapes and duplicate entries fail without resetting data', () => {
  for (const corrupt of [false, [], {}, { schemaVersion: 2 }, { schemaVersion: 1 }, { ...example(), settings: { dateProperties: 'date' } }]) {
    assert.throws(() => validateState(corrupt), StateValidationError);
  }
  const duplicate = example();
  duplicate.timeline.entries.push({ ...duplicate.timeline.entries[0], entryId: 'other-id' });
  assert.throws(() => validateState(duplicate), /повтор/);
  duplicate.timeline.entries[1].filePath = 'Other.md';
  duplicate.timeline.entries[1].entryId = duplicate.timeline.entries[0].entryId;
  assert.throws(() => validateState(duplicate), /повтор/);
  assert.equal(duplicate.timeline.entries.length, 2);
});

test('fallback dates use strict existing calendar days across years 0001–9999', () => {
  for (const date of ['0001-01-01', '0096-02-29', '0100-02-28', '2000-02-29', '9999-12-31']) {
    const state = example();
    state.timeline.entries[0].fallbackDate = date;
    assert.equal(validateState(state).timeline.entries[0].fallbackDate, date);
  }
  for (const date of ['0000-01-01', '0099-02-29', '1900-02-29', '2026-02-30', '2026-10-22 00:00', '2026-1-1', null]) {
    const state = example();
    state.timeline.entries[0].fallbackDate = date;
    assert.throws(() => validateState(state), StateValidationError);
  }
});

test('invalid paths, lanes, settings and viewports fail explicitly', () => {
  for (const filePath of ['/outside.md', '../outside.md', 'a/../b.md', 'folder\\a.md', 'folder//a.md', 'image.png']) {
    const state = example();
    state.timeline.entries[0].filePath = filePath;
    assert.throws(() => validateState(state), StateValidationError);
  }
  for (const preferredLane of [-1, 0.5, Infinity, NaN]) {
    const state = example();
    state.timeline.entries[0].preferredLane = preferredLane;
    assert.throws(() => validateState(state), StateValidationError);
  }
  for (const viewport of [
    { start: 0, end: 1, scrollTop: 0 },
    { start: MIN_COORDINATE - 1, end: 0, scrollTop: 0 },
    { start: 0, end: MAX_COORDINATE + 1, scrollTop: 0 },
    { start: 0, end: MIN_SPAN, scrollTop: -1 },
    { start: 0, end: MIN_SPAN, scrollTop: NaN },
  ]) {
    const state = example();
    state.timeline.viewport = viewport;
    assert.throws(() => validateState(state), StateValidationError);
  }
  const duplicateProperties = example();
  duplicateProperties.settings.dateProperties = ['date', 'date'];
  assert.throws(() => validateState(duplicateProperties), StateValidationError);
});
