import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const {
  state,
  subscribe,
  batch,
  getStateSnapshot,
  setPassthroughRootEntry,
} = await import('../js/state.js');
const { ensureVoxels } = await import('../js/volume-voxels-ensure.js');

test('batch coalesces repeated writes into one notification with the final value', () => {
  const seen = [];
  const unsubscribe = subscribe('sliceIdx', (value) => seen.push(value));

  batch(() => {
    state.sliceIdx = 3;
    state.sliceIdx = 8;
  });

  unsubscribe();
  assert.deepEqual(seen, [8]);
  assert.equal(state.sliceIdx, 8);
});

test('legacy aliases and grouped fields stay in sync for nested state', () => {
  const seen = [];
  const unsubscribeLow = subscribe('lowT', (value) => seen.push(['lowT', value]));
  const unsubscribeGroup = subscribe('three.lowT', (value) => seen.push(['three.lowT', value]));
  const unsubscribeClip = subscribe('clipMin', (value) => seen.push(['clipMin', [...value]]));

  batch(() => {
    state.lowT = 0.24;
    state.three.clipMin = [0.1, 0.2, 0.3];
  });

  unsubscribeLow();
  unsubscribeGroup();
  unsubscribeClip();

  assert.equal(state.lowT, 0.24);
  assert.equal(state.three.lowT, 0.24);
  assert.deepEqual(state.clipMin, [0.1, 0.2, 0.3]);
  assert.deepEqual(state.three.clipMin, [0.1, 0.2, 0.3]);
  assert.deepEqual(seen.sort((a, b) => a[0].localeCompare(b[0])), [
    ['clipMin', [0.1, 0.2, 0.3]],
    ['lowT', 0.24],
    ['three.lowT', 0.24],
  ]);
});

test('nested alias writes notify root subscribers', () => {
  state.clipMax = [1, 1, 1];
  const seen = [];
  const unsubscribeAlias = subscribe('clipMax', (value) => seen.push(['clipMax', [...value]]));
  const unsubscribeGroup = subscribe('three.clipMax', (value) => seen.push(['three.clipMax', [...value]]));

  state.clipMax[2] = 0.42;

  unsubscribeAlias();
  unsubscribeGroup();

  assert.deepEqual(seen.sort((a, b) => a[0].localeCompare(b[0])), [
    ['clipMax', [1, 1, 0.42]],
    ['three.clipMax', [1, 1, 0.42]],
  ]);
});

test('state exposes explicit collection and tool defaults without lazy module init', () => {
  const snapshot = getStateSnapshot();

  assert.ok(Object.hasOwn(snapshot, 'measurements'));
  assert.ok(Object.hasOwn(snapshot, 'angleMeasurements'));
  assert.ok(Object.hasOwn(snapshot, 'anglePending'));
  assert.ok(Object.hasOwn(snapshot, 'angleMode'));
  assert.ok(Object.hasOwn(snapshot, 'hiddenLabels'));
  assert.ok(Object.hasOwn(snapshot, 'viewerSession'));
  assert.deepEqual(snapshot.measurements, {});
  assert.deepEqual(snapshot.angleMeasurements, {});
  assert.equal(snapshot.anglePending, null);
  assert.equal(snapshot.angleMode, false);
  assert.deepEqual(snapshot.hiddenLabels, []);
  assert.equal(snapshot.mpr.gpuEnabled, true);
});

test('passthrough compare stack writes notify root subscribers', () => {
  state.cmpStacks = {};
  const seen = [];
  const offCmp = subscribe('cmpStacks', (value) => seen.push(['cmpStacks', value.peer?.length || 0]));

  setPassthroughRootEntry('cmpStacks', 'peer', [{ complete: true, naturalWidth: 4 }]);

  offCmp();

  assert.deepEqual(seen, [['cmpStacks', 1]]);
});

test('nested measurement writes notify root subscribers', () => {
  state.measurements = { 'series|0': [] };
  const seen = [];
  const offMeasure = subscribe('measurements', (value) => seen.push(['measurements', value['series|0'].map((item) => item.mm)]));

  state.measurements['series|0'].push({ mm: 12.5 });

  offMeasure();

  assert.deepEqual(seen, [['measurements', [12.5]]]);
});

test('nested angle writes notify root subscribers', () => {
  state.angleMeasurements = { 'series|0': [] };
  const seen = [];
  const offAngle = subscribe('angleMeasurements', (value) => seen.push(['angleMeasurements', value['series|0'].map((item) => item.deg)]));

  state.angleMeasurements['series|0'].push({ deg: 33.5 });

  offAngle();

  assert.deepEqual(seen, [['angleMeasurements', [33.5]]]);
});

test('state snapshots are deeply frozen for plugin consumers', () => {
  const snapshot = getStateSnapshot();

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.mpr), true);
  assert.equal(Object.isFrozen(snapshot.three.clipMin), true);
  assert.throws(() => {
    snapshot.sliceIdx = 99;
  });
});

test('state snapshots do not recurse into cyclic runtime objects', () => {
  const runtime = { label: 'renderer' };
  runtime.self = runtime;
  state.threeRuntime.renderer = runtime;
  state.threeRuntime.mesh = { owner: runtime };
  state.voxels = new Uint8Array([1, 2, 3]);

  const snapshot = getStateSnapshot();

  assert.equal('renderer' in snapshot.three, false);
  assert.equal('mesh' in snapshot.three, false);
  assert.deepEqual(snapshot.voxels, { type: 'Uint8Array', length: 3 });
});

test('cached base voxels can still hydrate overlay volumes later', () => {
  state.manifest = {
    series: [{
      slug: 'local_overlay_case',
      width: 2,
      height: 2,
      slices: 2,
      hasSeg: false,
      hasRegions: true,
    }],
  };
  state.seriesIdx = 0;
  state.useBrain = false;
  state.useRegions = false;
  state.regionVoxels = null;
  state.voxels = null;
  state.voxelsKey = '';
  state._localRawVolumes = {
    local_overlay_case: new Float32Array([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]),
  };
  state._localRegionLabelSlicesBySlug = {
    local_overlay_case: [
      new Uint8Array([1, 0, 2, 0]),
      new Uint8Array([0, 3, 0, 4]),
    ],
  };

  assert.equal(ensureVoxels(), true);
  assert.equal(state.regionVoxels, null);

  state.useRegions = true;
  assert.equal(ensureVoxels(), true);
  assert.deepEqual([...state.regionVoxels], [1, 0, 2, 0, 0, 3, 0, 4]);
});
