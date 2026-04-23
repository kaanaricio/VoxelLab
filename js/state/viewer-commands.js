import { state, batch } from '../state.js';
import { $ } from '../dom.js';
import { syncSliceCountAriaBusy } from '../toolbar-chrome.js';
import { clampSlabThicknessMm, normalizeMprProjectionMode } from '../mpr-projection.js';
import { normalizeRegionMeta } from '../region-meta.js';
import {
  clearRuntimeSelectionCaches,
  resetThreeRuntimeSession,
  restoreRuntimeVolumeCache,
  stashRuntimeVolumeCache,
} from '../runtime/viewer-runtime.js';
import { clampSliceIndex, currentSeriesSlug, getCurrentSeries } from './viewer-selectors.js';
import { setAskHistory } from './viewer-tool-commands.js';

export function setManifest(manifest) {
  state.manifest = manifest;
  return manifest;
}

export function setAnalysis(analysis) {
  state.analysis = analysis;
  return state.analysis;
}

export function setAnalysisBusy(busy) {
  state.analysisBusy = !!busy;
  return state.analysisBusy;
}

export function setRegionMeta(regionMeta) {
  state.regionMeta = normalizeRegionMeta(regionMeta);
  return state.regionMeta;
}

export function setStats(stats) {
  state.stats = stats || null;
  return state.stats;
}

export function setFusionSelection(slug) {
  state.fusionSlug = slug || null;
  return state.fusionSlug;
}

export function setSliceIndex(next, series = getCurrentSeries()) {
  const clamped = clampSliceIndex(next, series);
  state.sliceIdx = clamped;
  return clamped;
}

export function stepSlice(delta, series = getCurrentSeries()) {
  return setSliceIndex(state.sliceIdx + delta, series);
}

export function setWindowLevel(windowValue, levelValue) {
  batch(() => {
    state.window = Math.max(1, Math.min(512, windowValue));
    state.level = Math.max(0, Math.min(255, levelValue));
  });
  return { window: state.window, level: state.level };
}

export function setLoaded(loaded) {
  state.loaded = !!loaded;
  return state.loaded;
}

export function setZoomTransform({ zoom = state.zoom, tx = state.tx, ty = state.ty } = {}) {
  batch(() => {
    state.zoom = Math.max(0.5, Math.min(10, zoom));
    state.tx = tx;
    state.ty = ty;
  });
  return { zoom: state.zoom, tx: state.tx, ty: state.ty };
}

export function setFitZoom(scale) {
  batch(() => {
    state.zoom = Math.max(0.25, Math.min(1, scale));
    state.tx = 0;
    state.ty = 0;
  });
  return { zoom: state.zoom, tx: state.tx, ty: state.ty };
}

function ensureCompareViewportState() {
  state.compare ||= {};
  // Shape: { zoom: 1, tx: 0, ty: 0 }.
  state.compare.viewport ||= { zoom: 1, tx: 0, ty: 0 };
  return state.compare.viewport;
}

export function setCompareViewport({
  zoom = ensureCompareViewportState()?.zoom,
  tx = ensureCompareViewportState()?.tx,
  ty = ensureCompareViewportState()?.ty,
} = {}) {
  const view = ensureCompareViewportState();
  batch(() => {
    view.zoom = Math.max(1, Math.min(8, Number(zoom) || 1));
    view.tx = Number.isFinite(+tx) ? +tx : 0;
    view.ty = Number.isFinite(+ty) ? +ty : 0;
  });
  return { zoom: view.zoom, tx: view.tx, ty: view.ty };
}

export function resetCompareViewport() {
  return setCompareViewport({ zoom: 1, tx: 0, ty: 0 });
}

export function setViewMode(mode) {
  state.mode = mode;
  return mode;
}

export function setCineFps(fps) {
  state.cineFps = Number(fps) || 0;
  return state.cineFps;
}

export function setOverlayOpacity(opacity) {
  state.overlayOpacity = +opacity;
  return state.overlayOpacity;
}

export function setFusionOpacity(opacity) {
  state.fusionOpacity = +opacity;
  return state.fusionOpacity;
}

export function setRenderMode(mode) {
  state.renderMode = mode;
  return state.renderMode;
}

export function setColormap(name) {
  if (!name) return state.colormap;
  state.colormap = name;
  return state.colormap;
}

export function setVolumeTransfer({ lowT = state.lowT, highT = state.highT, intensity = state.intensity } = {}) {
  batch(() => {
    state.lowT = lowT;
    state.highT = highT;
    state.intensity = intensity;
  });
  return { lowT: state.lowT, highT: state.highT, intensity: state.intensity };
}

