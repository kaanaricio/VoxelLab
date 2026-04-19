// Flatten slice PNGs into Uint8 stacks (+ seg / region volumes). Shared by
// 3D, MPR, and slice hover. See viewer.js / volume-3d orchestration.

import { state } from './state.js';
import { ensureActiveOverlayVolumes } from './overlay-volumes.js';
import { flattenImageBitmapsInWorker } from './volume-worker-client.js';
import { setVoxelCache } from './runtime/viewer-runtime.js';
import { syncViewerRuntimeSession } from './runtime/viewer-session.js';
import { touchLocalRawVolume } from './dicom-import.js';

let _renderVolumes = () => {};

// In-flight Promise sentinel keyed by `${seriesIdx}|${variant}` so concurrent
// callers (e.g. select-series + an MPR re-entry) share one off-thread build.
const _pendingBuilds = new Map();

function hasDenseLoadedImages(imgs, count) {
  if (!Array.isArray(imgs) || imgs.length !== count) return false;
  for (let i = 0; i < count; i++) {
    const img = imgs[i];
    if (!img || !img.complete || img.naturalWidth <= 0) return false;
  }
  return true;
}

function workerFlattenAvailable() {
  return typeof Worker !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined'
    && typeof createImageBitmap === 'function';
}

/**
 * Pre-build the base voxel volume off the main thread before any sync
 * ensureVoxels() call hits the synchronous fallback. Safe to call
 * multiple times — concurrent callers share one in-flight build, and a
 * cached result short-circuits immediately.
 *
 * Skips when: voxels already cached for this key; local raw volume present
 * (already optimal); worker/OffscreenCanvas/createImageBitmap unavailable;
 * slice images not all loaded yet.
 *
 * @returns {Promise<boolean>} true if the worker built voxels (or they were
 *   already cached), false if the caller should fall through to the
 *   synchronous main-thread path.
 */
export async function tryFlattenVoxelsInWorker() {
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series) return false;
  const variant = state.useBrain ? 'brain' : 'base';
  const key = `${state.seriesIdx}|${variant}`;
  if (state.voxels && state.voxelsKey === key) return true;

  // Local raw volumes are already in memory as Float32; the sync path is
  // fastest there because it just clamps to uint8 inline.
  const localRaw = !state.useBrain && state._localRawVolumes?.[series.slug];
  if (localRaw) {
    touchLocalRawVolume(series.slug);
    return false;
  }

  if (!workerFlattenAvailable()) return false;
  const W = series.width, H = series.height, D = series.slices;
  if (!hasDenseLoadedImages(state.imgs, D)) return false;

  const inflight = _pendingBuilds.get(key);
  if (inflight) {
    try { await inflight; } catch { /* fall through */ }
    return state.voxels && state.voxelsKey === key;
  }

  // Snapshot the imgs array up front; series-switch races later are caught
  // by the post-await `state.voxelsKey` re-check.
  const sourceImgs = state.imgs.slice(0, D);
  const build = (async () => {
    let bitmaps;
    try {
      bitmaps = await Promise.all(sourceImgs.map((img) => createImageBitmap(img)));
    } catch (err) {
      console.warn('voxellab tryFlattenVoxelsInWorker: createImageBitmap failed', err);
      return null;
    }
    try {
      return await flattenImageBitmapsInWorker({ bitmaps, w: W, h: H, d: D });
    } catch (err) {
      console.warn('voxellab tryFlattenVoxelsInWorker: worker rejected', err);
      // If the worker rejected before postMessage handed ownership over (capability
      // check, validation, throw), the bitmaps still belong to us — close them.
      for (const bmp of bitmaps) bmp?.close?.();
      return null;
    }
  })();
  _pendingBuilds.set(key, build);
  let bytes = null;
  try {
    bytes = await build;
  } finally {
    _pendingBuilds.delete(key);
  }
  if (!bytes) return false;
  // Series-switch race: the user moved to a different series during the
  // build. Drop the result silently — the new selection will rebuild.
  const stillCurrent = state.manifest?.series?.[state.seriesIdx]?.slug === series.slug
    && state.useBrain === (variant === 'brain');
  if (!stillCurrent) return false;
  setVoxelCache(bytes, key);
  const hadSeg = !!state.segVoxels;
  const hadRegions = !!state.regionVoxels;
  ensureActiveOverlayVolumes();
  syncViewerRuntimeSession(series);
  if ((!hadSeg && state.segVoxels) || (!hadRegions && state.regionVoxels)) _renderVolumes();
  return true;
}

/** Called from initVolume3D with the same renderVolumes as the rest of the app. */
export function initEnsureVoxels(deps) {
  _renderVolumes = deps.renderVolumes;
}

/**
 * Reads every slice PNG into a flat Uint8Array once per (series, variant) so
 * both 3D and MPR can share it. Also reads the seg mask stack when present.
 */
export function ensureVoxels() {
  const series = state.manifest.series[state.seriesIdx];
  const variant = state.useBrain ? 'brain' : 'base';
  const key = `${state.seriesIdx}|${variant}`;
  if (state.voxels && state.voxelsKey === key) {
    ensureActiveOverlayVolumes();
    return true;
  }

  const W = series.width, H = series.height, D = series.slices;
  const voxels = new Uint8Array(W * H * D);
  const localRaw = !state.useBrain && state._localRawVolumes?.[series.slug];
  if (localRaw && localRaw.length === voxels.length) {
    touchLocalRawVolume(series.slug);
    for (let i = 0; i < localRaw.length; i++) voxels[i] = Math.max(0, Math.min(255, Math.round(localRaw[i] * 255)));
  } else {
    if (!hasDenseLoadedImages(state.imgs, D)) return false;
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    for (let z = 0; z < D; z++) {
      tctx.drawImage(state.imgs[z], 0, 0, W, H);
      const data = tctx.getImageData(0, 0, W, H).data;
      for (let i = 0, p = z * W * H; i < data.length; i += 4, p++) {
        voxels[p] = data[i];
      }
    }
  }
  setVoxelCache(voxels, key);
  const hadSeg = !!state.segVoxels;
  const hadRegions = !!state.regionVoxels;
  ensureActiveOverlayVolumes();
  syncViewerRuntimeSession(series);
  if ((!hadSeg && state.segVoxels) || (!hadRegions && state.regionVoxels)) _renderVolumes();
  return true;
}
