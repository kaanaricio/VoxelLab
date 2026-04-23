import { DCMJS_IMPORT_URL, FZSTD_ESM_URL } from './dependencies.js';

// Web Worker for heavy volume operations. Runs off the main thread so
// fzstd decompression + uint16→float32 conversion don't freeze the UI.
//
// Messages:
//   { type: 'decompress', id, buffer, compressed }
//     → decompresses (if compressed), converts uint16 LE → float32 [0,1]
//     → posts back { type: 'result', id, f32 } with f32 as transferable
//
// The worker is stateless — each message is independent. The main thread
// manages caching, series identity, and GPU upload.

let decompress = null;
let dcmjs = null;

async function ensureDcmjs() {
  if (dcmjs) return dcmjs;
  dcmjs = await import(DCMJS_IMPORT_URL);
  return dcmjs;
}

function looksLikeSourceManifest(payload) {
  return payload && typeof payload === 'object'
    && (payload.sourceKind === 'projection' || payload.sourceKind === 'ultrasound');
}

self.onmessage = async (e) => {
  const { type, id } = e.data;

  if (type === 'decompress') {
    try {
      let buf = e.data.buffer;

      // Decompress if the source is zstd-compressed
      if (e.data.compressed) {
        if (!decompress) {
          ({ decompress } = await import(FZSTD_ESM_URL));
        }
        const compressed = new Uint8Array(buf);
        const decompressed = decompress(compressed);
        buf = decompressed.buffer.slice(
          decompressed.byteOffset,
          decompressed.byteOffset + decompressed.byteLength,
        );
      }

      // Convert uint16 LE → float32 normalized [0, 1]
      const u16 = new Uint16Array(buf);
      const f32 = new Float32Array(u16.length);
      const inv = 1 / 65535;
      for (let i = 0; i < u16.length; i++) f32[i] = u16[i] * inv;

      // Transfer the Float32Array buffer back (zero-copy)
      self.postMessage({ type: 'result', id, f32 }, [f32.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
  }

  if (type === 'flatten-image-bitmaps') {
    try {
      const { bitmaps, w, h, d } = e.data;
      if (!Array.isArray(bitmaps) || bitmaps.length !== d) {
        throw new Error(`flatten-image-bitmaps: got ${bitmaps?.length} bitmaps, expected ${d}`);
      }
      // Reuse one OffscreenCanvas across slices to avoid per-slice GC churn.
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const out = new Uint8Array(w * h * d);
      for (let z = 0; z < d; z++) {
        const bmp = bitmaps[z];
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        // Single channel from R; PNG slice writers store luminance.
        const base = z * w * h;
        for (let i = 0, p = 0; i < rgba.length; i += 4, p++) out[base + p] = rgba[i];
        bmp.close?.();
      }
      self.postMessage({ type: 'flatten-result', id, bytes: out }, [out.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
    return;
  }

  if (type === 'parse-dicom-files') {
    try {
      const lib = await ensureDcmjs();
      const DicomMessage = lib.data.DicomMessage;
      const datasets = [];
      const sourceManifests = {};
      let parsed = 0;

      for (const file of e.data.files || []) {
        if (/\.json$/i.test(file?.name || '')) {
          try {
            const payload = JSON.parse(await file.text());
            if (looksLikeSourceManifest(payload) && payload.seriesUID) {
              sourceManifests[String(payload.seriesUID)] = payload;
            }
          } catch {
            // Ignore sidecar JSON that is not a source manifest.
          }
          continue;
        }
        try {
          const ab = await file.arrayBuffer();
          const ds = DicomMessage.readFile(ab);
          const meta = lib.data.DicomMetaDictionary.naturalizeDataset(ds.dict);
          if (!meta.PixelData) continue;
          datasets.push({ meta, pixelData: ds.dict['7FE00010'] });
          parsed++;
          if (parsed % 10 === 0) {
            self.postMessage({
              type: 'progress',
              id,
              stage: 'parsing',
              detail: `${parsed} / ${e.data.files.length}`,
            });
          }
        } catch {
          // Skip unparseable files.
        }
      }

      self.postMessage({
        type: 'dicom-result',
        id,
        payload: { datasets, sourceManifests },
      });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
  }
};
