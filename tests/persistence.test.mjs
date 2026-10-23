import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/services/persistence.ts';
import { createDefaultState } from '../src/domain/state.ts';

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

test('explicit reload discards a failed dirty revision and never writes the replaced state', async () => {
  const attempted = [];
  let fail = true;
  const store = new StateStore(async state => {
    attempted.push(structuredClone(state));
    if (fail) throw new Error('Controlled disk failure');
  }, () => {});
  store.change(state => { state.settings.dateProperties = ['abandoned-local']; });
  await store.flush();
  assert.equal(store.status, 'error');
  const reloaded = createDefaultState();
  reloaded.settings.dateProperties = ['external'];
  store.load(reloaded);
  fail = false;
  await store.flush();
  assert.equal(store.status, 'saved');
  assert.equal(attempted.length, 1);
  assert.deepEqual(store.state.settings.dateProperties, ['external']);
  store.change(state => { state.timeline.orientation = 'vertical'; });
  await store.flush();
  assert.equal(attempted.length, 2);
  assert.deepEqual(attempted[1].settings.dateProperties, ['external']);
  assert.equal(attempted[1].timeline.orientation, 'vertical');
});

test('a named file conflict blocks retries and further writes until explicit reload', async () => {
  let attempts = 0;
  let conflict = true;
  const store = new StateStore(async () => {
    attempts += 1;
    if (conflict) {
      const error = new Error('Controlled external document change');
      error.name = 'TimelineConflictError';
      throw error;
    }
  }, () => {});
  store.change(state => { state.timeline.reverse = true; });
  await store.flush();
  assert.equal(store.status, 'conflict');
  assert.equal(store.writable, false);
  assert.throws(() => store.change(() => {}), /Controlled external/);
  conflict = false;
  await store.flush();
  assert.equal(attempts, 1);
  assert.equal(store.status, 'conflict');
  store.load(createDefaultState());
  store.change(state => { state.timeline.reverse = false; });
  await store.flush();
  assert.equal(attempts, 2);
  assert.equal(store.status, 'saved');
});

test('an invalid load remains read only if a previous in-flight write later fails', async () => {
  let reject;
  const gate = new Promise((_resolve, rejectWrite) => { reject = rejectWrite; });
  let attempts = 0;
  const store = new StateStore(async () => { attempts += 1; await gate; }, () => {});
  store.change(state => { state.settings.dateProperties = ['old-local']; });
  store.load({ schemaVersion: 999 });
  assert.equal(store.status, 'readonly');
  reject(new Error('Late failure of the old write'));
  await store.flush();
  assert.equal(store.status, 'readonly');
  assert.equal(store.writable, false);
  assert.throws(() => store.change(() => {}));
  assert.equal(attempts, 1);
});

test('loading a new document while an old write is pending never marks fresh edits as saved', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const store = new StateStore(async state => {
    writes.push(structuredClone(state));
    if (writes.length === 1) await gate;
  }, () => {});
  store.change(state => { state.settings.dateProperties = ['old-local']; });
  store.load({ schemaVersion: 999 });
  const reloaded = createDefaultState();
  reloaded.settings.dateProperties = ['external'];
  store.load(reloaded);
  store.change(state => { state.settings.dateProperties = ['fresh-local']; });
  release();
  await store.flush();
  assert.deepEqual(writes.map(state => state.settings.dateProperties), [['old-local'], ['fresh-local']]);
  assert.equal(store.status, 'saved');
  assert.deepEqual(store.state.settings.dateProperties, ['fresh-local']);
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
