import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTimelineTouch } from '../src/ui/timeline-touch.ts';

function harness({ vertical = false, reverse = false, extent = 800 } = {}) {
  const document = {};
  const listeners = [];
  const cleanups = [];
  const applied = [];
  let finished = 0;
  const camera = { range: { start: 0, end: 86_400_000 }, vertical, reverse, extent };
  const owner = {
    registerDomEvent(target, type, callback, options) { listeners.push({ target, type, callback, options }); },
    register(callback) { cleanups.push(callback); },
  };
  const classes = new Set();
  const captured = new Set();
  const field = {
    ownerDocument: document,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    setPointerCapture: id => captured.add(id),
    hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id),
  };
  const axis = { ...field, classList: { add() {}, remove() {} } };
  const cancel = bindTimelineTouch(owner, [field, axis], () => camera, range => { applied.push(range); camera.range = range; }, () => { finished++; });
  function fire(target, type, values = {}) {
    const event = {
      pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, clientX: 400, clientY: 300,
      target: { closest: () => null }, detail: 1,
      prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      stopPropagation() { this.stopped = true; },
      ...values,
    };
    for (const entry of listeners) if (entry.target === target && entry.type === type) entry.callback(event);
    return event;
  }
  function down(values = {}, surface = field) { fire(document, 'pointerdown', values); return fire(surface, 'pointerdown', values); }
  return { camera, field, axis, document, classes, captured, applied, cleanups, listeners, fire, down, cancel, get finished() { return finished; } };
}

test('touch pans time in both orientations and both chronological directions', () => {
  for (const vertical of [false, true]) for (const reverse of [false, true]) {
    const h = harness({ vertical, reverse });
    h.down();
    h.fire(h.document, 'pointermove', vertical ? { clientY: 140 } : { clientX: 240 });
    assert.equal(h.applied.length, 1);
    assert.equal(h.applied[0].start, reverse ? -17_280_000 : 17_280_000);
    assert.equal(h.applied[0].end - h.applied[0].start, 86_400_000);
    assert.equal(h.captured.has(1), true);
    assert.equal(h.classes.has('is-panning'), true);
  }
});

test('panning remains anchored to the initial camera across multiple moves and final pointer position', () => {
  const h = harness();
  h.down();
  h.fire(h.document, 'pointermove', { clientX: 320 });
  h.fire(h.document, 'pointermove', { clientX: 240 });
  h.fire(h.document, 'pointerup', { clientX: 200 });
  assert.equal(h.camera.range.start, 21_600_000);
  assert.equal(h.finished, 1);
  assert.equal(h.captured.size, 0);
  assert.equal(h.classes.has('is-panning'), false);
});

test('tap and small finger jitter keep title clicks and do not change the camera', () => {
  const h = harness();
  h.down();
  h.fire(h.document, 'pointermove', { clientX: 403 });
  h.fire(h.document, 'pointerup', { clientX: 403 });
  assert.equal(h.applied.length, 0);
  assert.equal(h.finished, 0);
  assert.equal(h.fire(h.field, 'click').prevented, false);
});

test('perpendicular swipes remain native and do not start a calendar drag', () => {
  for (const vertical of [false, true]) {
    const h = harness({ vertical });
    h.down();
    const event = h.fire(h.document, 'pointermove', vertical ? { clientX: 260, clientY: 301 } : { clientY: 160, clientX: 401 });
    assert.equal(event.prevented, false);
    assert.equal(h.applied.length, 0);
    assert.equal(h.captured.size, 0);
    h.fire(h.document, 'pointercancel');
    assert.equal(h.finished, 0);
  }
});

test('expanded text, overflowing cards, controls and links retain their native interactions', () => {
  for (const excluded of ['.noteline-card-body', '.noteline-card-controls', '.noteline-card.is-overflowing', 'button:not(.noteline-card-title)', 'a', 'input', 'textarea', 'select', '[contenteditable="true"]']) {
    const h = harness();
    h.down({ target: { closest: selector => selector.split(', ').includes(excluded) ? {} : null } });
    h.fire(h.document, 'pointermove', { clientX: 200 });
    assert.equal(h.applied.length, 0, excluded);
    assert.equal(h.captured.size, 0, excluded);
  }
});

test('synthesized click after a drag is suppressed; keyboard activation and the next tap still work', () => {
  const h = harness();
  h.down();
  h.fire(h.document, 'pointermove', { clientX: 200 });
  h.fire(h.document, 'pointerup', { clientX: 200 });
  assert.equal(h.fire(h.field, 'click', { detail: 0 }).prevented, false);
  const click = h.fire(h.field, 'click');
  assert.equal(click.prevented, true);
  assert.equal(click.stopped, true);
  h.down(); h.fire(h.document, 'pointerup');
  assert.equal(h.fire(h.field, 'click').prevented, false);
});

