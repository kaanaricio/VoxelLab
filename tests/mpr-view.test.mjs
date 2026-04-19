import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');
globalThis.window = globalThis.window || { addEventListener() {} };
const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const { state } = await import('../js/state.js');
const { setNoteEntriesForSlice } = await import('../js/annotation-graph.js');
const {
  initMprView,
  hasMprBaseVolume,
  drawMPR,
  drawMPRInteractive,
  beginMprInteraction,
  beginObliqueInteraction,
  clearMprCellCache,
  getMprCellCacheStats,
  getMprVolumeReadiness,
} = await import('../js/mpr-view.js');

function createCanvas(width, height) {
  const context = {
    puts: 0,
    arcs: 0,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => { context.puts += 1; },
    save() {},
    restore() {},
    beginPath() {},
    arc: () => { context.arcs += 1; },
    fill() {},
    stroke() {},
  };
  return {
    width,
    height,
    style: {},
    parentElement: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width, height, right: width, bottom: height }),
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height, right: width, bottom: height }),
    getContext: () => context,
  };
}

function createCrosshairOverlay() {
  const style = {
    left: '',
    top: '',
    width: '',
    height: '',
    setProperty(name, value) { style[name] = value; },
  };
  return {
    _mprBoundsReady: false,
    style,
  };
}

function installMprDom(width, height) {
  const registry = new Map();
  // Shape: mpr-* canvas nodes with tiny 2D context stub used by drawMPR.
  registry.set('mpr-ax', createCanvas(width, height));
  registry.set('mpr-co', createCanvas(width, height));
  registry.set('mpr-sa', createCanvas(height, height));
  registry.set('mpr-ax-cross', createCrosshairOverlay());
  registry.set('mpr-co-cross', createCrosshairOverlay());
  registry.set('mpr-sa-cross', createCrosshairOverlay());
  // Shape: simple text labels, e.g. "X 4/8", "Y 3/6", "Z 7/32".
  registry.set('mpr-ax-idx', { textContent: '' });
  registry.set('mpr-co-idx', { textContent: '' });
  registry.set('mpr-sa-idx', { textContent: '' });
  globalThis.document = {
    getElementById(id) {
      return registry.get(id) || null;
    },
  };
}

function setSeriesState({ slug = 'mpr_case', width = 8, height = 6, slices = 5 } = {}) {
  const voxelCount = width * height * slices;
  // Shape: active manifest with one MPR-capable series.
  state.manifest = {
    series: [{ slug, width, height, slices, rowSpacing: 1, colSpacing: 1, sliceSpacing: 1 }],
  };
  state.seriesIdx = 0;
  state.mode = 'mpr';
  state.sliceIdx = 0;
  state.loaded = true;
  state.mprX = Math.floor(width / 2);
  state.mprY = Math.floor(height / 2);
  state.mprZ = Math.floor(slices / 2);
  state.mprQuality = 'quality';
  state.mpr.projectionMode = 'thin';
  state.mpr.slabThicknessMm = 0;
  state.mpr.viewports = {
    ax: { zoom: 1, tx: 0, ty: 0 },
    co: { zoom: 1, tx: 0, ty: 0 },
    sa: { zoom: 1, tx: 0, ty: 0 },
    ob: { zoom: 1, tx: 0, ty: 0 },
  };
  state.window = 120;
  state.level = 60;
  state.colormap = 'gray';
  state.overlayOpacity = 0.5;
  state.fusionOpacity = 0.5;
  state.obYaw = 0;
  state.obPitch = 0;
  state.useSeg = false;
  state.useRegions = false;
  state.useSym = false;
  state.fusionSlug = '';
  state.segVoxels = null;
  state.regionVoxels = null;
  state.regionMeta = null;
  state.symVoxels = null;
  state.fusionVoxels = null;
  state.hrVoxels = new Float32Array(voxelCount).fill(0.4);
  state.voxels = null;
}

