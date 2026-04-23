// Orthogonal MPR cells (ax / coronal / sagittal), oblique reslice, hover, crosshair clicks.
// Depends on `ensureHRVoxels` / `state.voxels` from the shared volume path (volume-voxels-ensure, volume-hr-voxels).

import { $ } from './dom.js';
import { state } from './state.js';
import { SEG_PALETTE } from './constants.js';
import { drawingEntriesForSeries } from './annotation-graph.js';
import { renderInspectionReadout, resolveVoxelInspection } from './inspection-readout.js';
import { sampleLanczosZ, sampleLinearZ } from './lanczos.js';
import { mprPlaneSizes, mprVoxelForPixel } from './mpr-geometry.js';
import {
  createMprProjection,
  planeForAxis,
  planeForOblique,
  projectVolumeSample,
  projectionCacheToken,
} from './mpr-projection.js';
import { geometryFromSeries } from './geometry.js';
import { obliqueBasis, drawObliqueMPR, fitObliqueCanvas, obliquePlaneExtentMm } from './mpr_oblique.js';
import { COLORMAPS, getFusedWLLut, getFusedWLU32 } from './colormap.js';
import { ensureActiveOverlayVolumes } from './overlay-volumes.js';
import { drawCompositeSlice } from './slice-compositor.js';
import { setMprPosition, setMprQuality } from './state/viewer-commands.js';
import { beginPerfTrace, endPerfTrace, hasPendingPerfTrace } from './perf-trace.js';
import { activeOverlayStateForSeries } from './runtime/active-overlay-state.js';
import { overlaySessionForSeries, reviewReadinessForSeries } from './runtime/review-readiness.js';
import { updateMprOrientationMarkers } from './viewport.js';

let _ensureVoxels = () => false;
let _isMprActive = () => false;
let _resizeInvalidatorWired = false;
let _obliqueInteractionTimer = 0;
let _mprInteractiveAxis = '';
let _mprGpuApi = {
  canUseGpuMpr: () => false,
  drawGpuMprSlice: () => false,
};
let _mprGpuLoading = null;

function ensureMprGpuApi() {
  if (_mprGpuLoading || typeof document === 'undefined') return _mprGpuLoading;
  _mprGpuLoading = import('./mpr-gpu.js')
    .then((mod) => {
      _mprGpuApi = mod;
      return mod;
    })
    .catch(() => _mprGpuApi);
  return _mprGpuLoading;
}

export function initMprView(deps) {
  if (typeof deps.ensureVoxels === 'function') _ensureVoxels = deps.ensureVoxels;
  if (typeof deps.isMprActive === 'function') _isMprActive = deps.isMprActive;
  ensureMprGpuApi();
  if (!_resizeInvalidatorWired) {
    window.addEventListener('resize', () => {
      for (const id of ['mpr-ax-cross', 'mpr-co-cross', 'mpr-sa-cross']) {
        const el = $(id);
        if (el) el._mprBoundsReady = false;
      }
    });
    _resizeInvalidatorWired = true;
  }
}

// Shape: true when the active series already has a full base volume in either
// `state.hrVoxels` (Float32 cloud/local raw) or `state.voxels` (Uint8 PNG stack).
export function hasMprBaseVolume(series = state.manifest?.series?.[state.seriesIdx]) {
  if (!series) return false;
  const voxelCount = series.width * series.height * series.slices;
  return !!(
    (state.hrVoxels && state.hrVoxels.length === voxelCount)
    || (state.voxels && state.voxels.length === voxelCount)
  );
}

