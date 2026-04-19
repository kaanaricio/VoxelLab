// 16-bit raw volume fetch, optional zstd decompress, Cache API, worker path.
// Invokes MPR redraw + 3D rebuild via callbacks registered in initHrVoxelsLoading.

import { $ } from './dom.js';
import { FZSTD_ESM_URL, VOLUME_CACHE_NAME } from './dependencies.js';
import { state } from './state.js';
import { softFail } from './error.js';
import { runVolumeWorker } from './volume-worker-client.js';
import { rawVolumeUrlForSeries } from './series-image-stack.js';
import { cleanupStaleCaches } from './cached-fetch.js';
import {
  clearHrLoadingState,
  setHrLoadingState,
  setHrVoxelCache,
} from './runtime/viewer-runtime.js';
import { syncViewerRuntimeSession } from './runtime/viewer-session.js';
import { touchLocalRawVolume } from './dicom-import.js';

const cleanupOldVolumeCaches = () => cleanupStaleCaches(
  'voxellab-volumes-',
  VOLUME_CACHE_NAME,
  ['mri-volumes-v1'],
);
// Fire-and-forget at module load: cleanup runs once, never blocks a fetch.
if ('caches' in self) cleanupOldVolumeCaches();

const callbacks = {
  is3dActive: () => false,
  isMprActive: () => false,
  drawMPR: () => {},
  rebuildVolume: async () => {},
};

export function initHrVoxelsLoading(deps) {
  callbacks.is3dActive = deps.is3dActive;
  callbacks.isMprActive = deps.isMprActive;
  callbacks.drawMPR = deps.drawMPR;
  callbacks.rebuildVolume = deps.rebuildVolume;
}

function showVolumeLoading(series, kind, key) {
  let el = $('volume-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'volume-loading';
    el.className = 'notify-item';
    document.getElementById('notify-container')?.appendChild(el)
      || document.body.appendChild(el);
  }
  const label = kind === 'compressed' ? 'Streaming volume' : 'Loading volume';
  el.dataset.loadingKey = key;
  el.textContent = `${label} · ${series.name || series.slug} …`;
  el.hidden = false;
}

function hideVolumeLoading(key = '') {
  const el = $('volume-loading');
  if (!el) return;
  if (key && el.dataset.loadingKey !== key) return;
  el.hidden = true;
  delete el.dataset.loadingKey;
}

/**
 * Loads (and caches) the 16-bit raw volume for the current series,
 * normalized to a Float32Array in the [0, 1] range. Shared by 3D
 * renderer + MPR reslicer.
 *
 * Returns Promise<Float32Array | null>. Null = no data available.
 */
export async function ensureHRVoxels() {
  const series = state.manifest.series[state.seriesIdx];
  if (!series.hasRaw && !series.rawUrl) return null;
  const key = `${state.seriesIdx}:${series.slug}:${series.rawUrl || ''}`;
  if (state.hrKey === key && state.hrVoxels) return state.hrVoxels;

  // Local imports: use the in-memory Float32 volume directly (no fetch needed).
  const localRaw = state._localRawVolumes?.[series.slug];
  if (localRaw) {
    touchLocalRawVolume(series.slug);
    setHrVoxelCache(localRaw, key);
    syncViewerRuntimeSession(series);
    if (callbacks.isMprActive()) callbacks.drawMPR();
    if (callbacks.is3dActive()) await callbacks.rebuildVolume();
    return localRaw;
  }

  if (state.hrLoading && state.hrLoadingKey === key) return state.hrLoading;
  if (state.hrAbortController && state.hrLoadingKey && state.hrLoadingKey !== key) {
    state.hrAbortController.abort();
  }

  const controller = new AbortController();
  setHrLoadingState({ key, controller });
  const promise = (async () => {
    try {
      const useCompressed = Boolean(series.rawUrl);
      const url = useCompressed ? rawVolumeUrlForSeries(series) : `./data/${series.slug}.raw`;
      const signal = controller.signal;

      showVolumeLoading(series, useCompressed ? 'compressed' : 'raw', key);

      let buf;
      const cache = useCompressed && 'caches' in self
        ? await softFail(caches.open(VOLUME_CACHE_NAME), 'high-res volume cache')
        : null;
      if (cache) {
        const cached = await cache.match(url);
        if (cached) {
          buf = await cached.arrayBuffer();
        } else {
          const r = await fetch(url, { signal });
          if (!r.ok) { hideVolumeLoading(key); return null; }
          buf = await r.arrayBuffer();
          cache.put(url, new Response(buf.slice(0), {
            headers: { 'Content-Type': 'application/zstd' },
          }));
        }
      } else {
        const r = await fetch(url, { signal });
        if (!r.ok) { hideVolumeLoading(key); return null; }
        buf = await r.arrayBuffer();
      }
      if (state.hrLoadingKey !== key) {
        hideVolumeLoading(key);
        return null;
      }

      const expected = series.width * series.height * series.slices;
      let f32;
      if (typeof Worker !== 'undefined') {
        f32 = await runVolumeWorker(buf, useCompressed, expected);
      } else {
        if (useCompressed) {
          const { decompress } = await import(FZSTD_ESM_URL);
          const decompressed = decompress(new Uint8Array(buf));
          buf = decompressed.buffer.slice(decompressed.byteOffset, decompressed.byteOffset + decompressed.byteLength);
        }
        const u16 = new Uint16Array(buf);
        if (u16.length !== expected) { hideVolumeLoading(key); return null; }
        f32 = new Float32Array(u16.length);
        const inv = 1 / 65535;
        for (let i = 0; i < u16.length; i++) f32[i] = u16[i] * inv;
      }
      if (!f32) { hideVolumeLoading(key); return null; }
      if (state.hrLoadingKey !== key) {
        hideVolumeLoading(key);
        return null;
      }
      setHrVoxelCache(f32, key);
      syncViewerRuntimeSession(series);
      hideVolumeLoading(key);
      if (callbacks.isMprActive()) callbacks.drawMPR();
      if (callbacks.is3dActive()) await callbacks.rebuildVolume();
      return f32;
    } catch (e) {
      if (e?.name !== 'AbortError') {
        console.warn(`raw volume fetch failed for ${series.slug}:`, e);
      }
      hideVolumeLoading(key);
      return null;
    } finally {
      clearHrLoadingState(key);
    }
  })();
  setHrLoadingState({ key, controller, promise });
  return promise;
}
