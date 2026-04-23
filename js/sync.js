// Centralized UI sync after state mutations.
//
// Every slice-navigation site was assembling its own redraw list,
// and most missed mode-specific updates (MPR crosshair, compare grid,
// 3D clip plane, sparkline, measurements). This module replaces those
// scattered lists with two functions:
//
//   syncSlice()    — call after any state.sliceIdx change
//   syncOverlays() — call after toggling brain/seg/regions/sym/colormap

import { $ } from './dom.js';
import { state, subscribe } from './state.js';
import { updateScrubFill } from './cine.js';
import { syncMprSliceIndex } from './state/viewer-commands.js';
import {
  updateSliceDisplay,
  drawSlice,
  drawMPR,
  drawMPRInteractive,
  drawMPRZScrub,
  clearMprCellCache,
} from './slice-view.js';
import { drawCompare } from './compare.js';
import { drawSparkline } from './sparkline.js';
import { drawMeasurements } from './measure.js';
import { isMprActive } from './mode-flags.js';
import { sync3DScrubber, updateUniforms, updateLabelTexture, syncThreeSurfaceState } from './volume-3d.js';
import { updateClipReadouts } from './clip-readouts.js';
import { syncPanelRangeFills } from './panel-range-fills.js';
import { getThreeRuntime } from './runtime/viewer-runtime.js';
import { PERF_MODE } from './runtime-flags.js';
import { syncViewerRuntimeSession } from './runtime/viewer-session.js';

let _wired = false;
const SLICE_WINDOW_RADIUS = 5;
const REMOTE_PREFETCH_CONCURRENCY = 1;
const REMOTE_BASE_PREFETCH_LIMIT = 6;
const REMOTE_OVERLAY_PREFETCH_LIMIT = 3;

function scrubWindowRadius(series = state.manifest?.series?.[state.seriesIdx]) {
  return series?.sliceUrlBase ? 0 : SLICE_WINDOW_RADIUS;
}

function redrawActiveViews({ fullMpr = false, interactiveMpr = false } = {}) {
  if (state.mode === '2d') drawSlice();
  if (isMprActive()) {
    if (fullMpr && interactiveMpr) drawMPRInteractive();
    else if (fullMpr) drawMPR();
    else drawMPRZScrub();
  }
  if (state.mode === 'cmp') drawCompare();
}

// rAF coalescer: multiple `state.sliceIdx` writes inside one task
// (e.g. a wheel burst, a `batch()` block, or sliceIdx + mode toggles) collapse
// into a single redraw on the next animation frame. The coalescer also folds
// `fullMpr=true` requests so a same-tick mode change correctly upgrades the
// scheduled redraw to a full MPR pass.
//
// Skips the redraw entirely when `(sliceIdx, mode)` is unchanged AND no
// fullMpr request is pending — no-op writes do not waste a frame.
//
// Always runs the final redraw if `sliceIdx` changed since the last fired
// frame (regression anchor: never get stuck on the penultimate slice).
let _rafScheduled = false;
let _rafFullMpr = false;
let _rafInteractiveMpr = false;
let _rafForced = false;
let _rafLastSliceIdx = -1;
let _rafLastMode = '';

function scheduleRedraw({ fullMpr = false, interactiveMpr = false, force = false } = {}) {
  if (fullMpr) _rafFullMpr = true;
  if (interactiveMpr) _rafInteractiveMpr = true;
  if (force) _rafForced = true;
  if (_rafScheduled) return;
  _rafScheduled = true;
  const raf = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : ((fn) => setTimeout(fn, 16));
  raf(() => {
    _rafScheduled = false;
    const fm = _rafFullMpr;
    const im = _rafInteractiveMpr;
    const forced = _rafForced;
    _rafFullMpr = false;
    _rafInteractiveMpr = false;
    _rafForced = false;
    if (state.sliceIdx === _rafLastSliceIdx && state.mode === _rafLastMode && !fm && !im && !forced) {
      return;
    }
    _rafLastSliceIdx = state.sliceIdx;
    _rafLastMode = state.mode;
    redrawActiveViews({ fullMpr: fm, interactiveMpr: im });
  });
}

