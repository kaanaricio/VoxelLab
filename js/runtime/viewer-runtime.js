import { batch, state } from '../state.js';
import { resetViewerRuntimeSession } from './viewer-session.js';

const OVERLAY_STACK_KEY = {
  seg: 'segImgs',
  sym: 'symImgs',
  regions: 'regionImgs',
};
const WARM_VOLUME_CACHE_LIMIT = 3;

function currentSeries() {
  return state.manifest?.series?.[state.seriesIdx] || null;
}

function volumeVariant(series = currentSeries(), useBrain = state.useBrain) {
  return useBrain && series?.hasBrain ? 'brain' : 'base';
}

function volumeEntryKey(series = currentSeries(), variant = volumeVariant(series)) {
  return series?.slug ? `${series.slug}|${variant}` : '';
}

export function getThreeRuntime() {
  return state.threeRuntime;
}

export function resetThreeRuntimeSession() {
  batch(() => {
    state.threeRuntime.seriesIdx = -1;
    state.threeRuntime.variant = '';
    state.threeRuntime.dataKey = '';
    state.threeRuntime.previewShown = false;
  });
}

export function setThreeRuntimeShell({ renderer, scene, camera, controls, startLoop }) {
  batch(() => {
    state.threeRuntime.renderer = renderer;
    state.threeRuntime.scene = scene;
    state.threeRuntime.camera = camera;
    state.threeRuntime.controls = controls;
    state.threeRuntime.startLoop = startLoop;
    state.threeRuntime.stopLoop = null;
    state.threeRuntime.requestRender = null;
    state.threeRuntime.renderNow = null;
    state.threeRuntime.mesh = null;
  });
}

export function setThreeRuntimeRenderFns({ startLoop = null, stopLoop = null, requestRender = null, renderNow = null } = {}) {
  batch(() => {
    state.threeRuntime.startLoop = startLoop;
    state.threeRuntime.stopLoop = stopLoop;
    state.threeRuntime.requestRender = requestRender;
    state.threeRuntime.renderNow = renderNow;
  });
}

export function setThreeRuntimeMesh(mesh, { seriesIdx, variant, dataKey }) {
  batch(() => {
    state.threeRuntime.mesh = mesh;
    state.threeRuntime.seriesIdx = seriesIdx;
    state.threeRuntime.variant = variant;
    state.threeRuntime.dataKey = dataKey;
  });
}

export function setThreePreviewShown(shown) {
  state.threeRuntime.previewShown = !!shown;
}

export function setOverlayStack(type, imgs) {
  const key = OVERLAY_STACK_KEY[type];
  if (!key) return null;
  state[key] = imgs;
  return state[key];
}

export function clearRuntimeSelectionCaches() {
  batch(() => {
    state.voxels = null;
    state.voxelsKey = '';
    state.hrVoxels = null;
    state.hrKey = '';
    state.hrLoading = null;
    state.hrLoadingKey = '';
    state.hrAbortController = null;
    state.segImgs = [];
    state.segVoxels = null;
    state.symImgs = [];
    state.symVoxels = null;
    state.regionImgs = [];
    state.regionVoxels = null;
    state.fusionImgs = null;
    state.fusionVoxels = null;
  });
  resetThreeRuntimeSession();
  resetViewerRuntimeSession();
}

export function stashRuntimeVolumeCache(series = currentSeries(), { variant = volumeVariant(series) } = {}) {
  if (!series) return false;
  const key = volumeEntryKey(series, variant);
  if (!key) return false;
  if (!state.voxels && !state.hrVoxels && !state.segVoxels && !state.symVoxels && !state.regionVoxels && !state.fusionVoxels) {
    return false;
  }
  // Shape: { key: "t2_axial|base", voxels: Uint8Array|null, hrVoxels: Float32Array|null, segVoxels: Uint8Array|null }.
  const entry = {
    key,
    slug: series.slug,
    variant,
    voxels: state.hrVoxels ? null : state.voxels,
    hrVoxels: state.hrVoxels || null,
    segVoxels: state.segVoxels || null,
    symVoxels: state.symVoxels || null,
    regionVoxels: state.regionVoxels || null,
    fusionVoxels: state.fusionVoxels || null,
    fusionSlug: state.fusionSlug || '',
  };
  batch(() => {
    const next = (state._seriesVolumeCacheEntries || []).filter((item) => item?.key !== key);
    next.unshift(entry);
    if (next.length > WARM_VOLUME_CACHE_LIMIT) next.length = WARM_VOLUME_CACHE_LIMIT;
    state._seriesVolumeCacheEntries = next;
  });
  return true;
}

export function restoreRuntimeVolumeCache(series = currentSeries(), { variant = volumeVariant(series) } = {}) {
  if (!series) return false;
  const key = volumeEntryKey(series, variant);
  const entries = state._seriesVolumeCacheEntries || [];
  const index = entries.findIndex((item) => item?.key === key);
  if (index < 0) return false;
  const entry = entries[index];
  batch(() => {
    if (index > 0) {
      const next = entries.slice();
      next.splice(index, 1);
      next.unshift(entry);
      state._seriesVolumeCacheEntries = next;
    }
    state.voxels = entry.voxels || null;
    state.voxelsKey = entry.voxels ? `${state.seriesIdx}|${variant}` : '';
    state.hrVoxels = entry.hrVoxels || null;
    state.hrKey = entry.hrVoxels ? `${state.seriesIdx}:${series.slug}:${series.rawUrl || ''}` : '';
    state.segVoxels = entry.segVoxels || null;
    state.symVoxels = entry.symVoxels || null;
    state.regionVoxels = entry.regionVoxels || null;
    state.fusionVoxels = entry.fusionSlug && entry.fusionSlug === state.fusionSlug
      ? (entry.fusionVoxels || null)
      : null;
  });
  return true;
}

export function setVoxelCache(voxels, key) {
  batch(() => {
    state.voxels = voxels;
    state.voxelsKey = key;
  });
}

export function invalidateVoxelCache({ dropData = false } = {}) {
  batch(() => {
    state.voxelsKey = '';
    if (dropData) state.voxels = null;
  });
}

export function clearFusionRuntime() {
  batch(() => {
    state.fusionImgs = null;
    state.fusionVoxels = null;
  });
}

export function setFusionRuntime({ slug = state.fusionSlug, imgs = state.fusionImgs, voxels = state.fusionVoxels } = {}) {
  batch(() => {
    state.fusionSlug = slug;
    state.fusionImgs = imgs;
    state.fusionVoxels = voxels;
  });
}

export function setHrLoadingState({ key = '', controller = null, promise = null } = {}) {
  batch(() => {
    state.hrLoadingKey = key;
    state.hrAbortController = controller;
    state.hrLoading = promise;
  });
}

export function clearHrLoadingState(key = '') {
  batch(() => {
    if (!key || state.hrLoadingKey === key) {
      state.hrLoading = null;
      state.hrLoadingKey = '';
    }
    if (!key || !state.hrLoadingKey) state.hrAbortController = null;
  });
}

export function setHrVoxelCache(voxels, key) {
  batch(() => {
    state.hrVoxels = voxels;
    state.hrKey = key;
  });
}
