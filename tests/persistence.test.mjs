import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/services/persistence.ts';

test('serialized snapshots preserve edits made while a save is in flight', async () => {
  const writes = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = new StateStore(async state => { writes.push(state); if (writes.length === 1) await gate; }, () => {});
  store.change(state => { state.settings.dateProperties = ['first']; });
  store.change(state => { state.settings.dateProperties = ['second']; });
  release();
  await store.flush();
  assert.equal(store.status, 'saved');
  assert.deepEqual(writes.map(state => state.settings.dateProperties), [['first'], ['second']]);
});

test('failed save retains changes and can be retried', async () => {
  let fail = true;
  const writes = [];
  const store = new StateStore(async state => { if (fail) throw new Error('disk'); writes.push(state); }, () => {});
  store.change(state => { state.settings.dateProperties = ['date']; });
  await store.flush();
  assert.equal(store.status, 'error');
  fail = false;
  await store.flush();
  assert.equal(store.status, 'saved');
  assert.deepEqual(writes[0].settings.dateProperties, ['date']);
});

test('external conflict prevents further overwrites', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = new StateStore(async () => gate, () => {});
  store.change(state => { state.settings.dateProperties = ['local']; });
  await store.external(null);
  assert.equal(store.status, 'conflict');
  assert.throws(() => store.change(() => {}));
  release();
  await store.flush();
  assert.equal(store.status, 'conflict');
});

test('invalid persisted data is preserved by entering read only mode', () => {
  const store = new StateStore(async () => { assert.fail('must not write'); }, () => {});
  store.load({ schemaVersion: 999 });
  assert.equal(store.status, 'readonly');
  assert.throws(() => store.change(() => {}));
});

test('shutdown blocks new mutations while draining the latest queued snapshot', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const store = new StateStore(async state => { writes.push(state); if (writes.length === 1) await gate; }, () => {});
  store.change(state => { state.settings.dateProperties = ['first']; });
  store.change(state => { state.settings.dateProperties = ['latest']; });
  store.dispose();
  assert.throws(() => store.change(() => {}));
  release();
  await store.flush();
  assert.deepEqual(writes.map(state => state.settings.dateProperties), [['first'], ['latest']]);
  assert.equal(store.status, 'saved');
});