export function applyViewerPreset(preset = {}) {
  batch(() => {
    if (preset.lowT !== undefined) state.lowT = preset.lowT;
    if (preset.highT !== undefined) state.highT = preset.highT;
    if (preset.intensity !== undefined) state.intensity = preset.intensity;
    if (preset.clipMin) state.clipMin = preset.clipMin.slice();
    if (preset.clipMax) state.clipMax = preset.clipMax.slice();
    if (preset.mode) state.renderMode = preset.mode;
  });
  return {
    lowT: state.lowT,
    highT: state.highT,
    intensity: state.intensity,
    clipMin: state.clipMin.slice(),
    clipMax: state.clipMax.slice(),
    mode: state.renderMode,
  };
}

export function setClipRange(min, max) {
  batch(() => {
    if (min) state.clipMin = min.slice();
    if (max) state.clipMax = max.slice();
  });
  return { clipMin: state.clipMin.slice(), clipMax: state.clipMax.slice() };
}

export function setClipAxis(bound, axisIndex, value) {
  const nextMin = state.clipMin.slice();
  const nextMax = state.clipMax.slice();
  if (bound === 'min') nextMin[axisIndex] = Math.min(value, nextMax[axisIndex] - 0.01);
  if (bound === 'max') nextMax[axisIndex] = Math.max(value, nextMin[axisIndex] + 0.01);
  return setClipRange(nextMin, nextMax);
}

export function syncSeriesIdxForActiveSlug(manifest, activeSlug = currentSeriesSlug()) {
  if (!activeSlug) return -1;
  const nextIdx = manifest.series.findIndex((series) => series.slug === activeSlug);
  if (nextIdx >= 0) state.seriesIdx = nextIdx;
  return nextIdx;
}

export function setOverlayFlags(patch = {}) {
  batch(() => {
    for (const [key, value] of Object.entries(patch)) state[key] = value;
  });
  return patch;
}

export function setOverlayEnabled(stateKey, enabled, exclusive = []) {
  batch(() => {
    state[stateKey] = enabled;
    if (enabled) {
      for (const key of exclusive) state[key] = false;
    }
  });
  return !!state[stateKey];
}

export function enableRegionsIfAvailable(series = getCurrentSeries()) {
  if (series?.hasRegions) state.useRegions = true;
  return state.useRegions;
}

export function initializeSeriesViewState(series = getCurrentSeries()) {
  if (!series) return null;
  batch(() => {
    state.mprX = Math.floor(series.width / 2);
    state.mprY = Math.floor(series.height / 2);
    state.mprZ = Math.floor(series.slices / 2);
    state.mpr.viewports = {
      ax: { zoom: 1, tx: 0, ty: 0 },
      co: { zoom: 1, tx: 0, ty: 0 },
      sa: { zoom: 1, tx: 0, ty: 0 },
      ob: { zoom: 1, tx: 0, ty: 0 },
    };
    if (!series.hasBrain) state.useBrain = false;
    if (!series.hasSeg) state.useSeg = false;
    if (!series.hasRegions) state.useRegions = false;
    if (!series.hasSym) state.useSym = false;
  });
  return {
    mprX: state.mprX,
    mprY: state.mprY,
    mprZ: state.mprZ,
    useBrain: state.useBrain,
    useSeg: state.useSeg,
    useRegions: state.useRegions,
    useSym: state.useSym,
  };
}

export function setMprPosition(
  { x = state.mprX, y = state.mprY, z = state.mprZ } = {},
  series = getCurrentSeries(),
  { syncSlice = false } = {},
) {
  if (!series) return null;
  const nextX = Math.max(0, Math.min(series.width - 1, Math.round(x)));
  const nextY = Math.max(0, Math.min(series.height - 1, Math.round(y)));
  const nextZ = clampSliceIndex(Math.round(z), series);
  batch(() => {
    state.mprX = nextX;
    state.mprY = nextY;
    state.mprZ = nextZ;
    if (syncSlice) state.sliceIdx = nextZ;
  });
  return { mprX: state.mprX, mprY: state.mprY, mprZ: state.mprZ, sliceIdx: state.sliceIdx };
}

export function nudgeMprAxis(axis, delta, series = getCurrentSeries()) {
  if (axis === 'x') return setMprPosition({ x: state.mprX + delta }, series);
  if (axis === 'y') return setMprPosition({ y: state.mprY + delta }, series);
  return setMprPosition({ z: state.mprZ + delta }, series, { syncSlice: true });
}

export function syncMprSliceIndex(series = getCurrentSeries()) {
  return setMprPosition({ z: state.sliceIdx }, series);
}

export function setMprQuality(quality) {
  state.mprQuality = quality;
  return state.mprQuality;
}

export function setMprGpuEnabled(enabled) {
  state.mprGpuEnabled = !!enabled;
  return state.mprGpuEnabled;
}

