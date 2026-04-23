import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const { state } = await import('../js/state.js');
const {
  applyViewerPreset,
  beginSeriesSelection,
  finishSeriesSelection,
  hydrateSeriesSidecars,
  hydrateSeriesStacks,
  initializeSeriesViewState,
  isSeriesSelectionCurrent,
  nudgeMprAxis,
  resetCompareViewport,
  setMprGpuEnabled,
  setMprProjection,
  setMprViewport,
  setCompareViewport,
  setAnalysis,
  setAnalysisBusy,
  setColormap,
  setClipAxis,
  setFitZoom,
  setMprPosition,
  setObliqueAngles,
  setOverlayEnabled,
  resetMprViewport,
  setSliceIndex,
  setVolumeTransfer,
  setWindowLevel,
  syncMprSliceIndex,
  syncSeriesIdxForActiveSlug,
} = await import('../js/state/viewer-commands.js');

test('setSliceIndex clamps against the active series bounds', () => {
  state.manifest = { series: [{ slug: 'cmd_slice', slices: 3 }] };
  state.seriesIdx = 0;

  assert.equal(setSliceIndex(99), 2);
  assert.equal(state.sliceIdx, 2);
  assert.equal(setSliceIndex(-5), 0);
  assert.equal(state.sliceIdx, 0);
});

test('setWindowLevel clamps to viewer-safe numeric bounds', () => {
  const next = setWindowLevel(900, -40);
  assert.deepEqual(next, { window: 512, level: 0 });
  assert.equal(state.window, 512);
  assert.equal(state.level, 0);
});

test('applyViewerPreset updates render controls in one command call', () => {
  const next = applyViewerPreset({
    lowT: 0.2,
    highT: 0.8,
    intensity: 1.1,
    clipMin: [0, 0.1, 0.2],
    clipMax: [0.9, 1, 1],
    mode: 'mip',
  });
  assert.deepEqual(next, {
    lowT: 0.2,
    highT: 0.8,
    intensity: 1.1,
    clipMin: [0, 0.1, 0.2],
    clipMax: [0.9, 1, 1],
    mode: 'mip',
  });
  assert.equal(state.renderMode, 'mip');
});

