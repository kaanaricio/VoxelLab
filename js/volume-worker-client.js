// Main-thread bridge to js/volume-worker.js — fzstd decompress +
// uint16→float32 offloaded so the UI stays responsive on large volumes.

let _volumeWorker = null;
let _workerIdCounter = 0;
const _workerCallbacks = new Map();

function getVolumeWorker() {
  if (!_volumeWorker) {
    _volumeWorker = new Worker('./js/volume-worker.js', { type: 'module' });
    _volumeWorker.onmessage = (e) => {
      const { id } = e.data;
      const cb = _workerCallbacks.get(id);
      if (!cb) return;
      if (e.data.type === 'progress') {
        cb.onProgress?.(e.data.stage, e.data.detail);
        return;
      }
      _workerCallbacks.delete(id);
      if (e.data.type === 'result') cb.resolve(e.data.f32);
      else if (e.data.type === 'flatten-result') cb.resolve(e.data.bytes);
      else if (e.data.type === 'dicom-result') cb.resolve(e.data.payload || null);
      else if (e.data.type === 'error') cb.reject?.(new Error(e.data.error)) || cb.resolve(null);
      else cb.resolve(null);
    };
  }
  return _volumeWorker;
}

/**
 * Flatten slice ImageBitmaps into one Uint8Array (length === w * h * d) off the
 * main thread. Caller is responsible for
 * `createImageBitmap(<img>)` on the main thread; ownership of the bitmaps
 * is transferred to the worker. Throws if the worker is unavailable.
 *
 * @param {{ bitmaps: ImageBitmap[], w: number, h: number, d: number }} opts
 * @returns {Promise<Uint8Array>}
 */
export function flattenImageBitmapsInWorker({ bitmaps, w, h, d }) {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return Promise.reject(new Error('flattenImageBitmapsInWorker: Worker/OffscreenCanvas unavailable'));
  }
  if (!Array.isArray(bitmaps) || bitmaps.length !== d) {
    return Promise.reject(new Error('flattenImageBitmapsInWorker: bitmap count mismatch'));
  }
  return new Promise((resolve, reject) => {
    const id = ++_workerIdCounter;
    _workerCallbacks.set(id, {
      resolve: (bytes) => bytes ? resolve(bytes) : reject(new Error('flatten failed')),
      reject,
    });
    getVolumeWorker().postMessage(
      { type: 'flatten-image-bitmaps', id, bitmaps, w, h, d },
      bitmaps,
    );
  });
}

export function runVolumeWorker(buffer, compressed, _expectedVoxels) {
  return new Promise((resolve) => {
    const id = ++_workerIdCounter;
    _workerCallbacks.set(id, { resolve });
    const worker = getVolumeWorker();
    worker.postMessage(
      { type: 'decompress', id, buffer, compressed },
      [buffer],
    );
  });
}

export function parseDicomFilesInWorker(files, onProgress = () => {}) {
  return new Promise((resolve) => {
    const id = ++_workerIdCounter;
    _workerCallbacks.set(id, { resolve, onProgress });
    getVolumeWorker().postMessage({ type: 'parse-dicom-files', id, files });
  });
}