export function showMprHover(canvas, ev, axis) {
  if (!_isMprActive()) return;
  const series = state.manifest.series[state.seriesIdx];
  const W = series.width, H = series.height, D = series.slices;
  const r = canvas.getBoundingClientRect();
  const cx = (ev.clientX - r.left) / r.width * canvas.width;
  const cy = (ev.clientY - r.top) / r.height * canvas.height;

  let vx, vy, vz;
  [vx, vy, vz] = mprVoxelForPixel(axis, cx, cy, canvas.width, canvas.height, series, {
    x: state.mprX,
    y: state.mprY,
    z: state.mprZ,
  }).map(Math.round);
  vx = Math.max(0, Math.min(W - 1, vx));
  vy = Math.max(0, Math.min(H - 1, vy));
  vz = Math.max(0, Math.min(D - 1, vz));

  const inspection = resolveVoxelInspection(series, vx, vy, vz);

  const hov = $('hover-readout');
  hov.innerHTML = renderInspectionReadout(inspection, { coordLabel: 'vx', includeSlice: true });
  hov.classList.add('visible');
  const wrap = $('canvas-wrap').getBoundingClientRect();
  let x = ev.clientX - wrap.left + 14;
  let y = ev.clientY - wrap.top + 14;
  const hw = hov.offsetWidth, hh = hov.offsetHeight;
  if (x + hw > wrap.width - 8) x = ev.clientX - wrap.left - hw - 10;
  if (y + hh > wrap.height - 8) y = ev.clientY - wrap.top - hh - 10;
  hov.style.left = `${x}px`;
  hov.style.top = `${y}px`;
}

const _cellSampleCache = new Map();
let _mprQualityTimer = 0;
const OBLIQUE_SETTLE_MS = 140;
// Shape: ~24 MiB of cached sampled planes across recent coronal/sagittal views.
const CELL_CACHE_BUDGET_BYTES = 24 * 1024 * 1024;
let _cellSampleCacheBytes = 0;

function cellSampleBytes(entry) {
  return (entry?.base?.byteLength || 0)
    + (entry?.seg?.byteLength || 0)
    + (entry?.regions?.byteLength || 0)
    + (entry?.sym?.byteLength || 0)
    + (entry?.fusion?.byteLength || 0);
}

function trimCellSampleCache() {
  while (_cellSampleCacheBytes > CELL_CACHE_BUDGET_BYTES && _cellSampleCache.size > 1) {
    const oldestKey = _cellSampleCache.keys().next().value;
    const oldest = _cellSampleCache.get(oldestKey);
    _cellSampleCache.delete(oldestKey);
    _cellSampleCacheBytes -= oldest?._bytes || cellSampleBytes(oldest);
  }
}

function rememberCellSamples(key, entry) {
  const current = _cellSampleCache.get(key);
  if (current) {
    _cellSampleCache.delete(key);
    _cellSampleCacheBytes -= current._bytes || cellSampleBytes(current);
  }
  entry._bytes = cellSampleBytes(entry);
  _cellSampleCache.set(key, entry);
  _cellSampleCacheBytes += entry._bytes;
  trimCellSampleCache();
}

function readCellSamples(key) {
  const entry = _cellSampleCache.get(key);
  if (!entry) return null;
  _cellSampleCache.delete(key);
  _cellSampleCache.set(key, entry);
  return entry;
}