test('second finger cancels an active drag and never reanchors to the secondary pointer', () => {
  const h = harness();
  h.down(); h.fire(h.document, 'pointermove', { clientX: 240 });
  const before = h.applied.length;
  h.down({ pointerId: 2, isPrimary: false });
  h.fire(h.document, 'pointermove', { pointerId: 2, isPrimary: false, clientX: 100 });
  h.fire(h.document, 'pointermove', { clientX: 100 });
  assert.equal(h.applied.length, before);
  assert.equal(h.captured.size, 0);
  assert.equal(h.finished, 1);
});

test('pointer cancellation, lost capture, explicit cancel and component disposal release the gesture', () => {
  for (const kind of ['pointercancel', 'lostpointercapture', 'cancel', 'dispose']) {
    const h = harness();
    h.down(); h.fire(h.document, 'pointermove', { clientX: 240 });
    if (kind === 'cancel') h.cancel();
    else if (kind === 'dispose') h.cleanups.forEach(callback => callback());
    else h.fire(kind === 'lostpointercapture' ? h.field : h.document, kind, { target: h.field });
    assert.equal(h.finished, 1, kind);
    assert.equal(h.captured.size, 0, kind);
    h.fire(h.document, 'pointermove', { clientX: 100 });
    assert.equal(h.applied.length, 1, kind);
  }
});

test('losing a child implicit capture during promotion to the field does not cancel the drag', () => {
  const h = harness();
  const title = { closest: () => null };
  h.down({ target: title });
  h.fire(h.document, 'pointermove', { clientX: 320 });
  h.fire(h.field, 'lostpointercapture', { target: title });
  assert.equal(h.finished, 0);
  assert.equal(h.captured.has(1), true);
  h.fire(h.document, 'pointermove', { clientX: 240 });
  h.fire(h.document, 'pointerup', { clientX: 200 });
  assert.equal(h.camera.range.start, 21_600_000);
  assert.equal(h.finished, 1);
});

test('external document reload can cancel without saving a stale camera into the new state', () => {
  const h = harness();
  h.down(); h.fire(h.document, 'pointermove', { clientX: 240 });
  h.cancel(false);
  assert.equal(h.finished, 0);
  assert.equal(h.captured.size, 0);
  h.fire(h.document, 'pointerup', { clientX: 100 });
  assert.equal(h.applied.length, 1);
});

test('orientation, direction or viewport size changes cancel rather than jumping with stale geometry', () => {
  for (const change of [camera => { camera.vertical = true; }, camera => { camera.reverse = true; }, camera => { camera.extent = 375; }]) {
    const h = harness();
    h.down(); h.fire(h.document, 'pointermove', { clientX: 240 });
    change(h.camera);
    h.fire(h.document, 'pointermove', { clientX: 100 });
    assert.equal(h.applied.length, 1);
    assert.equal(h.finished, 1);
  }
});

test('a canceled native pointer cannot leave a half-started custom drag', () => {
  const h = harness();
  h.field.setPointerCapture = () => { throw new Error('Pointer is no longer active'); };
  h.down(); h.fire(h.document, 'pointermove', { clientX: 240 });
  assert.equal(h.applied.length, 0);
  assert.equal(h.classes.has('is-panning'), false);
  assert.equal(h.finished, 0);
});

test('mouse input and zero-sized views do not activate touch panning', () => {
  const h = harness();
  h.down({ pointerType: 'mouse' }); h.fire(h.document, 'pointermove', { pointerType: 'mouse', clientX: 200 });
  assert.equal(h.applied.length, 0);
  h.camera.extent = 0;
  h.down(); h.fire(h.document, 'pointermove', { clientX: 200 });
  assert.equal(h.applied.length, 0);
});

test('the fixed time axis accepts swipes and touch events do not bubble into workspace navigation', () => {
  const h = harness();
  h.down({}, h.axis); h.fire(h.document, 'pointermove', { clientX: 240 });
  assert.equal(h.applied.length, 1);
  for (const surface of [h.field, h.axis]) for (const name of ['touchstart', 'touchmove', 'touchend']) {
    const event = h.fire(surface, name);
    assert.equal(event.stopped, true);
    assert.equal(event.prevented, false);
    assert.equal(h.listeners.find(item => item.target === surface && item.type === name).options.passive, true);
  }
});