test('hasMprBaseVolume accepts cloud raw voxels without PNG-derived voxels', () => {
  state.manifest = {
    series: [{ slug: 'cloud_mpr', width: 2, height: 2, slices: 2 }],
  };
  state.seriesIdx = 0;
  state.voxels = null;
  state.hrVoxels = new Float32Array(8);

  assert.equal(hasMprBaseVolume(), true);
});

test('hasMprBaseVolume rejects incomplete base volumes', () => {
  state.manifest = {
    series: [{ slug: 'partial_mpr', width: 2, height: 2, slices: 2 }],
  };
  state.seriesIdx = 0;
  state.hrVoxels = new Float32Array(7);
  state.voxels = new Uint8Array(7);

  assert.equal(hasMprBaseVolume(), false);
});

test('drawMPR readiness uses ensureVoxels only when base volume is missing', () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'readiness' });
  let ensureCalls = 0;
  initMprView({
    ensureVoxels: () => {
      ensureCalls += 1;
      const series = state.manifest.series[state.seriesIdx];
      const voxelCount = series.width * series.height * series.slices;
      state.voxels = new Uint8Array(voxelCount).fill(88);
      return true;
    },
    isMprActive: () => true,
  });

  drawMPR();
  assert.equal(ensureCalls, 0, 'hrVoxels-ready series should not hit ensureVoxels gate');

  state.hrVoxels = null;
  state.voxels = null;
  drawMPR();
  assert.equal(ensureCalls, 1, 'missing base volume should hit ensureVoxels gate exactly once');
});

test('drawMPR sizes the axial pane and crosshair from physical row/column spacing', () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'axial_spacing', width: 8, height: 6, slices: 5 });
  // Shape: anisotropic in-plane voxels where rows are 2 mm tall and columns are 1 mm wide.
  state.manifest.series[0].pixelSpacing = [2, 1];
  state.mprX = 4;
  state.mprY = 3;
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  drawMPR();

  const ax = globalThis.document.getElementById('mpr-ax');
  const overlay = globalThis.document.getElementById('mpr-ax-cross');
  assert.equal(ax.width, 8);
  assert.equal(ax.height, 16, 'axial pane height should expand to preserve physical aspect');
  assert.equal(overlay.style['--x'], `${(4 / 7) * 100}%`);
  assert.equal(overlay.style['--y'], `${(9 / 15) * 100}%`);
});

test('MPR cache bookkeeping: reuse, invalidation, and byte-budget bound', () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'cache_bounds', width: 150, height: 150, slices: 150 });
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });
  clearMprCellCache();

  drawMPR();
  const first = getMprCellCacheStats();
  assert.ok(first.entries > 0, 'first MPR draw should seed non-axial cache entries');
  assert.ok(first.bytes > 0, 'first MPR draw should allocate sampled plane cache bytes');

  drawMPR();
  const second = getMprCellCacheStats();
  assert.equal(second.entries, first.entries, 'identical redraw should reuse cache entries');
  assert.equal(second.bytes, first.bytes, 'identical redraw should not grow cache bytes');

  state.mprX = state.mprX + 1;
  drawMPR();
  const third = getMprCellCacheStats();
  assert.ok(third.entries > second.entries, 'changing axis plane should invalidate and add a new cache entry');

  for (let i = 0; i < 160; i++) {
    state.mprX = i % state.manifest.series[0].width;
    state.mprY = (i * 7) % state.manifest.series[0].height;
    drawMPR();
  }
  const budgeted = getMprCellCacheStats();
  assert.ok(
    budgeted.bytes <= 24 * 1024 * 1024,
    'cache bytes should remain within the configured memory budget',
  );

  clearMprCellCache();
  assert.deepEqual(getMprCellCacheStats(), { entries: 0, bytes: 0 });
});

