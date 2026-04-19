// Load PNG stacks for select-series and similar.
import { state, HAS_LOCAL_BACKEND } from './state.js';
import { hardFail, softFail } from './error.js';
import { cachedFetchResponse } from './cached-fetch.js';
import { BASE_PREFETCH_CONCURRENCY, DEFAULT_PREFETCH_LIMIT } from './constants.js';

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function useLocalAssetProxy(url) {
  try {
    if (!globalThis.location) return false;
    const parsed = new URL(url, globalThis.location.href);
    return HAS_LOCAL_BACKEND && parsed.origin !== globalThis.location.origin;
  } catch {
    return false;
  }
}

export function assetUrlForBrowser(url) {
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url, globalThis.location?.href || 'http://localhost/');
    if (!/^https?:$/i.test(parsed.protocol)) return url;
    return useLocalAssetProxy(parsed.href)
      ? `/api/proxy-asset?url=${encodeURIComponent(parsed.href)}`
      : parsed.href;
  } catch {
    return url;
  }
}

function shouldUseAnonymousCors(url) {
  try {
    if (!globalThis.location) return /^https?:\/\//i.test(url);
    return new URL(url, globalThis.location.href).origin !== globalThis.location.origin;
  } catch {
    return /^https?:\/\//i.test(url);
  }
}

function isHttpUrl(url) {
  try {
    const resolved = new URL(url, globalThis.location?.href || 'http://localhost/');
    return resolved.protocol === 'http:' || resolved.protocol === 'https:';
  } catch {
    return false;
  }
}