function sampleByte(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function activeMprGpu() {
  return !!state.mprGpuEnabled && _mprGpuApi.canUseGpuMpr();
}

function fitCanvasDisplay(canvas, width, height, maxWidth, maxHeight) {
  if (!canvas?.style) return;
  const scale = Math.min(
    Math.max(0.01, maxWidth / Math.max(1, width)),
    Math.max(0.01, maxHeight / Math.max(1, height)),
  );
  canvas.style.width = `${Math.max(1, Math.round(width * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.round(height * scale))}px`;
}

function scaledAxisPixel(value, sourceSize, targetSize) {
  if (!(sourceSize > 1) || !(targetSize > 1)) return 0;
  return value * (targetSize - 1) / (sourceSize - 1);
}

function applyMprViewportStyle(canvas) {
  const pane = {
    'mpr-ax': 'ax',
    'mpr-co': 'co',
    'mpr-sa': 'sa',
    'mpr-ob': 'ob',
  }[canvas?.id] || '';
  const view = pane ? state.mpr.viewports?.[pane] : null;
  if (!canvas?.style || !view) return;
  canvas.style.transformOrigin = '50% 50%';
  canvas.style.transform = `translate(${view.tx || 0}px, ${view.ty || 0}px) scale(${view.zoom || 1})`;
}

function drawMprNotePins(ctx, axis, outW, outH, series) {
  const notes = drawingEntriesForSeries(state, series.slug).filter((entry) => entry.kind === 'note');
  if (!notes.length) return;
  const Dm1 = Math.max(1, series.slices - 1);
  const Wm1 = Math.max(1, series.width - 1);
  const Hm1 = Math.max(1, series.height - 1);
  const r = Math.max(4, Math.round(Math.min(outW, outH) * 0.02));
  ctx.save();
  for (const { sliceIdx, data } of notes) {
    let px = null;
    let py = null;
    if (axis === 'ax' && sliceIdx === state.mprZ) {
      px = data.x * (outW - 1) / Wm1;
      py = data.y * (outH - 1) / Hm1;
    } else if (axis === 'co' && Math.round(data.y) === state.mprY) {
      px = data.x * (outW - 1) / Wm1;
      py = (1 - sliceIdx / Dm1) * (outH - 1);
    } else if (axis === 'sa' && Math.round(data.x) === state.mprX) {
      px = data.y * (outW - 1) / Hm1;
      py = (1 - sliceIdx / Dm1) * (outH - 1);
    }
    if (px == null || py == null) continue;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fill();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.stroke();
  }
  ctx.restore();
}

// Shape: Uint8Array(width * height) reused for one axial plane on a canvas.
function axialBaseBytes(canvas, width, height, zBase, vox, voxScale) {
  const planeSize = width * height;
  const source = voxScale === 1 ? vox.subarray(zBase, zBase + planeSize) : null;
  if (source) return source;
  if (!canvas._mprAxBaseBytes || canvas._mprAxBaseBytes.length !== planeSize) {
    canvas._mprAxBaseBytes = new Uint8Array(planeSize);
  }
  const baseBytes = canvas._mprAxBaseBytes;
  for (let i = 0; i < planeSize; i++) baseBytes[i] = sampleByte(vox[zBase + i] * voxScale);
  return baseBytes;
}

function cellCacheKey(axis, outW, outH, series, useHR, useSeg, useRegions, useSym, useFusion, projection) {
  const plane = axis === 'ax' ? state.mprZ : axis === 'co' ? state.mprY : state.mprX;
  return [
    axis, series.slug, state.seriesIdx, `${outW}x${outH}`, `${series.width}x${series.height}x${series.slices}`,
    `plane=${plane}`,
    `quality=${state.mprQuality}`,
    `projection=${projectionCacheToken(projection)}`,
    `src=${useHR ? 'hr' : 'lo'}`, `seg=${!!useSeg}`, `regions=${!!useRegions}`,
    `sym=${!!useSym}`, `fusion=${state.fusionSlug || ''}:${!!useFusion}`,
  ].join('|');
}

function clampMpr(series) {
  setMprPosition({ x: state.mprX, y: state.mprY, z: state.mprZ }, series);
}

export function beginMprInteraction({ axis = 'z', reason = 'scrub' } = {}) {
  clearTimeout(_mprQualityTimer);
  _mprInteractiveAxis = axis;
  if (!hasPendingPerfTrace('mpr-axis-interaction')) {
    beginPerfTrace('mpr-axis-interaction', { axis, reason });
  }
  setMprQuality('fast');
  _mprQualityTimer = setTimeout(() => {
    _mprInteractiveAxis = '';
    setMprQuality('quality');
    if (!hasPendingPerfTrace('mpr-quality-settle')) {
      beginPerfTrace('mpr-quality-settle', { axis, reason });
    }
    if (_isMprActive()) drawMPR();
  }, 140);
}

export function beginObliqueInteraction(reason = 'slider') {
  clearTimeout(_obliqueInteractionTimer);
  if (state.mprQuality !== 'fast') setMprQuality('fast');
  _obliqueInteractionTimer = setTimeout(() => {
    setMprQuality('quality');
    if (_isMprActive()) drawObliqueCell();
  }, OBLIQUE_SETTLE_MS);
  return reason;
}

function syncMprOverlayStatus(series) {
  const overlays = activeOverlayStateForSeries(series);
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  show('mpr-pill-tissue', overlays.tissue.enabled);
  show('mpr-pill-regions', overlays.labels.enabled);
  show('mpr-pill-sym', overlays.heatmap.enabled);
  show('mpr-pill-fusion', overlays.fusion.enabled);
}

function updateMprLabels(series) {
  $('mpr-ax-idx').textContent = `Z ${state.mprZ + 1}/${series.slices}`;
  $('mpr-co-idx').textContent = `Y ${state.mprY + 1}/${series.height}`;
  $('mpr-sa-idx').textContent = `X ${state.mprX + 1}/${series.width}`;
  updateMprOrientationMarkers(series);
  syncMprOverlayStatus(series);
}

// Shape: { interactive: true } for wheel-driven x/y scrub.
function drawMprFrame({ interactive = false } = {}) {
  if (!interactive) {
    clearTimeout(_mprQualityTimer);
    if (state.mprQuality !== 'quality') setMprQuality('quality');
  } else if (state.mprQuality !== 'fast') {
    setMprQuality('fast');
  }
  const series = state.manifest.series[state.seriesIdx];
  if (!hasMprBaseVolume(series) && !_ensureVoxels()) return;
  ensureActiveOverlayVolumes();
  clampMpr(series);
  const { axW, axH, coW, coH, saW, saH } = mprPlaneSizes(series);
  const interactiveAxis = interactive ? _mprInteractiveAxis : '';

  if (interactiveAxis === 'x') {
    drawMPRCell($('mpr-sa'), 'sa', saW, saH);
  } else if (interactiveAxis === 'y') {
    drawMPRCell($('mpr-co'), 'co', coW, coH);
  } else {
    drawMPRCell($('mpr-ax'), 'ax', axW, axH);
    drawMPRCell($('mpr-co'), 'co', coW, coH);
    drawMPRCell($('mpr-sa'), 'sa', saW, saH);
  }
  updateMprCrosshairs(series, !interactive);
  updateMprLabels(series);
  drawObliqueCell();
  if (hasPendingPerfTrace('enter-mpr')) {
    endPerfTrace('enter-mpr', { slug: series.slug, mprZ: state.mprZ });
  }
  if (interactive && hasPendingPerfTrace('mpr-axis-interaction')) {
    endPerfTrace('mpr-axis-interaction', { slug: series.slug, axis: 'orthogonal' });
  }
  if (!interactive && hasPendingPerfTrace('mpr-quality-settle')) {
    endPerfTrace('mpr-quality-settle', { slug: series.slug, axis: 'settle' });
  }
}

export function drawMPR() {
  drawMprFrame();
}

export function drawMPRInteractive() {
  drawMprFrame({ interactive: true });
}

export function drawMPRZScrub() {
  beginMprInteraction();
  const series = state.manifest.series[state.seriesIdx];
  if (!hasMprBaseVolume(series) && !_ensureVoxels()) return;
  ensureActiveOverlayVolumes();
  clampMpr(series);
  const { axW, axH } = mprPlaneSizes(series);
  drawMPRCell($('mpr-ax'), 'ax', axW, axH);
  updateMprCrosshairs(series, false);
  updateMprLabels(series);
  drawObliqueCell();
  if (hasPendingPerfTrace('enter-mpr')) {
    endPerfTrace('enter-mpr', { slug: series.slug, mprZ: state.mprZ, partial: true });
  }
  if (hasPendingPerfTrace('mpr-axis-interaction')) {
    endPerfTrace('mpr-axis-interaction', { slug: series.slug, axis: 'z', partial: true });
  }
}

export function syncMprCrosshairBounds() {
  const series = state.manifest?.series?.[state.seriesIdx];
  if (series) updateMprCrosshairs(series, true);
}

function updateMprCrosshairs(series, syncBounds) {
  const Dm1 = Math.max(1, series.slices - 1);
  positionMprCrosshair(
    'mpr-ax-cross',
    $('mpr-ax'),
    scaledAxisPixel(state.mprX, series.width, $('mpr-ax')?.width || 0),
    scaledAxisPixel(state.mprY, series.height, $('mpr-ax')?.height || 0),
    syncBounds,
  );
  positionMprCrosshair(
    'mpr-co-cross',
    $('mpr-co'),
    scaledAxisPixel(state.mprX, series.width, $('mpr-co')?.width || 0),
    (1 - state.mprZ / Dm1) * (($('mpr-co')?.height || 1) - 1),
    syncBounds,
  );
  positionMprCrosshair(
    'mpr-sa-cross',
    $('mpr-sa'),
    scaledAxisPixel(state.mprY, series.height, $('mpr-sa')?.width || 0),
    (1 - state.mprZ / Dm1) * (($('mpr-sa')?.height || 1) - 1),
    syncBounds,
  );
}

function positionMprCrosshair(id, canvas, x, y, syncBounds) {
  const overlay = $(id);
  if (!overlay || !canvas) return;
  if (syncBounds || !overlay._mprBoundsReady) {
    const cell = canvas.parentElement;
    const cr = canvas.getBoundingClientRect();
    const pr = cell.getBoundingClientRect();
    overlay.style.left = `${cr.left - pr.left}px`;
    overlay.style.top = `${cr.top - pr.top}px`;
    overlay.style.width = `${cr.width}px`;
    overlay.style.height = `${cr.height}px`;
    overlay._mprBoundsReady = true;
  }
  const xp = Math.max(0, Math.min(1, canvas.width > 1 ? x / (canvas.width - 1) : x));
  const yp = Math.max(0, Math.min(1, canvas.height > 1 ? y / (canvas.height - 1) : y));
  overlay.style.setProperty('--x', `${xp * 100}%`);
  overlay.style.setProperty('--y', `${yp * 100}%`);
}

export function drawObliqueCell() {
  const canvas = $('mpr-ob');
  if (!canvas) return;
  const series = state.manifest.series[state.seriesIdx];
  const W = series.width, H = series.height, D = series.slices;
  const useHR = state.hrVoxels && state.hrVoxels.length === W * H * D;
  const vox = useHR ? state.hrVoxels : state.voxels;
  if (!vox) return;
  const voxScale = useHR ? 255 : 1;
  ensureActiveOverlayVolumes();
  const overlays = activeOverlayStateForSeries(series);

  // Parent cell rect = available canvas area (toolbar is outside the grid cells).
  const rect = canvas.parentElement?.getBoundingClientRect?.() || canvas.getBoundingClientRect();
  const geo = geometryFromSeries(series);
  const spacing = { row: geo.rowSpacing, col: geo.colSpacing, slice: geo.sliceSpacing };
  const extentMm = obliquePlaneExtentMm(
    { W, H, D },
    spacing,
    [state.mprX, state.mprY, state.mprZ],
    state.obYaw,
    state.obPitch,
  );
  const availableWidth = Math.max(160, Math.round((rect.width || 512) - 16));
  const availableHeight = Math.max(120, Math.round((rect.height || 512) - 16));
  const fitted = fitObliqueCanvas(availableWidth, availableHeight, extentMm);
  const targetScale = state.mprQuality === 'fast' ? 0.6 : 1;
  const targetWidth = Math.max(160, Math.min(1024, Math.round(fitted.width * targetScale)));
  const targetHeight = Math.max(160, Math.min(1024, Math.round(fitted.height * targetScale)));
  if (canvas.width !== targetWidth) canvas.width = targetWidth;
  if (canvas.height !== targetHeight) canvas.height = targetHeight;
  fitCanvasDisplay(canvas, targetWidth, targetHeight, fitted.width, fitted.height);
  applyMprViewportStyle(canvas);

  const lo = state.level - state.window / 2;
  const hi = state.level + state.window / 2;
  const sampleVolume = state.mprQuality === 'fast' ? sampleLinearZ : sampleLanczosZ;
  const basis = obliqueBasis(state.obYaw, state.obPitch);
  const stepUMm = extentMm.widthMm / Math.max(1, targetWidth - 1);
  const stepVMm = extentMm.heightMm / Math.max(1, targetHeight - 1);
  const du = [
    basis.u[0] * stepUMm / spacing.col,
    basis.u[1] * stepUMm / spacing.row,
    basis.u[2] * stepUMm / spacing.slice,
  ];
  const dv = [
    basis.v[0] * stepVMm / spacing.col,
    basis.v[1] * stepVMm / spacing.row,
    basis.v[2] * stepVMm / spacing.slice,
  ];
  const plane = planeForOblique(targetWidth, targetHeight, [state.mprX, state.mprY, state.mprZ], du, dv);
  const projection = createMprProjection({
    mode: state.mpr.projectionMode,
    slabThicknessMm: state.mpr.slabThicknessMm,
  }, spacing, plane);
  const overlayOptions = {
    segVoxels: overlays.tissue.enabled ? state.segVoxels : null,
    segPalette: SEG_PALETTE,
    regionVoxels: overlays.labels.enabled ? state.regionVoxels : null,
    regionColors: overlays.labels.meta?.colors || null,
    regionAlpha: state.overlayOpacity,
    symVoxels: overlays.heatmap.enabled ? state.symVoxels : null,
    fusionVoxels: overlays.fusion.enabled ? state.fusionVoxels : null,
    fusionAlpha: state.fusionOpacity,
    hotLut: COLORMAPS.hot.lut,
  };

  if (activeMprGpu()) {
    const rendered = _mprGpuApi.drawGpuMprSlice(canvas, {
      plane,
      projection,
      dims: { W, H, D },
      vox,
      wlLut: getFusedWLLut(),
      regionColors: overlayOptions.regionColors,
      regionAlpha: overlayOptions.regionAlpha,
      fusionAlpha: overlayOptions.fusionAlpha,
      segVoxels: overlayOptions.segVoxels,
      regionVoxels: overlayOptions.regionVoxels,
      symVoxels: overlayOptions.symVoxels,
      fusionVoxels: overlayOptions.fusionVoxels,
      hotLut: overlayOptions.hotLut,
    });
    if (rendered) {
      const lab = $('mpr-ob-idx');
      if (lab) lab.textContent = `yaw ${state.obYaw}° · pitch ${state.obPitch}°`;
      if (hasPendingPerfTrace('mpr-oblique-paint')) {
        endPerfTrace('mpr-oblique-paint', { slug: series.slug, yaw: state.obYaw, pitch: state.obPitch, renderer: 'gpu' });
      }
      return;
    }
  }

  drawObliqueMPR(
    canvas, vox, voxScale,
    { W, H, D },
    spacing,
    [state.mprX, state.mprY, state.mprZ],
    state.obYaw, state.obPitch,
    extentMm, lo, hi,
    overlayOptions,
    sampleVolume,
    projection,
  );

  const lab = $('mpr-ob-idx');
  if (lab) lab.textContent = `yaw ${state.obYaw}° · pitch ${state.obPitch}°`;
  if (hasPendingPerfTrace('mpr-oblique-paint')) {
    endPerfTrace('mpr-oblique-paint', { slug: series.slug, yaw: state.obYaw, pitch: state.obPitch, renderer: 'cpu' });
  }
}

function drawMPRCell(canvas, axis, outW, outH) {
  const series = state.manifest.series[state.seriesIdx];
  const W = series.width, H = series.height, D = series.slices;
  if (canvas.width !== outW) canvas.width = outW;
  if (canvas.height !== outH) canvas.height = outH;
  const cellRect = canvas.parentElement?.getBoundingClientRect?.();
  fitCanvasDisplay(
    canvas,
    outW,
    outH,
    Math.max(outW, Math.round((cellRect?.width || outW) - 12)),
    Math.max(outH, Math.round((cellRect?.height || outH) - 12)),
  );
  applyMprViewportStyle(canvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const useHR = state.hrVoxels && state.hrVoxels.length === W * H * D;
  const vox = useHR ? state.hrVoxels : state.voxels;
  const voxScale = useHR ? 255 : 1;
  const overlays = activeOverlayStateForSeries(series);
  const sv = state.segVoxels;
  const useSeg = overlays.tissue.enabled && sv;
  const rv = state.regionVoxels;
  const useRegions = overlays.labels.enabled && rv && overlays.labels.meta;
  const syv = state.symVoxels;
  const useSym = overlays.heatmap.enabled && syv;
  const fuv = state.fusionVoxels;
  const useFusion = overlays.fusion.enabled && fuv;
  const regionColors = useRegions ? overlays.labels.meta.colors : null;
  const regionAlpha = state.overlayOpacity;
  const fusionAlpha = state.fusionOpacity;
  const hotLut = useFusion ? COLORMAPS.hot.lut : null;
  const WH = W * H;
  const hasOverlays = useSeg || useRegions || useSym || useFusion;
  const geo = geometryFromSeries(series);
  const spacing = { row: geo.rowSpacing, col: geo.colSpacing, slice: geo.sliceSpacing };
  const plane = planeForAxis(axis, outW, outH, series, { x: state.mprX, y: state.mprY, z: state.mprZ }, mprVoxelForPixel);
  const projection = createMprProjection({
    mode: state.mpr.projectionMode,
    slabThicknessMm: state.mpr.slabThicknessMm,
  }, spacing, plane);
  const dims = { W, H, D };
  if (activeMprGpu()) {
    const rendered = _mprGpuApi.drawGpuMprSlice(canvas, {
      plane,
      projection,
      dims,
      vox,
      wlLut: getFusedWLLut(),
      regionColors,
      regionAlpha,
      fusionAlpha,
      segVoxels: useSeg ? sv : null,
      regionVoxels: useRegions ? rv : null,
      symVoxels: useSym ? syv : null,
      fusionVoxels: useFusion ? fuv : null,
      hotLut,
    });
    if (rendered) {
      drawMprNotePins(ctx, axis, outW, outH, series);
      return;
    }
  }

  const img = axis === 'ax' && canvas._mprAxImageData?.width === outW && canvas._mprAxImageData?.height === outH
    ? canvas._mprAxImageData
    : ctx.createImageData(outW, outH);
  if (axis === 'ax') canvas._mprAxImageData = img;
  const out = img.data;
  const sampleGray = state.mprQuality === 'fast'
    ? (x, y, z) => sampleLinearZ(vox, x, y, z, W, H, D)
    : (x, y, z) => sampleLanczosZ(vox, x, y, z, W, H, D);
  const isThinProjection = projection.sampleCount <= 1 || projection.mode === 'thin';
  const sampleProjectedBase = isThinProjection
    ? (x, y, z) => sampleGray(x, y, z)
    : (x, y, z) => projectVolumeSample(vox, x, y, z, dims, sampleGray, projection);

  // Native-plane fast path: only valid when canvas pixel dims match the source
  // WxH. When rowSpacing != colSpacing, mprPlaneSizes stretches axH for aspect
  // correction, so outH != H — fall through to the generic resampling path
  // below to avoid writing a WxH plane into an outWxoutH buffer.
  // Shape: outW=W=512, outH=665 when rowSpacing/colSpacing=1.3 (anisotropic).
  if (axis === 'ax' && projection.sampleCount <= 1 && outW === W && outH === H) {
    const zBase = state.mprZ * WH;
    if (!hasOverlays) {
      const out32 = new Uint32Array(out.buffer);
      const fusedU32 = getFusedWLU32();
      for (let i = 0; i < WH; i++) {
        const raw = sampleByte(vox[zBase + i] * voxScale);
        out32[i] = fusedU32[raw];
      }
      ctx.putImageData(img, 0, 0);
      drawMprNotePins(ctx, axis, outW, outH, series);
      return;
    }
    drawCompositeSlice(ctx, outW, outH, {
      baseBytes: axialBaseBytes(canvas, W, H, zBase, vox, voxScale),
      segBytes: useSeg ? sv.subarray(zBase, zBase + WH) : null,
      symBytes: useSym ? syv.subarray(zBase, zBase + WH) : null,
      regionBytes: useRegions ? rv.subarray(zBase, zBase + WH) : null,
      fusionBytes: useFusion ? fuv.subarray(zBase, zBase + WH) : null,
      wlLut: getFusedWLLut(),
      regionColors,
      regionAlpha,
      fusionAlpha,
      hotLut,
    });
    drawMprNotePins(ctx, axis, outW, outH, series);
    return;
  }
  const cacheKey = cellCacheKey(axis, outW, outH, series, useHR, useSeg, useRegions, useSym, useFusion, projection);
  let cached = readCellSamples(cacheKey);
  const sampleOverlay = state.mprQuality === 'fast'
    ? (vol, x, y, z) => sampleLinearZ(vol, x, y, z, W, H, D)
    : (vol, x, y, z) => sampleLanczosZ(vol, x, y, z, W, H, D);
  const sampleProjectedOverlay = isThinProjection
    ? (vol, x, y, z) => sampleOverlay(vol, x, y, z)
    : (vol, x, y, z) => projectVolumeSample(vol, x, y, z, dims, sampleOverlay, projection);
  if (!cached) {
    cached = {
      base: new Uint8Array(outW * outH),
      seg: useSeg ? new Uint8Array(outW * outH) : null,
      regions: useRegions ? new Uint8Array(outW * outH) : null,
      sym: useSym ? new Uint8Array(outW * outH) : null,
      fusion: useFusion ? new Uint8Array(outW * outH) : null,
    };
    // Shape: current orthogonal crosshair reused across every pixel sample in this draw.
    const crosshair = { x: state.mprX, y: state.mprY, z: state.mprZ };
    let sampleIndex = 0;
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++, sampleIndex++) {
        const [vx, vy, vz] = mprVoxelForPixel(axis, ox, oy, outW, outH, series, crosshair);
        cached.base[sampleIndex] = sampleByte(sampleProjectedBase(vx, vy, vz) * voxScale);
        const ix = vx < 0 ? 0 : vx > W - 1 ? W - 1 : Math.round(vx);
        const iy = vy < 0 ? 0 : vy > H - 1 ? H - 1 : Math.round(vy);
        const iz = vz < 0 ? 0 : vz > D - 1 ? D - 1 : Math.round(vz);
        const vi = iz * WH + iy * W + ix;
        if (cached.seg) cached.seg[sampleIndex] = sv[vi];
        if (cached.regions) cached.regions[sampleIndex] = rv[vi];
        if (cached.sym) cached.sym[sampleIndex] = sampleByte(sampleProjectedOverlay(syv, vx, vy, vz));
        if (cached.fusion) cached.fusion[sampleIndex] = sampleByte(sampleProjectedOverlay(fuv, vx, vy, vz));
      }
    }
    rememberCellSamples(cacheKey, cached);
  }
  if (!hasOverlays) {
    const fusedU32 = getFusedWLU32();
    const out32 = new Uint32Array(out.buffer);
    for (let i = 0; i < cached.base.length; i++) out32[i] = fusedU32[cached.base[i]];
    ctx.putImageData(img, 0, 0);
    drawMprNotePins(ctx, axis, outW, outH, series);
    return;
  }
  drawCompositeSlice(ctx, outW, outH, {
    baseBytes: cached.base,
    segBytes: cached.seg,
    symBytes: cached.sym,
    regionBytes: cached.regions,
    fusionBytes: cached.fusion,
    wlLut: getFusedWLLut(),
    regionColors,
    regionAlpha,
    fusionAlpha,
    hotLut,
  });
  drawMprNotePins(ctx, axis, outW, outH, series);
}

