import { CDN_DEPENDENCY_URLS, SERVICE_WORKER_VERSION } from './js/dependencies.js';

const STATIC_CACHE = `voxellab-static-${SERVICE_WORKER_VERSION}`;
const CDN_CACHE = `voxellab-cdn-${SERVICE_WORKER_VERSION}`;
const DATA_CACHE = `voxellab-data-${SERVICE_WORKER_VERSION}`;

const CORE_ASSETS = [
  './',
  './index.html',
  './icons.svg',
  './config.json',
  './viewer.js',
  './js/theme-init.js',
  './js/index-init.js',
  './js/bootstrap.js',
  './js/chrome-shell.js',
  './js/shell-constants.js',
  './js/shell-mobile.js',
  './js/shell-layout-toggles.js',
  './js/template-loader.js',
  './js/dependencies.js',
  './css/base.css',
  './css/responsive.css',
  './css/sidebar.css',
  './css/viewer.css',
  './css/toolbar.css',
  './css/panels.css',
  './css/modals.css',
  './css/command-palette.css',
  './templates/sidebar.html',
  './templates/viewer-shell.html',
  './templates/toolbar.html',
  './templates/panels.html',
  './templates/command-palette.html',
  './templates/modals-shell.html',
  './templates/help-modal.html',
  './templates/upload-modal.html',
  './templates/ask-modal.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const staticCache = await caches.open(STATIC_CACHE);
    await staticCache.addAll(CORE_ASSETS);
    const cdnCache = await caches.open(CDN_CACHE);
    await Promise.all(CDN_DEPENDENCY_URLS.map((url) => cdnCache.add(url).catch(() => null)));

    const dataCache = await caches.open(DATA_CACHE);
    const manifestResponse = await fetch('./data/manifest.json').catch(() => null);
    if (manifestResponse?.ok) {
      const manifestUrl = new URL('./data/manifest.json', self.location.href).href;
      await dataCache.put(manifestUrl, manifestResponse.clone());
      const manifest = await manifestResponse.json().catch(() => null);
      const urls = manifest ? localManifestAssetUrls(manifest) : [];
      await Promise.all(urls.map((url) => dataCache.add(url).catch(() => null)));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([STATIC_CACHE, CDN_CACHE, DATA_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => (keep.has(key) ? null : caches.delete(key))));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin && !isCdnRequest(url)) return;

  if (isCdnRequest(url)) {
    event.respondWith(cacheFirst(event.request, CDN_CACHE));
    return;
  }

  if (isLocalStaticRequest(url)) {
    event.respondWith(networkFirst(event.request, STATIC_CACHE));
    return;
  }

  if (isLocalDataRequest(url)) {
    event.respondWith(networkFirst(event.request, DATA_CACHE));
  }
});

function isCdnRequest(url) {
  return url.origin === 'https://cdn.jsdelivr.net';
}

function isLocalStaticRequest(url) {
  return (
    url.origin === self.location.origin &&
    (
      url.pathname === '/' ||
      url.pathname.endsWith('/index.html') ||
      url.pathname.endsWith('/icons.svg') ||
      url.pathname.endsWith('/config.json') ||
      url.pathname.startsWith('/js/') ||
      url.pathname.startsWith('/css/') ||
      url.pathname.startsWith('/templates/')
    )
  );
}

function isLocalDataRequest(url) {
  return url.origin === self.location.origin && url.pathname.startsWith('/data/');
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || Response.error();
  }
}

function localManifestAssetUrls(manifest) {
  const urls = [];
  for (const series of manifest.series || []) {
    if (series.sliceUrlBase || series.rawUrl) continue;
    const slug = String(series.slug || '');
    const slices = Number(series.slices || 0);
    if (!slug || slices <= 0) continue;
    for (let index = 0; index < slices; index++) {
      urls.push(`./data/${slug}/${String(index).padStart(4, '0')}.png`);
    }
    urls.push(`./data/${slug}_analysis.json`, `./data/${slug}_asks.json`, `./data/${slug}_stats.json`);
    if (series.hasRegions) {
      urls.push(`./data/${slug}_regions.json`);
      for (let index = 0; index < slices; index++) {
        urls.push(`./data/${slug}_regions/${String(index).padStart(4, '0')}.png`);
      }
    }
    if (series.hasSeg) {
      for (let index = 0; index < slices; index++) {
        urls.push(`./data/${slug}_seg/${String(index).padStart(4, '0')}.png`);
      }
    }
    if (series.hasSym) {
      for (let index = 0; index < slices; index++) {
        urls.push(`./data/${slug}_sym/${String(index).padStart(4, '0')}.png`);
      }
    }
  }
  return urls;
}