async function resolveImageSrc(url, priority) {
  // Browsers with Cache Storage flow through cachedFetchResponse → blob URL.
  // Tests and minimal runtimes fall back to direct image src.
  if (!isHttpUrl(url) || !globalThis.caches) {
    return { src: url, release: null };
  }
  const response = await cachedFetchResponse(url, priority ? { priority } : undefined);
  if (!response.ok) throw new Error(`Image request failed: ${url}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  return { src: objectUrl, release: () => URL.revokeObjectURL(objectUrl) };
}

function loadFreshImage(img, url, label, index, errorMode, priority) {
  return wrapLoader((async () => {
    // Set the DOM hint for the direct-src fallback path. The cached path
    // forwards `priority` into the underlying fetch() inside cachedFetchResponse,
    // which is where it actually matters for an in-flight network request.
    if (priority === 'high' && 'fetchPriority' in img) {
      img.fetchPriority = 'high';
    }
    const { src, release } = await resolveImageSrc(url, priority);
    try {
      await new Promise((resolve, reject) => {
        img.onload = () => resolve(true);
        img.onerror = () => reject(new Error(`Image ${index + 1} failed: ${url}`));
        if (src === url && shouldUseAnonymousCors(url)) img.crossOrigin = 'anonymous';
        img.src = src;
      });
      return true;
    } finally {
      img.onload = null;
      img.onerror = null;
      release?.();
    }
  })(), label, index, errorMode);
}

export function imageUrlForStack(dir, index, series = state.manifest?.series?.[state.seriesIdx]) {
  const file = `${String(index).padStart(4, '0')}.png`;
  if (!series) return `./data/${dir}/${file}`;

  if (dir === series.slug && series.sliceUrlBase) {
    return assetUrlForBrowser(`${trimSlash(series.sliceUrlBase)}/${file}`);
  }

  const overlayBase = series.overlayUrlBases?.[dir];
  if (overlayBase) return assetUrlForBrowser(`${trimSlash(overlayBase)}/${file}`);

  if (dir === `${series.slug}_regions` && series.regionUrlBase) {
    return assetUrlForBrowser(`${trimSlash(series.regionUrlBase)}/${file}`);
  }

  return `./data/${dir}/${file}`;
}

export function regionMetaUrlForSeries(series = state.manifest?.series?.[state.seriesIdx]) {
  if (!series?.slug) return '';

  if (series.regionMetaUrl) return assetUrlForBrowser(series.regionMetaUrl);

  return `./data/${series.slug}_regions.json`;
}

export function rawVolumeUrlForSeries(series = state.manifest?.series?.[state.seriesIdx]) {
  if (!series?.slug) return '';
  if (series.rawUrl) return assetUrlForBrowser(series.rawUrl);
  return `./data/${series.slug}.raw`;
}

function loadExistingImage(img, label, index, errorMode) {
  return wrapLoader(new Promise((resolve, reject) => {
    if (img.complete && img.naturalWidth > 0) resolve(true);
    else if (img.complete && img.naturalWidth === 0) reject(new Error(`Image ${index + 1} failed: ${img.src}`));
    else {
      img.onload = () => resolve(true);
      img.onerror = () => reject(new Error(`Image ${index + 1} failed: ${img.src}`));
    }
  }), label, index, errorMode);
}

function attachStackControls(imgs, dir, count, series, label, errorMode) {
  imgs._dir = dir;
  imgs._pending = imgs._pending || new Map();
  imgs._prefetchToken = imgs._prefetchToken || 0;
  imgs.ensureIndex = (index, opts) => {
    if (index < 0 || index >= count) return Promise.resolve(true);
    if (imgs[index]) return imgs._pending.get(index) || loadExistingImage(imgs[index], label, index, errorMode);
    const img = new Image();
    imgs[index] = img;
    const loader = loadFreshImage(img, imageUrlForStack(dir, index, series), label, index, errorMode, opts?.priority);
    imgs._pending.set(index, loader);
    loader.finally(() => imgs._pending.delete(index));
    return loader;
  };
  imgs.ensureWindow = (center, radius = 0) => Promise.all(
    Array.from({ length: radius * 2 + 1 }, (_, offset) => center - radius + offset)
      .filter(index => index >= 0 && index < count)
      .map(index => imgs.ensureIndex(index)),
  );
  imgs.prefetchRemaining = (
    center = 0,
    radius = 0,
    { concurrency = BASE_PREFETCH_CONCURRENCY, limit = DEFAULT_PREFETCH_LIMIT } = {},
  ) => {
    const indexes = [];
    for (let index = 0; index < count; index++) {
      if (index >= center - radius && index <= center + radius) continue;
      indexes.push(index);
    }
    indexes.sort((a, b) => (Math.abs(a - center) - Math.abs(b - center)) || (a - b));
    const queue = Number.isFinite(limit) ? indexes.slice(0, limit) : indexes;
    const token = ++imgs._prefetchToken;
    const workerCount = Math.min(Math.max(1, concurrency), queue.length || 1);
    const runWorker = async () => {
      while (queue.length && imgs._prefetchToken === token) {
        const nextIndex = queue.shift();
        await imgs.ensureIndex(nextIndex);
      }
    };
    return Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  };
  return imgs;
}

/**
 * @returns {{ imgs: HTMLImageElement[], loaders: Promise<void>[] }}
 */
export function loadImageStack(
  dir,
  count,
  existing,
  series = state.manifest?.series?.[state.seriesIdx],
  { label = dir, errorMode = 'soft', windowRadius = null, initialIndex = 0 } = {},
) {
  const local = state._localStacks?.[dir];
  if (local && local.length === count) {
    attachStackControls(local, dir, count, series, label, errorMode);
    return { imgs: local, loaders: local.map((img, index) => loadExistingImage(img, label, index, errorMode)) };
  }

  if (existing && existing.length === count && existing._dir === dir) {
    attachStackControls(existing, dir, count, series, label, errorMode);
    return { imgs: existing, loaders: [] };
  }
  const imgs = attachStackControls(new Array(count), dir, count, series, label, errorMode);
  const priorityFor = (index) => (index === initialIndex ? { priority: 'high' } : undefined);
  const loaders = windowRadius == null
    ? Array.from({ length: count }, (_, index) => imgs.ensureIndex(index, priorityFor(index)))
    : Array.from(
      { length: windowRadius * 2 + 1 },
      (_, offset) => initialIndex - windowRadius + offset,
    )
      .filter(index => index >= 0 && index < count)
      .map(index => imgs.ensureIndex(index, priorityFor(index)));
  return { imgs, loaders };
}

function wrapLoader(promise, label, index, errorMode) {
  const fail = errorMode === 'hard' ? hardFail : softFail;
  return fail(promise, `${label} image ${index + 1}`);
}
