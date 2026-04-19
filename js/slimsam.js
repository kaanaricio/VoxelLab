// SlimSAM integration — manifest, embedding fetch, ONNX decoder, overlay.
// See slimsam-fetch.js, slimsam-inference.js, slimsam-overlay.js.

import {
  slimsamSetManifest,
  slimsamFetchMeta,
  slimsamFetchEmbeddings,
} from './slimsam-fetch.js';
import {
  slimsamEnsureDecoderSession,
  slimsamRunDecoder,
} from './slimsam-inference.js';

export { overlayMask } from './slimsam-overlay.js';

let _manifestRef = null;

export function initSlimSAM(manifest) {
  _manifestRef = manifest;
  slimsamSetManifest(manifest);
}

export async function isSlimSAMAvailable(seriesIdx) {
  const series = _manifestRef?.series?.[seriesIdx];
  if (!series) return false;
  const slug = series.slug;

  try {
    const meta = await slimsamFetchMeta(slug);
    return meta !== null;
  } catch {
    return false;
  }
}

export async function runSlimSAMClick(x, y, sliceIdx, seriesIdx) {
  const series = _manifestRef?.series?.[seriesIdx];
  if (!series) return null;
  const slug = series.slug;

  const meta = await slimsamFetchMeta(slug);
  if (!meta) return null;

  const embedBuf = await slimsamFetchEmbeddings(slug, meta);
  if (!embedBuf) return null;

  if (sliceIdx < 0 || sliceIdx >= meta.slices) return null;
  const floatsPerSlice = meta.embed_dim * meta.embed_h * meta.embed_w;
  const offset = sliceIdx * floatsPerSlice;
  let allZero = true;
  for (let i = offset; i < offset + floatsPerSlice; i++) {
    if (embedBuf[i] !== 0) { allZero = false; break; }
  }
  if (allZero) {
    console.warn(`[slimsam] slice ${sliceIdx} of ${slug} has no embedding (skipped during encode)`);
    return null;
  }

  const session = await slimsamEnsureDecoderSession();
  if (!session) return null;

  try {
    return await slimsamRunDecoder(session, embedBuf, meta, sliceIdx, x, y);
  } catch (e) {
    console.error('[slimsam] decoder inference failed:', e);
    return null;
  }
}
