/** Bump when static assets must replace SW caches; no query-string cache busting elsewhere. */
export const SERVICE_WORKER_VERSION = '2026-04-12-9';
export const IMAGE_CACHE_VERSION = '2026-04-11-2';
export const IMAGE_CACHE_NAME = `voxellab-images-${IMAGE_CACHE_VERSION}`;
export const VOLUME_CACHE_VERSION = '2026-04-11-1';
export const VOLUME_CACHE_NAME = `voxellab-volumes-${VOLUME_CACHE_VERSION}`;

export const THREE_MODULE_URL = 'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js';
export const THREE_ADDONS_URL = 'https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/';

export const DCMJS_IMPORT_URL = 'https://cdn.jsdelivr.net/npm/dcmjs@0.33.0/build/dcmjs.es.js';
export const DCMJS_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/dcmjs@0.33.0/build/dcmjs.min.js';
export const PAKO_ESM_URL = 'https://cdn.jsdelivr.net/npm/pako@2.1.0/+esm';
export const FZSTD_ESM_URL = 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/+esm';

export const ORT_MODULE_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.mjs';
export const ORT_WASM_BASE_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/';

export const OPENJPEG_CODEC_URL = 'https://cdn.jsdelivr.net/npm/@cornerstonejs/codec-openjpeg@1.3.0/dist/openjpegwasm.min.js';
export const CHARLS_CODEC_URL = 'https://cdn.jsdelivr.net/npm/@cornerstonejs/codec-charls@1.2.3/dist/charlswasm.min.js';

export const CDN_DEPENDENCY_URLS = [
  THREE_MODULE_URL,
  `${THREE_ADDONS_URL}controls/OrbitControls.js`,
  DCMJS_IMPORT_URL,
  DCMJS_SCRIPT_URL,
  PAKO_ESM_URL,
  FZSTD_ESM_URL,
  ORT_MODULE_URL,
  OPENJPEG_CODEC_URL,
  CHARLS_CODEC_URL,
];