export function clearMprCellCache() {
  _cellSampleCache.clear();
  _cellSampleCacheBytes = 0;
}

// Shape: { entries: 6, bytes: 7340032 } for devtools/tests.
export function getMprCellCacheStats() {
  return {
    entries: _cellSampleCache.size,
    bytes: _cellSampleCacheBytes,
  };
}

// Shape: { baseReady: true, overlaysReady: { seg: false, regions: true, sym: false, fusion: false } }.
export function getMprVolumeReadiness(series = state.manifest?.series?.[state.seriesIdx]) {
  const overlaysReady = {
    seg: !state.useSeg || !!state.segVoxels,
    regions: !state.useRegions || (!!state.regionVoxels && !!state.regionMeta),
    sym: !state.useSym || !!state.symVoxels,
    fusion: !state.fusionSlug || !!state.fusionVoxels,
  };
  const overlaySession = overlaySessionForSeries(series);
  const readiness = reviewReadinessForSeries(series, { overlaySession });
  return {
    baseReady: readiness.baseVolume,
    overlaysReady,
  };
}

export function mprClickToVoxel(canvas, ev, axis) {
  const r = canvas.getBoundingClientRect();
  const cx = Math.floor((ev.clientX - r.left) / r.width * canvas.width);
  const cy = Math.floor((ev.clientY - r.top) / r.height * canvas.height);
  const series = state.manifest.series[state.seriesIdx];
  const [vx, vy, vz] = mprVoxelForPixel(axis, cx, cy, canvas.width, canvas.height, series, {
    x: state.mprX,
    y: state.mprY,
    z: state.mprZ,
  }).map(Math.round);
  setMprPosition({ x: vx, y: vy, z: vz }, series, { syncSlice: true });
}
