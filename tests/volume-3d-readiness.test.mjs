import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const spinner = { hidden: true };
globalThis.document = {
  getElementById(id) {
    if (id === 'viewer-spinner') return spinner;
    return null;
  },
};

const { state } = await import('../js/state.js');
const { beginViewerRuntimeSession } = await import('../js/runtime/viewer-session.js');
const { syncThreeSurfaceState } = await import('../js/runtime/three-surface-state.js');

// Flash-guard thresholds in js/spinner.js: show after 150ms, min visible 350ms.
// Tests wait past those windows to observe the steady-state spinner visibility.
const SPINNER_SETTLE_MS = 500;

test('syncThreeSurfaceState hides the spinner once the 3D surface is already visible', async () => {
  state.manifest = {
    series: [{ slug: 'three_wait', width: 2, height: 2, slices: 2, hasRegions: true }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '3d';
  state.useRegions = true;
  state.voxels = new Uint8Array(8);
  state.regionVoxels = null;
  state.regionMeta = null;
  state.threeRuntime.seriesIdx = 0;
  state.threeRuntime.mesh = {};
  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 1 });

  const status = syncThreeSurfaceState();
  await new Promise((resolve) => setTimeout(resolve, SPINNER_SETTLE_MS));

  assert.equal(status.pending, false);
  assert.equal(spinner.hidden, true);
});

test('syncThreeSurfaceState keeps the spinner visible until a 3D mesh exists', async () => {
  state.manifest = {
    series: [{ slug: 'three_boot', width: 2, height: 2, slices: 2 }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '3d';
  state.voxels = new Uint8Array(8);
  state.threeRuntime.seriesIdx = -1;
  state.threeRuntime.mesh = null;
  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 2 });

  const status = syncThreeSurfaceState();
  await new Promise((resolve) => setTimeout(resolve, SPINNER_SETTLE_MS));

  assert.equal(status.pending, true);
  assert.equal(spinner.hidden, false);
});
