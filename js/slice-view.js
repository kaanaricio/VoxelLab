import { $ } from './dom.js';
import { state } from './state.js';
import { renderInspectionReadout, resolveVoxelInspection } from './inspection-readout.js';
import { getFusedWLLut, getFusedWLU32, COLORMAPS } from './colormap.js';
import { drawAnnotationPins } from './annotation.js';
import { drawHistogram } from './sparkline.js';
import { drawPluginOverlays } from './plugin.js';
import { readImageByteData } from './overlay-data.js';
import { drawCompositeSlice } from './slice-compositor.js';
import { endPerfTrace, hasPendingPerfTrace } from './perf-trace.js';
import { activeOverlayStateForSeries } from './runtime/active-overlay-state.js';
import { inPlaneDisplaySize } from './geometry.js';
import {
  initMprView,
  drawMPR,
  drawMPRInteractive,
  drawMPRZScrub,
  drawObliqueCell,
  beginObliqueInteraction,
  beginMprInteraction,
  clearMprCellCache,
  getMprCellCacheStats,
  getMprVolumeReadiness,
  mprClickToVoxel,
  showMprHover,
  syncMprCrosshairBounds,
} from './mpr-view.js';

const VIEW_AWAITING_SLICE = 'view-awaiting-slice';
const UI_FADE_SLICE = 'ui-fade-in';

/** Call when starting a new series load — hides the empty canvas “card” until the first drawSlice paints. */
export function markViewAwaitingSliceFade() {
  const el = $('view-xform');
  if (!el) return;
  el.classList.remove(UI_FADE_SLICE);
  el.classList.add(VIEW_AWAITING_SLICE);
}

function revealViewSliceIfPending() {
  const el = $('view-xform');
  if (!el || !el.classList.contains(VIEW_AWAITING_SLICE)) return;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.classList.remove(VIEW_AWAITING_SLICE);
    return;
  }
  requestAnimationFrame(() => {
    if (!el.classList.contains(VIEW_AWAITING_SLICE)) return;
    el.classList.replace(VIEW_AWAITING_SLICE, UI_FADE_SLICE);
  });
}

export {
  drawMPR,
  drawMPRInteractive,
  drawMPRZScrub,
  drawObliqueCell,
  beginObliqueInteraction,
  beginMprInteraction,
  clearMprCellCache,
  getMprCellCacheStats,
  getMprVolumeReadiness,
  mprClickToVoxel,
  showMprHover,
  syncMprCrosshairBounds,
  readImageByteData,
};

let _hideHover = () => {};

export function initSliceView(deps) {
  if (typeof deps.hideHover === 'function') _hideHover = deps.hideHover;
  initMprView({
    ensureVoxels: deps.ensureVoxels,
    isMprActive: deps.isMprActive,
    updateSliceDisplay,
  });
}

export function updateSliceDisplay(display) {
  const s = String(display);
  $('slice-big').textContent = s;
  const tot = $('slice-tot');
  if (!tot || tot.textContent === '') return;
  $('slice-cur').textContent = s;
}

export function showHoverAt(clientX, clientY) {
  const canvas = $('view');
  const r = canvas.getBoundingClientRect();
  if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) {
    _hideHover();
    return;
  }
  const vx = Math.floor((clientX - r.left) / r.width * canvas.width);
  const vy = Math.floor((clientY - r.top) / r.height * canvas.height);
  const vz = state.sliceIdx;
  const series = state.manifest.series[state.seriesIdx];
  if (vx < 0 || vx >= series.width || vy < 0 || vy >= series.height) {
    _hideHover();
    return;
  }

  const img = state.imgs[vz];
  if (!img || !img.complete || img.naturalWidth === 0) { _hideHover(); return; }
  const baseData = readImageByteData(img, series.width, series.height);
  if (!baseData) { _hideHover(); return; }
  const overlays = activeOverlayStateForSeries(series);
  const intensity = baseData[vy * series.width + vx];
  let inspection = resolveVoxelInspection(series, vx, vy, vz, { intensity });
  const labelImg = overlays.labels.imgs?.[vz];
  if (!inspection.regionName && overlays.labels.enabled && labelImg?.complete) {
    const regData = readImageByteData(labelImg, series.width, series.height);
    const label = regData ? regData[vy * series.width + vx] : 0;
    if (label && overlays.labels.meta?.legend) {
      inspection = {
        ...inspection,
        regionName: overlays.labels.meta.legend?.[label]
          || overlays.labels.meta.legend?.[String(label)]
          || inspection.regionName,
      };
    }
  }

  const hov = $('hover-readout');
  hov.innerHTML = renderInspectionReadout(inspection, { coordLabel: 'px' });
  hov.classList.add('visible');
  const wrap = $('canvas-wrap').getBoundingClientRect();
  let x = clientX - wrap.left + 14;
  let y = clientY - wrap.top + 14;
  const hw = hov.offsetWidth, hh = hov.offsetHeight;
  if (x + hw > wrap.width - 8) x = clientX - wrap.left - hw - 10;
  if (y + hh > wrap.height - 8) y = clientY - wrap.top - hh - 10;
  hov.style.left = `${x}px`;
  hov.style.top = `${y}px`;
}

