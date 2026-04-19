// Generic Cache-Storage-backed fetcher used by both image and JSON sidecar
// paths. Same versioned cleanup pattern as the original cachedImageResponse:
// bumping IMAGE_CACHE_VERSION wipes the prior bucket on next session via
// cleanupOldImageCaches.
//
// Eviction: browser quota only; URLs are absolute keys. After replacing
// content at the same URL, callers invalidate(url) before re-fetch
// (see analysis-findings.js, cloud.js).

import { IMAGE_CACHE_NAME } from './dependencies.js';

const INFLIGHT = new Map();
let _cachePromise = null;
let QUOTA_WARNED = false;

function supportsCacheStorage() {
  return !!(globalThis.caches && globalThis.URL && globalThis.fetch);
}

export function isHttpUrl(url) {
  try {
    const resolved = new URL(url, globalThis.location?.href || 'http://localhost/');
    return resolved.protocol === 'http:' || resolved.protocol === 'https:';
  } catch {
    return false;
  }
}

export function absoluteUrl(url) {
  return String(new URL(url, globalThis.location?.href || 'http://localhost/'));
}

function getCache() {
  if (!_cachePromise) _cachePromise = caches.open(IMAGE_CACHE_NAME);
  return _cachePromise;
}

/**
 * Drop stale buckets matching `prefix` other than `keep`, plus any one-shot
 * legacy bucket names that don't match the prefix. Used by the image cache
 * (this module) and the volume cache (volume-hr-voxels.js). Memoized per
 * (prefix, keep) so callers can fire-and-forget at module load.
 */
const _cleanupRuns = new Map();
export function cleanupStaleCaches(prefix, keep, legacy = []) {
  if (!supportsCacheStorage()) return Promise.resolve();
  const memoKey = `${prefix}\u0000${keep}`;
  const existing = _cleanupRuns.get(memoKey);
  if (existing) return existing;
  const legacySet = new Set(legacy);
  const run = caches.keys()
    .then((keys) => Promise.all(
      keys
        .filter((key) => (key.startsWith(prefix) || legacySet.has(key)) && key !== keep)
        .map((key) => caches.delete(key)),
    ))
    .catch(() => {})
    .then(() => {});
  _cleanupRuns.set(memoKey, run);
  return run;
}

export function cleanupOldImageCaches() {
  return cleanupStaleCaches('voxellab-images-', IMAGE_CACHE_NAME);
}

// Fire-and-forget at module load: cleanup runs once, never blocks a fetch.
if (supportsCacheStorage()) cleanupOldImageCaches();

/**
 * Cache-first fetch backed by Cache Storage. Falls through to a plain
 * fetch when Cache Storage is unavailable or the URL is not http(s).
 *
 * @param {string} url Absolute or root-relative URL.
 * @param {{ priority?: 'high' | 'low' | 'auto' }} [opts]
 * @returns {Promise<Response>} A clone of the cached or fetched response.
 */
export async function cachedFetchResponse(url, opts = {}) {
  if (!supportsCacheStorage() || !isHttpUrl(url)) {
    return fetch(url, opts.priority ? { priority: opts.priority } : undefined);
  }
  const cacheKey = absoluteUrl(url);
  const existing = INFLIGHT.get(cacheKey);
  if (existing) return (await existing).clone();
  const pending = (async () => {
    const cache = await getCache();
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const response = await fetch(cacheKey, opts.priority ? { priority: opts.priority } : undefined);
    if (response.ok) {
      try {
        await cache.put(cacheKey, response.clone());
      } catch (err) {
        // Quota or transient cache failure: keep serving the network response
        // uncached so the page still works.
        if (!QUOTA_WARNED) {
          QUOTA_WARNED = true;
          console.warn('voxellab cached-fetch: cache.put failed, falling back to network', err);
        }
      }
    }
    return response;
  })().finally(() => INFLIGHT.delete(cacheKey));
  INFLIGHT.set(cacheKey, pending);
  return (await pending).clone();
}

/** Drop one URL from the cache so the next read re-fetches. Used by regeneration writers. */
cachedFetchResponse.invalidate = async function invalidate(url) {
  if (!supportsCacheStorage() || !isHttpUrl(url)) return;
  try {
    const cache = await getCache();
    await cache.delete(absoluteUrl(url));
  } catch {
    // Best-effort.
  }
};

/** Convenience: cache-aware JSON fetch. Returns parsed body or null on miss/parse error. */
export async function cachedFetchJson(url) {
  try {
    const response = await cachedFetchResponse(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