test('interactive MPR draw path keeps fast quality until settle redraw', async () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'mpr_axis_interaction', width: 10, height: 8, slices: 7 });
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  beginMprInteraction({ axis: 'x', reason: 'test' });
  assert.equal(state.mprQuality, 'fast', 'interaction start should switch MPR to fast quality');

  state.mprX = state.mprX + 1;
  drawMPRInteractive();
  assert.equal(
    state.mprQuality,
    'fast',
    'interactive axis-update draw should stay in fast mode until settle timer fires',
  );

  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(state.mprQuality, 'quality', 'interaction settle should restore quality mode');
});

test('interactive x/y scrubbing redraws only the plane that actually changes', () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'mpr_partial_interaction', width: 10, height: 8, slices: 7 });
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  drawMPR();
  const ax = globalThis.document.getElementById('mpr-ax');
  const co = globalThis.document.getElementById('mpr-co');
  const sa = globalThis.document.getElementById('mpr-sa');
  const baseCounts = {
    ax: ax.getContext().puts,
    co: co.getContext().puts,
    sa: sa.getContext().puts,
  };

  beginMprInteraction({ axis: 'x', reason: 'test' });
  state.mprX += 1;
  drawMPRInteractive();
  assert.equal(ax.getContext().puts, baseCounts.ax, 'x scrub should not redraw axial image bytes');
  assert.equal(co.getContext().puts, baseCounts.co, 'x scrub should not redraw coronal image bytes');
  assert.ok(sa.getContext().puts > baseCounts.sa, 'x scrub should redraw sagittal image bytes');

  const xCounts = {
    ax: ax.getContext().puts,
    co: co.getContext().puts,
    sa: sa.getContext().puts,
  };
  beginMprInteraction({ axis: 'y', reason: 'test' });
  state.mprY += 1;
  drawMPRInteractive();
  assert.equal(ax.getContext().puts, xCounts.ax, 'y scrub should not redraw axial image bytes');
  assert.ok(co.getContext().puts > xCounts.co, 'y scrub should redraw coronal image bytes');
  assert.equal(sa.getContext().puts, xCounts.sa, 'y scrub should not redraw sagittal image bytes');
});

test('oblique interaction reuses the same fast then settle quality contract', async () => {
  setSeriesState({ slug: 'oblique_interaction', width: 10, height: 8, slices: 7 });
  initMprView({ ensureVoxels: () => false, isMprActive: () => false });

  beginObliqueInteraction();
  assert.equal(state.mprQuality, 'fast', 'oblique input should switch MPR to fast quality');

  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(state.mprQuality, 'quality', 'oblique settle should restore quality mode');
});

test('getMprVolumeReadiness reports base and overlay readiness gates', () => {
  setSeriesState({ slug: 'readiness_report', width: 6, height: 6, slices: 4 });
  state.useSeg = true;
  state.useRegions = true;
  state.regionMeta = { colors: {}, legend: {} };
  state.segVoxels = null;
  state.regionVoxels = null;

  assert.deepEqual(getMprVolumeReadiness(), {
    baseReady: true,
    overlaysReady: { seg: false, regions: false, sym: true, fusion: true },
  });
});

test('drawMPR renders shared note points in orthogonal panes', () => {
  storage.clear();
  installMprDom(8, 6);
  setSeriesState({ slug: 'mpr_notes', width: 8, height: 6, slices: 5 });
  state.mprX = 2;
  state.mprY = 4;
  state.mprZ = 3;
  setNoteEntriesForSlice('mpr_notes', 3, [{ id: 1, x: 2, y: 4, text: 'visible in all orthogonal panes' }]);
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  drawMPR();

  assert.ok(globalThis.document.getElementById('mpr-ax').getContext().arcs > 0, 'axial pane should render the note on its native slice');
  assert.ok(globalThis.document.getElementById('mpr-co').getContext().arcs > 0, 'coronal pane should render the note at matching y/z');
  assert.ok(globalThis.document.getElementById('mpr-sa').getContext().arcs > 0, 'sagittal pane should render the note at matching x/z');
});