export function drawSlice() {
  if (!state.loaded) return;
  if (state.mode !== '2d') return;
  const series = state.manifest.series[state.seriesIdx];
  const img = state.imgs[state.sliceIdx];
  if (!img || !img.complete || img.naturalWidth === 0) return;

  const canvas = $('view');
  canvas.width = series.width;
  canvas.height = series.height;
  // Shape: { width: 512, height: 768 } so 2D display keeps physical in-plane aspect.
  const displaySize = inPlaneDisplaySize(series);
  if (canvas.style) {
    canvas.style.width = `${displaySize.width}px`;
    canvas.style.height = `${displaySize.height}px`;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const baseData = readImageByteData(img, series.width, series.height);
  if (!baseData) return;
  const imgData = ctx.createImageData(series.width, series.height);
  const d = imgData.data;
  const overlays = activeOverlayStateForSeries(series);

  // Check which overlays are active (read their pixel data once, not per-pixel)
  const segBytes = overlays.tissue.enabled
    ? readImageByteData(state.segImgs[state.sliceIdx], series.width, series.height)
    : null;
  const symBytes = overlays.heatmap.enabled
    ? readImageByteData(state.symImgs[state.sliceIdx], series.width, series.height)
    : null;
  const regBytes = overlays.labels.enabled && overlays.labels.meta
    ? (overlays.labels.voxels
      ? state.regionVoxels.subarray(
        state.sliceIdx * series.width * series.height,
        (state.sliceIdx + 1) * series.width * series.height,
      )
      : readImageByteData(state.regionImgs[state.sliceIdx], series.width, series.height))
    : null;
  const hasFusion = overlays.fusion.enabled && overlays.fusion.imgs
    && overlays.fusion.imgs[state.sliceIdx] && overlays.fusion.imgs[state.sliceIdx].complete;
  const fusBytes = hasFusion
    ? readImageByteData(overlays.fusion.imgs[state.sliceIdx], series.width, series.height)
    : null;
  const hasSeg = !!segBytes;
  const hasSym = !!symBytes;
  const hasRegions = !!regBytes;
  const hasFusionBytes = !!fusBytes;
  const anyOverlay = hasSeg || hasSym || hasRegions || hasFusionBytes;

  if (!anyOverlay) {
    const lut = getFusedWLU32();
    const out32 = new Uint32Array(d.buffer);
    for (let i = 0; i < out32.length; i++) out32[i] = lut[baseData[i]];
    ctx.putImageData(imgData, 0, 0);
  } else {
    drawCompositeSlice(ctx, series.width, series.height, {
      baseBytes: baseData,
      segBytes,
      symBytes,
      regionBytes: regBytes,
      fusionBytes: fusBytes,
      wlLut: getFusedWLLut(),
      regionColors: hasRegions ? (overlays.labels.meta.colors || {}) : null,
      regionAlpha: state.overlayOpacity,
      fusionAlpha: state.fusionOpacity,
      hotLut: hasFusionBytes ? COLORMAPS.hot.lut : null,
    });
  }

  drawAnnotationPins(ctx);
  drawPluginOverlays(ctx);
  drawHistogram();

  revealViewSliceIfPending();

  updateSliceDisplay(state.sliceIdx + 1);
  $('wl-readout').textContent = `${Math.round(state.window)} / ${Math.round(state.level)}`;
  if (hasPendingPerfTrace('select-series-2d')) {
    endPerfTrace('select-series-2d', { slug: series.slug, sliceIdx: state.sliceIdx });
  }
  if (anyOverlay && hasPendingPerfTrace('overlay-toggle-paint')) {
    endPerfTrace('overlay-toggle-paint', { slug: series.slug, sliceIdx: state.sliceIdx });
  }
  if (hasPendingPerfTrace('cloud-complete-to-paint')) {
    endPerfTrace('cloud-complete-to-paint', { slug: series.slug, sliceIdx: state.sliceIdx });
  }
}