function ensureMprViewportState(pane) {
  const key = pane === 'ax' || pane === 'co' || pane === 'sa' || pane === 'ob' ? pane : '';
  if (!key) return null;
  state.mpr.viewports ||= {};
  // Shape: { zoom: 1, tx: 0, ty: 0 }.
  state.mpr.viewports[key] ||= { zoom: 1, tx: 0, ty: 0 };
  return state.mpr.viewports[key];
}

export function setMprProjection({
  mode = state.mpr.projectionMode,
  slabThicknessMm = state.mpr.slabThicknessMm,
} = {}) {
  batch(() => {
    state.mpr.projectionMode = normalizeMprProjectionMode(mode);
    state.mpr.slabThicknessMm = clampSlabThicknessMm(slabThicknessMm);
  });
  return {
    mode: state.mpr.projectionMode,
    slabThicknessMm: state.mpr.slabThicknessMm,
  };
}

export function setMprViewport(pane, {
  zoom = ensureMprViewportState(pane)?.zoom,
  tx = ensureMprViewportState(pane)?.tx,
  ty = ensureMprViewportState(pane)?.ty,
} = {}) {
  const view = ensureMprViewportState(pane);
  if (!view) return null;
  batch(() => {
    view.zoom = Math.max(1, Math.min(8, Number(zoom) || 1));
    view.tx = Number.isFinite(+tx) ? +tx : 0;
    view.ty = Number.isFinite(+ty) ? +ty : 0;
  });
  return { zoom: view.zoom, tx: view.tx, ty: view.ty };
}

export function resetMprViewport(pane) {
  return setMprViewport(pane, { zoom: 1, tx: 0, ty: 0 });
}

export function setObliqueAngles({ yaw = state.obYaw, pitch = state.obPitch } = {}) {
  batch(() => {
    state.obYaw = +yaw;
    state.obPitch = +pitch;
  });
  return { obYaw: state.obYaw, obPitch: state.obPitch };
}

export function beginSeriesSelection(index, { preserveSlice = false } = {}) {
  const previousSeries = getCurrentSeries();
  const previousVariant = state.useBrain && previousSeries?.hasBrain ? 'brain' : 'base';
  const series = state.manifest.series[index];
  let requestId = 0;
  stashRuntimeVolumeCache(previousSeries, { variant: previousVariant });
  batch(() => {
    requestId = ++state.selectRequestId;
    state.seriesIdx = index;
    state.sliceIdx = preserveSlice
      ? clampSliceIndex(state.sliceIdx, series)
      : 0;
    state.loaded = false;
    const cur = $('slice-cur');
    const tot = $('slice-tot');
    if (cur) cur.textContent = '';
    if (tot) tot.textContent = '';
    syncSliceCountAriaBusy();
    state.analysis = null;
    state.regionMeta = null;
    state._localRtDoseBySlug[series.slug] = state._localRtDoseBySlug[series.slug] || [];
    state.stats = null;
    state.fusionSlug = null;
    state.askHistory = [];
    state.clipMin = [0, 0, 0];
    state.clipMax = [1, 1, 1];
  });
  clearRuntimeSelectionCaches();
  restoreRuntimeVolumeCache(series, { variant: state.useBrain && series?.hasBrain ? 'brain' : 'base' });
  return {
    requestId,
    series,
    sliceIdx: state.sliceIdx,
  };
}

export function isSeriesSelectionCurrent(requestId, seriesSlug) {
  return state.selectRequestId === requestId && currentSeriesSlug() === seriesSlug;
}

export function hydrateSeriesStacks({ imgs, segImgs, symImgs, regionImgs } = {}) {
  batch(() => {
    if (imgs) state.imgs = imgs;
    if (segImgs) state.segImgs = segImgs;
    if (symImgs) state.symImgs = symImgs;
    if (regionImgs) state.regionImgs = regionImgs;
  });
}

export function hydrateSeriesSidecars({ analysis, regionMeta, askHistory, stats } = {}) {
  batch(() => {
    if (analysis) state.analysis = analysis;
    if (regionMeta) setRegionMeta(regionMeta);
    if (Array.isArray(askHistory)) setAskHistory(askHistory);
    if (stats) setStats(stats);
  });
}

export function finishSeriesSelection() {
  batch(() => {
    state.loaded = true;
  });
  resetThreeRuntimeSession();
}

export function setBrainStack({ nextUseBrain, imgs }) {
  const series = getCurrentSeries();
  const previousVariant = state.useBrain && series?.hasBrain ? 'brain' : 'base';
  stashRuntimeVolumeCache(series, { variant: previousVariant });
  batch(() => {
    state.useBrain = nextUseBrain;
    state.loaded = false;
    state.imgs = imgs;
    state.cmpStacks = {};
  });
  clearRuntimeSelectionCaches();
  restoreRuntimeVolumeCache(series, { variant: nextUseBrain && series?.hasBrain ? 'brain' : 'base' });
  return state.useBrain;
}