test('beginSeriesSelection resets runtime-heavy buckets and preserves request guards', () => {
  state._seriesVolumeCacheEntries = [];
  state.manifest = {
    series: [
      { slug: 'cmd_a', slices: 4 },
      { slug: 'cmd_b', slices: 8 },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 3;
  state.loaded = true;
  state.analysis = { summary: 'old' };
  state.voxels = new Uint8Array([1, 2, 3]);
  state.voxelsKey = 'old';
  state.hrVoxels = new Float32Array([0.1, 0.2]);
  state.hrKey = 'hr-old';
  state.segImgs = [{ complete: true }];
  state.symImgs = [{ complete: true }];
  state.regionImgs = [{ complete: true }];
  state.regionMeta = { legend: { 1: 'Region' } };
  state.stats = { symmetryScores: [1, 2] };
  state.fusionImgs = [{ complete: true }];
  state.fusionVoxels = new Uint8Array([9]);
  state.fusionSlug = 'peer';
  state.askHistory = [{ prompt: 'old' }];
  state.clipMin = [0.1, 0.2, 0.3];
  state.clipMax = [0.7, 0.8, 0.9];

  const next = beginSeriesSelection(1, { preserveSlice: true });

  assert.equal(next.series.slug, 'cmd_b');
  assert.equal(state.seriesIdx, 1);
  assert.equal(state.sliceIdx, 3);
  assert.equal(state.loaded, false);
  assert.equal(state.analysis, null);
  assert.equal(state.voxels, null);
  assert.equal(state.hrVoxels, null);
  assert.deepEqual(state.segImgs, []);
  assert.deepEqual(state.symImgs, []);
  assert.deepEqual(state.regionImgs, []);
  assert.equal(state.regionMeta, null);
  assert.equal(state.stats, null);
  assert.equal(state.fusionImgs, null);
  assert.equal(state.fusionVoxels, null);
  assert.equal(state.fusionSlug, null);
  assert.deepEqual(state.askHistory, []);
  assert.deepEqual(state.clipMin, [0, 0, 0]);
  assert.deepEqual(state.clipMax, [1, 1, 1]);
  assert.equal(isSeriesSelectionCurrent(next.requestId, 'cmd_b'), true);
  assert.equal(isSeriesSelectionCurrent(next.requestId, 'cmd_a'), false);
});

test('beginSeriesSelection restores warm volume caches for recently revisited series', () => {
  state._seriesVolumeCacheEntries = [];
  state.manifest = {
    series: [
      { slug: 'warm_a', width: 2, height: 2, slices: 2 },
      { slug: 'warm_b', width: 2, height: 2, slices: 2 },
    ],
  };
  state.seriesIdx = 0;
  state.useBrain = false;
  state.fusionSlug = null;
  const voxA = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const hrA = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  const segA = new Uint8Array([1, 0, 0, 2]);
  state.voxels = voxA;
  state.voxelsKey = 'old-a';
  state.hrVoxels = hrA;
  state.hrKey = 'old-hr-a';
  state.segVoxels = segA;
  state.symVoxels = null;
  state.regionVoxels = null;
  state.fusionVoxels = null;

  beginSeriesSelection(1);
  assert.equal(state.voxels, null);
  assert.equal(state.hrVoxels, null);
  const voxB = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
  state.voxels = voxB;
  state.voxelsKey = 'old-b';
  state.hrVoxels = null;
  state.hrKey = '';
  state.segVoxels = null;

  beginSeriesSelection(0);
  assert.equal(state.voxels, null, 'hr-backed warm restore should not keep the downgraded uint8 volume');
  assert.equal(state.hrVoxels, hrA);
  assert.equal(state.segVoxels, segA);
  assert.equal(state.hrKey, '0:warm_a:');
});

test('hydrateSeriesStacks and hydrateSeriesSidecars land data without finishing the load early', () => {
  hydrateSeriesStacks({
    imgs: [{ complete: true }],
    segImgs: [{ complete: true }],
  });
  hydrateSeriesSidecars({
    analysis: { summary: 'fresh' },
    regionMeta: { legend: { 1: 'Region' } },
    askHistory: [{ prompt: 'new' }],
    stats: { symmetryScores: [0.1, 0.2] },
  });

  assert.equal(state.loaded, false);
  assert.equal(state.imgs.length, 1);
  assert.equal(state.segImgs.length, 1);
  assert.equal(state.analysis.summary, 'fresh');
  assert.deepEqual(state.askHistory, [{ prompt: 'new' }]);

  finishSeriesSelection();
  assert.equal(state.loaded, true);
  assert.equal(state.threeSeriesIdx, -1);
});

test('setOverlayEnabled enforces exclusivity when requested', () => {
  state.useSeg = false;
  state.useRegions = true;

  const next = setOverlayEnabled('useSeg', true, ['useRegions']);

  assert.equal(next, true);
  assert.equal(state.useSeg, true);
  assert.equal(state.useRegions, false);
});

test('initializeSeriesViewState centers MPR state and drops unavailable overlays', () => {
  state.useBrain = true;
  state.useSeg = true;
  state.useRegions = true;
  state.useSym = true;

  const next = initializeSeriesViewState({
    width: 11,
    height: 9,
    slices: 7,
    hasBrain: false,
    hasSeg: true,
    hasRegions: false,
    hasSym: false,
  });

  assert.deepEqual(next, {
    mprX: 5,
    mprY: 4,
    mprZ: 3,
    useBrain: false,
    useSeg: true,
    useRegions: false,
    useSym: false,
  });
  assert.deepEqual(state.mpr.viewports, {
    ax: { zoom: 1, tx: 0, ty: 0 },
    co: { zoom: 1, tx: 0, ty: 0 },
    sa: { zoom: 1, tx: 0, ty: 0 },
    ob: { zoom: 1, tx: 0, ty: 0 },
  });
});

test('setMprPosition clamps to series bounds and can sync the slice index', () => {
  state.manifest = { series: [{ slug: 'mpr_cmd', width: 8, height: 6, slices: 5 }] };
  state.seriesIdx = 0;
  state.sliceIdx = 1;

  const next = setMprPosition({ x: 99, y: -5, z: 7 }, undefined, { syncSlice: true });

  assert.deepEqual(next, { mprX: 7, mprY: 0, mprZ: 4, sliceIdx: 4 });
  assert.equal(state.sliceIdx, 4);
});

test('syncMprSliceIndex and nudgeMprAxis keep MPR navigation consistent', () => {
  state.manifest = { series: [{ slug: 'mpr_nav', width: 10, height: 12, slices: 9 }] };
  state.seriesIdx = 0;
  state.mprX = 5;
  state.mprY = 6;
  state.mprZ = 2;
  state.sliceIdx = 8;

  syncMprSliceIndex();
  assert.equal(state.mprZ, 8);

  nudgeMprAxis('y', -20);
  assert.equal(state.mprY, 0);

  nudgeMprAxis('z', -3);
  assert.equal(state.mprZ, 5);
  assert.equal(state.sliceIdx, 5);
});

test('setObliqueAngles and transfer controls update viewer session state in one place', () => {
  assert.deepEqual(setObliqueAngles({ yaw: 12, pitch: 34 }), { obYaw: 12, obPitch: 34 });
  assert.equal(setMprGpuEnabled(true), true);
  assert.deepEqual(setMprProjection({ mode: 'mip', slabThicknessMm: 12 }), {
    mode: 'mip',
    slabThicknessMm: 12,
  });
  assert.deepEqual(setVolumeTransfer({ lowT: 0.15, highT: 0.9, intensity: 1.4 }), {
    lowT: 0.15,
    highT: 0.9,
    intensity: 1.4,
  });
});

test('setMprViewport clamps and resets per-pane viewport state', () => {
  assert.deepEqual(setMprViewport('ob', { zoom: 99, tx: 12, ty: -4 }), {
    zoom: 8,
    tx: 12,
    ty: -4,
  });
  assert.deepEqual(resetMprViewport('ob'), {
    zoom: 1,
    tx: 0,
    ty: 0,
  });
});

test('setClipAxis preserves a minimum gap between clip bounds', () => {
  state.clipMin = [0, 0, 0];
  state.clipMax = [1, 1, 1];

  setClipAxis('min', 0, 0.995);
  setClipAxis('max', 1, 0.001);

  assert.deepEqual(state.clipMin, [0.99, 0, 0]);
  assert.deepEqual(state.clipMax, [1, 0.01, 1]);
});

test('analysis, colormap, and fit-zoom commands update viewer session state directly', () => {
  assert.equal(setAnalysisBusy(true), true);
  assert.deepEqual(setAnalysis({ summary: 'fresh' }), { summary: 'fresh' });
  assert.equal(setColormap('hot'), 'hot');
  assert.deepEqual(setFitZoom(0.1), { zoom: 0.25, tx: 0, ty: 0 });
});

test('syncSeriesIdxForActiveSlug keeps the active series stable through sidebar sort operations', () => {
  const manifest = {
    series: [
      { slug: 'c' },
      { slug: 'a' },
      { slug: 'b' },
    ],
  };
  state.manifest = manifest;
  state.seriesIdx = 2;
  manifest.series.sort((a, b) => a.slug.localeCompare(b.slug));

  const nextIdx = syncSeriesIdxForActiveSlug(manifest, 'b');

  assert.equal(nextIdx, 1);
  assert.equal(state.seriesIdx, 1);
});

test('setCompareViewport clamps and resets the linked compare viewport', () => {
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };

  assert.deepEqual(setCompareViewport({ zoom: 20, tx: 14, ty: -9 }), { zoom: 8, tx: 14, ty: -9 });
  assert.deepEqual(state.compare.viewport, { zoom: 8, tx: 14, ty: -9 });
  assert.deepEqual(resetCompareViewport(), { zoom: 1, tx: 0, ty: 0 });
});