/** Volume panel Z scrubber: same slice index as main scrubber (drives 3D Z clip via sync3DScrubber). */
export function syncZScrubberSlider(series = state.manifest?.series?.[state.seriesIdx]) {
  const el = $('s-zscrub');
  if (!el || !series) return;
  const max0 = Math.max(0, (series.slices | 0) - 1);
  el.max = String(max0);
  el.value = String(Math.min(max0, Math.max(0, state.sliceIdx | 0)));
  el.disabled = max0 <= 0;
  syncPanelRangeFills();
}

function syncSliceUI({ scrub = true } = {}) {
  if (scrub && $('scrub')) $('scrub').value = state.sliceIdx;
  updateScrubFill();
  updateSliceDisplay(state.sliceIdx + 1);
  drawSparkline();
  drawMeasurements();
  sync3DScrubber();
  syncZScrubberSlider();
}

function canRenderMprFromVolumes() {
  const session = syncViewerRuntimeSession();
  return !!session?.readiness?.mprReady;
}

function ensureVisibleStackWindow() {
  if (isMprActive() && canRenderMprFromVolumes()) return;
  const series = state.manifest?.series?.[state.seriesIdx];
  const isRemote = !!series?.sliceUrlBase;
  const radius = scrubWindowRadius();
  const currentIdx = state.sliceIdx;
  const currentImgs = state.imgs;
  const redrawWhenReady = (imgs, promise, getCurrent) => promise?.then(() => {
    if (state.sliceIdx !== currentIdx || getCurrent() !== imgs) return;
    scheduleRedraw({ fullMpr: isMprActive(), force: true });
  });
  const ensureCurrentSlice = (imgs) => imgs?.ensureIndex?.(currentIdx);
  const warmNearbySlices = (imgs) => {
    if (radius > 0) imgs?.ensureWindow?.(currentIdx, radius);
  };
  redrawWhenReady(currentImgs, ensureCurrentSlice(currentImgs), () => state.imgs);
  redrawWhenReady(state.segImgs, ensureCurrentSlice(state.segImgs), () => state.segImgs);
  redrawWhenReady(state.symImgs, ensureCurrentSlice(state.symImgs), () => state.symImgs);
  redrawWhenReady(state.regionImgs, ensureCurrentSlice(state.regionImgs), () => state.regionImgs);
  redrawWhenReady(state.fusionImgs, ensureCurrentSlice(state.fusionImgs), () => state.fusionImgs);
  warmNearbySlices(currentImgs);
  warmNearbySlices(state.segImgs);
  warmNearbySlices(state.symImgs);
  warmNearbySlices(state.regionImgs);
  warmNearbySlices(state.fusionImgs);
  if (!isRemote) return;
  if (PERF_MODE) return;
  currentImgs?.prefetchRemaining?.(currentIdx, radius, {
    concurrency: REMOTE_PREFETCH_CONCURRENCY,
    limit: REMOTE_BASE_PREFETCH_LIMIT,
  });
  state.segImgs?.prefetchRemaining?.(currentIdx, radius, {
    concurrency: REMOTE_PREFETCH_CONCURRENCY,
    limit: REMOTE_OVERLAY_PREFETCH_LIMIT,
  });
  state.symImgs?.prefetchRemaining?.(currentIdx, radius, {
    concurrency: REMOTE_PREFETCH_CONCURRENCY,
    limit: REMOTE_OVERLAY_PREFETCH_LIMIT,
  });
  state.regionImgs?.prefetchRemaining?.(currentIdx, radius, {
    concurrency: REMOTE_PREFETCH_CONCURRENCY,
    limit: REMOTE_OVERLAY_PREFETCH_LIMIT,
  });
  state.fusionImgs?.prefetchRemaining?.(currentIdx, radius, {
    concurrency: REMOTE_PREFETCH_CONCURRENCY,
    limit: REMOTE_OVERLAY_PREFETCH_LIMIT,
  });
}

