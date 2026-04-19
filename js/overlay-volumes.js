// Shared overlay-volume extraction for MPR / 3D label paths.

import { state } from './state.js';
import { readImageByteData } from './overlay-data.js';
import { flattenImageBitmapsInWorker } from './volume-worker-client.js';
import { activeOverlayStateForSeries } from './runtime/active-overlay-state.js';
import { syncViewerRuntimeSession } from './runtime/viewer-session.js';

const TYPES = ['seg', 'regions', 'sym', 'fusion'];
const _pending = new Map();
let _onReady = () => {};

function workerFlattenAvailable() {
  return typeof Worker !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined'
    && typeof createImageBitmap === 'function';
}

function hasDenseLoadedImages(imgs, count) {
  if (!Array.isArray(imgs) || imgs.length !== count) return false;
  for (let i = 0; i < count; i++) {
    const img = imgs[i];
    if (!img || !img.complete || img.naturalWidth <= 0) return false;
  }
  return true;
}

function stackForType(type) {
  return {
    seg: state.segImgs,
    regions: state.regionImgs,
    sym: state.symImgs,
    fusion: state.fusionImgs,
  }[type] || null;
}

function stateKeyForType(type) {
  return {
    seg: 'segVoxels',
    regions: 'regionVoxels',
    sym: 'symVoxels',
    fusion: 'fusionVoxels',
  }[type];
}

function localRegionVolume(series, W, H, D) {
  const slices = state._localRegionLabelSlicesBySlug?.[series.slug];
  if (!Array.isArray(slices) || slices.length !== D) return null;
  const voxels = new Uint8Array(W * H * D);
  for (let z = 0; z < D; z++) {
    const slice = slices[z];
    if (!slice || slice.length !== W * H) return null;
    voxels.set(slice, z * W * H);
  }
  return voxels;
}

export function initOverlayVolumes({ onReady = () => {} } = {}) {
  _onReady = onReady;
}

async function buildVolumeFromWorker(type, series, imgs, W, H, D) {
  const key = `${series.slug}|${type}|${W}x${H}x${D}`;
  if (_pending.has(key)) return _pending.get(key);
  const promise = (async () => {
    let bitmaps = null;
    try {
      bitmaps = await Promise.all(imgs.slice(0, D).map((img) => createImageBitmap(img)));
      const voxels = await flattenImageBitmapsInWorker({ bitmaps, w: W, h: H, d: D });
      imgs._voxels = voxels;
      return voxels;
    } catch (err) {
      console.warn(`voxellab overlay-volumes: worker flatten failed for ${type}`, err);
      return null;
    } finally {
      for (const bitmap of bitmaps || []) bitmap?.close?.();
      _pending.delete(key);
    }
  })();
  _pending.set(key, promise);
  return promise;
}

function buildVolumeFromStack(type, series, W, H, D) {
  if (type === 'regions') {
    const local = localRegionVolume(series, W, H, D);
    if (local) return local;
  }

  const imgs = stackForType(type);
  if (!hasDenseLoadedImages(imgs, D)) {
    return null;
  }
  if (imgs._voxels?.length === W * H * D) return imgs._voxels;
  if (workerFlattenAvailable()) {
    buildVolumeFromWorker(type, series, imgs, W, H, D).then((voxels) => {
      if (!voxels) return;
      const activeSeries = state.manifest?.series?.[state.seriesIdx];
      if (activeSeries?.slug !== series.slug) return;
      const stateKey = stateKeyForType(type);
      if (!stateKey) return;
      state[stateKey] = voxels;
      syncViewerRuntimeSession(activeSeries);
      _onReady(type);
    });
    return null;
  }

  const voxels = new Uint8Array(W * H * D);
  for (let z = 0; z < D; z++) {
    const data = readImageByteData(imgs[z], W, H);
    if (!data) return null;
    voxels.set(data, z * W * H);
  }
  imgs._voxels = voxels;
  return voxels;
}

/** Ensure the currently-active overlay stacks have cached 3D byte volumes when possible. */
export function ensureActiveOverlayVolumes() {
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series) return;
  const overlays = activeOverlayStateForSeries(series);
  const W = series.width;
  const H = series.height;
  const D = series.slices;

  for (const type of TYPES) {
    const stateKey = stateKeyForType(type);
    if (!stateKey) continue;
    const enabled = {
      seg: overlays.tissue.enabled,
      regions: overlays.labels.enabled,
      sym: overlays.heatmap.enabled,
      fusion: overlays.fusion.enabled,
    }[type];
    const current = state[stateKey];
    const built = enabled ? buildVolumeFromStack(type, series, W, H, D) : null;
    state[stateKey] = enabled ? (built || current || null) : null;
  }
  syncViewerRuntimeSession(series);
}
