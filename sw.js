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
  './js/adc.js',
  './js/analysis-findings.js',
  './js/angle.js',
  './js/annotation-graph.js',
  './js/annotation.js',
  './js/auto-window-level.js',
  './js/theme-init.js',
  './js/index-init.js',
  './js/bootstrap.js',
  './js/cached-fetch.js',
  './js/chrome-shell.js',
  './js/cine.js',
  './js/clear-slice-drawings.js',
  './js/clip-readouts.js',
  './js/cloud.js',
  './js/collapsible-sidebar.js',
  './js/colormap.js',
  './js/command-palette.js',
  './js/compare.js',
  './js/config.js',
  './js/constants.js',
  './js/consult-ask.js',
  './js/coords.js',
  './js/dependencies.js',
  './js/derived-objects.js',
  './js/dicom-codecs.js',
  './js/dicom-derived-import.js',
  './js/dicom-frame-meta.js',
  './js/dicom-import-parse.js',
  './js/dicom-import.js',
  './js/dicom-sr-collect.js',
  './js/dicom-sr-dataset.js',
  './js/dicom-sr-utils.js',
  './js/dicom_sr.js',
  './js/dicomweb/dicomweb-source.js',
  './js/dicomweb/session-transport.js',
  './js/dom.js',
  './js/error.js',
  './js/fusion-regions.js',
  './js/geometry.js',
  './js/info-tips.js',
  './js/inspection-readout.js',
  './js/lanczos.js',
  './js/local-backend-mode.js',
  './js/measure.js',
  './js/metadata.js',
  './js/mode-flags.js',
  './js/mpr-geometry.js',
  './js/mpr-gpu.js',
  './js/mpr-projection.js',
  './js/mpr-view.js',
  './js/mpr_oblique.js',
  './js/notify.js',
  './js/overlay-data.js',
  './js/overlay-preferences.js',
  './js/overlay-stack.js',
  './js/overlay-volumes.js',
  './js/panel-range-fills.js',
  './js/perf-trace.js',
  './js/plugin.js',
  './js/preload-cross-origin.js',
  './js/projects-sidebar.js',
  './js/projects-store.js',
  './js/projects.js',
  './js/raw-slice-data.js',
  './js/region-meta.js',
  './js/roi-geometry.js',
  './js/roi.js',
  './js/runtime-flags.js',
  './js/runtime/active-overlay-state.js',
  './js/runtime/overlay-kinds.js',
  './js/runtime/review-readiness.js',
  './js/runtime/three-surface-state.js',
  './js/runtime/viewer-runtime.js',
  './js/runtime/viewer-session-shape.js',
  './js/runtime/viewer-session.js',
  './js/screenshot.js',
  './js/select-series-dom.js',
  './js/select-series.js',
  './js/series-capabilities.js',
  './js/series-contract.js',
  './js/series-image-stack.js',
  './js/shell-constants.js',
  './js/shell-mobile.js',
  './js/shell-layout-toggles.js',
  './js/slice-compositor.js',
  './js/slice-view.js',
  './js/slimsam-fetch.js',
  './js/slimsam-inference.js',
  './js/slimsam-overlay.js',
  './js/slimsam-tool.js',
  './js/slimsam.js',
  './js/sparkline.js',
  './js/spinner.js',
  './js/state.js',
  './js/state/app-model.js',
  './js/state/runtime-state.js',
  './js/state/viewer-commands.js',
  './js/state/viewer-selectors.js',
  './js/state/viewer-tool-commands.js',
  './js/study-upload-modal.js',
  './js/sync.js',
  './js/template-loader.js',
  './js/theme-icons.js',
  './js/toolbar-chrome.js',
  './js/tooltips.js',
  './js/touch.js',
  './js/two-d-tools.js',
  './js/ultrasound.js',
  './js/vendor-three.js',
  './js/vendor-trackball-controls.js',
  './js/view-modes.js',
  './js/view-transform.js',
  './js/viewport.js',
  './js/volume-3d-hover.js',
  './js/volume-3d-views.js',
  './js/volume-3d.js',
  './js/volume-hr-voxels.js',
  './js/volume-image-readiness.js',
  './js/volume-label-overlay.js',
  './js/volume-raycast-material.js',
  './js/volume-raycast-shaders.js',
  './js/volume-three-bootstrap.js',
  './js/volume-voxels-ensure.js',
  './js/volume-worker-client.js',
  './js/volume-worker.js',
  './js/volumes-panel.js',
  './js/wire-controls-keyboard.js',
  './js/wire-controls-mpr-panel.js',
  './js/wire-controls-view-canvas.js',
  './js/wire-controls.js',
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
    event.respondWith(networkFirstData(event.request));
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

async function networkFirstData(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.status === 401 || response.status === 403) {
      await caches.delete(DATA_CACHE);
    } else if (response.ok && !request.headers.has('Authorization')) {
      await cache.put(request, response.clone());
    }
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