export function initReactiveSync({
  syncOverlayOpacityUI = () => {},
  renderVolumes = () => {},
  renderFusionPicker = () => {},
  renderRegionLegend = () => {},
  renderVolumeTable = () => {},
} = {}) {
  if (_wired) return;
  _wired = true;

  subscribe('sliceIdx', () => {
    ensureVisibleStackWindow();
    syncSliceUI();
    if (isMprActive() && state.mprZ !== state.sliceIdx) syncMprSliceIndex();
    scheduleRedraw();
  });

  subscribe('mode', () => {
    syncSliceUI({ scrub: false });
    if (isMprActive() && state.mprZ !== state.sliceIdx) syncMprSliceIndex();
    scheduleRedraw({ fullMpr: true });
  });

  for (const key of ['window', 'level', 'imgs', 'loaded']) {
    subscribe(key, () => {
      if (key === 'imgs') clearMprCellCache();
      syncViewerRuntimeSession();
      scheduleRedraw({ fullMpr: true });
    });
  }

  for (const key of [
    'useBrain',
    'useSeg',
    'useSym',
    'useRegions',
    'segImgs',
    'segVoxels',
    'symImgs',
    'symVoxels',
    'regionImgs',
    'regionVoxels',
    'regionMeta',
    'fusionSlug',
    'fusionImgs',
    'fusionVoxels',
  ]) {
    subscribe(key, () => {
      const three = getThreeRuntime();
      if (key === 'useBrain' || key === 'useSeg' || key === 'useSym' || key === 'useRegions' || key === 'fusionSlug') {
        clearMprCellCache();
      }
      syncViewerRuntimeSession();
      ensureVisibleStackWindow();
      scheduleRedraw({ fullMpr: true });
      syncOverlayOpacityUI();
      renderFusionPicker();
      renderRegionLegend();
      renderVolumeTable();
      renderVolumes();
      if (three.mesh) {
        three.mesh.material.uniforms.uLabelAlpha.value = state.overlayOpacity;
        updateLabelTexture();
      }
      syncThreeSurfaceState();
    });
  }

  for (const key of ['overlayOpacity', 'fusionOpacity']) {
    subscribe(key, () => {
      const three = getThreeRuntime();
      scheduleRedraw({ fullMpr: true });
      syncOverlayOpacityUI();
      if (three.mesh) {
        three.mesh.material.uniforms.uLabelAlpha.value = state.overlayOpacity;
        updateLabelTexture();
      }
      syncThreeSurfaceState();
    });
  }

  for (const key of ['mprX', 'mprY']) {
    subscribe(key, () => {
      if (isMprActive()) scheduleRedraw({ fullMpr: true, interactiveMpr: true });
    });
  }

  for (const key of ['obYaw', 'obPitch']) {
    subscribe(key, () => {
      const yaw = $('ob-yaw-val');
      const pitch = $('ob-pitch-val');
      if (yaw) yaw.textContent = `${state.obYaw}°`;
      if (pitch) pitch.textContent = `${state.obPitch}°`;
    });
  }

  subscribe('mprGpuEnabled', () => {
    const toggle = $('mpr-gpu-toggle');
    const note = $('mpr-gpu-note');
    if (toggle) toggle.checked = !!state.mprGpuEnabled;
    if (note) note.textContent = state.mprGpuEnabled ? 'GPU active' : 'CPU fallback';
    if (isMprActive()) scheduleRedraw({ fullMpr: true, force: true });
  });

  for (const key of ['lowT', 'highT', 'intensity', 'clipMin', 'clipMax', 'renderMode']) {
    subscribe(key, () => {
      updateClipReadouts();
      updateUniforms();
    });
  }
}

/**
 * Sync all UI after state.sliceIdx changed.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.scrub=true]      Update scrub slider position
 * @param {boolean} [opts.fullMpr=false]   Full MPR redraw vs Z-plane only
 */
export function syncSlice({ scrub = true, fullMpr = false } = {}) {
  syncSliceUI({ scrub });
  redrawActiveViews({ fullMpr });
}

/**
 * Redraw all mode-appropriate canvases after an overlay or display change
 * (brain toggle, seg toggle, colormap change, window/level, invert, etc.).
 * Does NOT touch the scrub slider or slice counter — only redraws pixels.
 */
export function syncOverlays() {
  redrawActiveViews({ fullMpr: true });
}
