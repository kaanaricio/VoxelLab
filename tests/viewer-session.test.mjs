import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const { state } = await import('../js/state.js');
const {
  beginViewerRuntimeSession,
  resetViewerRuntimeSession,
  syncViewerRuntimeSession,
} = await import('../js/runtime/viewer-session.js');
const { RUNTIME_OVERLAY_KIND_BY_TYPE } = await import('../js/runtime/viewer-session-shape.js');

function setSeriesState({
  slug = 'viewer_session_case',
  width = 4,
  height = 4,
  slices = 3,
  hasRaw = false,
  hasSeg = false,
  hasRegions = false,
  hasSym = false,
} = {}) {
  // Shape: one active series with current overlay availability flags.
  state.manifest = {
    series: [{ slug, width, height, slices, hasRaw, hasSeg, hasRegions, hasSym }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 1;
  state.imgs = [];
  state.voxels = null;
  state.hrVoxels = null;
  state.segVoxels = null;
  state.regionVoxels = null;
  state.regionMeta = null;
  state.symVoxels = null;
  state.fusionSlug = '';
  state.fusionVoxels = null;
  state.useSeg = false;
  state.useRegions = false;
  state.useSym = false;
  state.threeRuntime.seriesIdx = -1;
  state.threeRuntime.mesh = null;
}

test('viewer runtime session tracks progressive readiness stages', () => {
  setSeriesState({ slug: 'runtime_progression', hasRaw: true, hasSeg: true, hasRegions: true, hasSym: true });
  state.useSeg = true;
  state.useRegions = true;
  state.useSym = true;
  state.fusionSlug = 'peer_series';

  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 7 });
  assert.equal(state.viewerSession.readiness.stage, 'idle');

  state.imgs = [{ complete: false, naturalWidth: 0 }, { complete: true, naturalWidth: 4 }];
  syncViewerRuntimeSession();
  assert.equal(state.viewerSession.readiness.stage, 'first-slice');

  state.voxels = new Uint8Array(4 * 4 * 3);
  syncViewerRuntimeSession();
  assert.equal(state.viewerSession.readiness.stage, 'orthogonal-ready');

  state.segVoxels = new Uint8Array(4 * 4 * 3);
  state.regionVoxels = new Uint8Array(4 * 4 * 3);
  state.regionMeta = { colors: {}, legend: {} };
  state.symVoxels = new Uint8Array(4 * 4 * 3);
  state.fusionVoxels = new Uint8Array(4 * 4 * 3);
  syncViewerRuntimeSession();
  assert.equal(state.viewerSession.readiness.stage, 'overlay-ready');

  state.hrVoxels = new Float32Array(4 * 4 * 3);
  syncViewerRuntimeSession();
  assert.equal(state.viewerSession.readiness.stage, 'quality-ready');

  state.threeRuntime.seriesIdx = 0;
  state.threeRuntime.mesh = {};
  syncViewerRuntimeSession();
  assert.equal(state.viewerSession.readiness.stage, '3d-ready');
  assert.equal(state.viewerSession.baseSource, 'raw');
});

test('viewer runtime session exposes canonical overlay kinds without changing legacy flags', () => {
  setSeriesState({ slug: 'overlay_kinds', hasSeg: true, hasRegions: true, hasSym: true });
  state.useSeg = true;
  state.useRegions = true;
  state.fusionSlug = 'peer';

  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 8 });
  const session = syncViewerRuntimeSession();

  assert.equal(RUNTIME_OVERLAY_KIND_BY_TYPE.seg, 'tissue');
  assert.equal(RUNTIME_OVERLAY_KIND_BY_TYPE.regions, 'labels');
  assert.equal(RUNTIME_OVERLAY_KIND_BY_TYPE.sym, 'heatmap');
  assert.deepEqual(session.overlayKinds, {
    tissue: { available: true, enabled: true, ready: false, sourceType: 'seg' },
    labels: { available: true, enabled: true, ready: false, sourceType: 'regions' },
    heatmap: { available: true, enabled: false, ready: false, sourceType: 'sym' },
    fusion: { available: true, enabled: true, ready: false, sourceType: 'fusion' },
  });
});

test('viewer runtime session does not report 3d-ready while enabled overlays are still warming', () => {
  setSeriesState({ slug: 'three_overlay_wait', hasRegions: true });
  state.useRegions = true;
  state.voxels = new Uint8Array(4 * 4 * 3);
  state.threeRuntime.seriesIdx = 0;
  state.threeRuntime.mesh = {};

  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 10 });
  syncViewerRuntimeSession();

  assert.equal(state.viewerSession.readiness.threeReady, true);
  assert.notEqual(state.viewerSession.readiness.stage, '3d-ready');
  assert.equal(state.viewerSession.readiness.stage, 'quality-ready');
});

test('viewer runtime session reset clears the active selection state', () => {
  setSeriesState({ slug: 'reset_session' });
  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 9 });

  resetViewerRuntimeSession();

  assert.deepEqual(state.viewerSession, {
    slug: '',
    seriesIdx: -1,
    requestId: 0,
    baseSource: '',
    firstSliceIdx: -1,
    overlayKinds: {
      tissue: { available: false, enabled: false, ready: false, sourceType: 'seg' },
      labels: { available: false, enabled: false, ready: false, sourceType: 'regions' },
      heatmap: { available: false, enabled: false, ready: false, sourceType: 'sym' },
      fusion: { available: false, enabled: false, ready: false, sourceType: 'fusion' },
    },
    overlaySession: {
      tissue: {
        available: false, enabled: false, currentSliceReady: false, volumeReady: false,
        metaReady: false, blockingReason: '', sourceType: 'seg',
      },
      labels: {
        available: false, enabled: false, currentSliceReady: false, volumeReady: false,
        metaReady: false, blockingReason: '', sourceType: 'regions',
      },
      heatmap: {
        available: false, enabled: false, currentSliceReady: false, volumeReady: false,
        metaReady: false, blockingReason: '', sourceType: 'sym',
      },
      fusion: {
        available: false, enabled: false, currentSliceReady: false, volumeReady: false,
        metaReady: false, blockingReason: '', sourceType: 'fusion',
      },
    },
    readiness: {
      stage: 'idle',
      firstSlice: false,
      baseVolume: false,
      orthogonalReady: false,
      overlayReady: false,
      qualityReady: false,
      threeReady: false,
      sliceReady: false,
      mprReady: false,
      twoDReady: false,
      compareReady: false,
    },
  });
});
