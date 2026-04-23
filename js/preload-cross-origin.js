// Dynamic, origin-agnostic preconnect + first-slice preload.
//
// Walks the loaded manifest after init, collects unique cross-origin hosts
// from any series field that points at remote bytes (sliceUrlBase, rawUrl,
// regionUrlBase, regionMetaUrl, overlayUrlBases), and injects one
// `<link rel="preconnect">` per origin. For the active series only, also
// injects a `<link rel="preload" as="image" fetchpriority="high">` for the
// first slice URL when that URL is cross-origin.
//
// No-op on local-only manifests: no DOM mutation or extra fetches.
//
// Origin discovery is dynamic: this module never names a specific host. It
// works for any user-supplied Cloudflare R2 bucket, custom domain, or other
// cross-origin source the end user points the manifest at.

import { imageUrlForStack } from './series-image-stack.js';

const INJECTED = new Set();

function pageOrigin() {
  try {
    return globalThis.location?.origin || '';
  } catch {
    return '';
  }
}

function originOf(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url, globalThis.location?.href || 'http://localhost/');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function isLocalProxyUrl(url) {
  try {
    return new URL(url, globalThis.location?.href || 'http://localhost/').pathname === '/api/proxy-asset';
  } catch {
    return false;
  }
}

function collectSeriesUrls(series) {
  const out = [];
  if (series.sliceUrlBase) out.push(series.sliceUrlBase);
  if (series.rawUrl) out.push(series.rawUrl);
  if (series.regionUrlBase) out.push(series.regionUrlBase);
  if (series.regionMetaUrl) out.push(series.regionMetaUrl);
  if (series.overlayUrlBases && typeof series.overlayUrlBases === 'object') {
    for (const value of Object.values(series.overlayUrlBases)) {
      if (typeof value === 'string') out.push(value);
    }
  }
  return out;
}

/**
 * Walk the manifest, return the deduped set of cross-origin host origins.
 * Excludes the page origin and anything that doesn't parse as http(s).
 *
 * @param {{ series?: Array<object> } | null} manifest
 * @returns {string[]}
 */
export function collectCrossOriginHosts(manifest) {
  if (!manifest || !Array.isArray(manifest.series)) return [];
  const self = pageOrigin();
  const hosts = new Set();
  for (const series of manifest.series) {
    if (!series) continue;
    for (const url of collectSeriesUrls(series)) {
      const origin = originOf(url);
      if (origin && origin !== self) hosts.add(origin);
    }
  }
  return [...hosts];
}

function injectLink(rel, href, extras = {}) {
  // Idempotent: skip if we've already injected this exact rel+href.
  const dedupeKey = `${rel}\u0000${href}`;
  if (INJECTED.has(dedupeKey)) return;
  if (typeof document === 'undefined' || !document.head) return;
  const link = document.createElement('link');
  link.rel = rel;
  link.href = href;
  for (const [key, value] of Object.entries(extras)) {
    if (value != null) link[key] = value;
  }
  document.head.appendChild(link);
  INJECTED.add(dedupeKey);
}

/**
 * Inject preconnect + active-series first-slice preload, dynamically derived
 * from the manifest. Safe to call multiple times; idempotent at href.
 *
 * @param {{ series?: Array<object> } | null} manifest
 * @param {object} [opts]
 * @param {number} [opts.activeSeriesIdx=0]
 */
export function applyCrossOriginPreloads(manifest, { activeSeriesIdx = 0 } = {}) {
  const hosts = collectCrossOriginHosts(manifest);
  for (const origin of hosts) {
    injectLink('preconnect', origin, { crossOrigin: 'anonymous' });
  }
  if (!hosts.length) return; // Local-only manifest: no further work.
  const active = manifest?.series?.[activeSeriesIdx];
  if (!active?.sliceUrlBase) return;
  // Route the URL through the same builder the loader uses, so localhost
  // dev hits /api/proxy-asset and avoids preloading a URL that the actual
  // fetch will never hit.
  const firstSliceUrl = imageUrlForStack(active.slug, 0, active);
  if (!originOf(firstSliceUrl)) return;
  if (isLocalProxyUrl(firstSliceUrl)) return;
  injectLink('preload', firstSliceUrl, {
    as: 'image',
    fetchPriority: 'high',
    crossOrigin: 'anonymous',
  });
}
