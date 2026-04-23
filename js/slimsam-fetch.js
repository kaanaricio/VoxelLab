// SAM embedding + metadata fetch for the SlimSAM browser tool.

import { FZSTD_ESM_URL } from './dependencies.js';

let _manifest = null;
let _r2Base = null;
const _metaCache = {};
const _embedCache = {};

export function slimsamSetManifest(manifest) {
  _manifest = manifest;
  _r2Base = null;
}

function _inferR2Base() {
  if (_r2Base) return _r2Base;
  if (!_manifest) return null;
  for (const s of _manifest.series || []) {
    if (s.rawUrl) {
      const idx = s.rawUrl.lastIndexOf('/');
      if (idx > 0) {
        _r2Base = s.rawUrl.slice(0, idx);
        return _r2Base;
      }
    }
  }
  return null;
}

export async function slimsamFetchMeta(slug) {
  if (slug in _metaCache) return _metaCache[slug];

  const localUrl = `./data/${slug}_sam_meta.json`;
  try {
    const r = await fetch(localUrl);
    if (r.ok) {
      const meta = await r.json();
      _metaCache[slug] = meta;
      return meta;
    }
  } catch { /* fall through */ }

  const base = _inferR2Base();
  if (base) {
    try {
      const r = await fetch(`${base}/${slug}_sam_meta.json`);
      if (r.ok) {
        const meta = await r.json();
        _metaCache[slug] = meta;
        return meta;
      }
    } catch { /* fall through */ }
  }

  _metaCache[slug] = null;
  return null;
}

export async function slimsamFetchEmbeddings(slug, meta) {
  if (slug in _embedCache) return _embedCache[slug];

  const totalFloats = meta.slices * meta.embed_dim * meta.embed_h * meta.embed_w;
  const base = _inferR2Base();

  try {
    const local = await fetch(`./data/${slug}_sam_embed.bin`);
    if (local.ok) {
      return slimsamProcessEmbedResponse(slug, local, false, totalFloats);
    }
  } catch { /* fall through */ }

  if (base) {
    try {
      const compressed = await fetch(`${base}/${slug}_sam_embed.bin.zst`);
      if (compressed.ok) {
        return slimsamProcessEmbedResponse(slug, compressed, true, totalFloats);
      }
      const fallback = await fetch(`${base}/${slug}_sam_embed.bin`);
      if (fallback.ok) {
        return slimsamProcessEmbedResponse(slug, fallback, false, totalFloats);
      }
    } catch (e) {
      console.error(`[slimsam] fetch embeddings for ${slug} failed:`, e);
    }
  }

  _embedCache[slug] = null;
  return null;
}

export async function slimsamProcessEmbedResponse(slug, response, compressed, totalFloats) {
  let buf = await response.arrayBuffer();

  if (compressed) {
    const { decompress } = await import(FZSTD_ESM_URL);
    const decompressed = decompress(new Uint8Array(buf));
    buf = decompressed.buffer.slice(
      decompressed.byteOffset,
      decompressed.byteOffset + decompressed.byteLength,
    );
  }

  const f16 = new Uint16Array(buf);
  if (f16.length !== totalFloats) {
    console.warn(
      `[slimsam] embedding size mismatch for ${slug}: ` +
      `got ${f16.length}, expected ${totalFloats}`
    );
    _embedCache[slug] = null;
    return null;
  }

  const f32 = new Float32Array(totalFloats);
  for (let i = 0; i < totalFloats; i++) {
    f32[i] = float16ToFloat32(f16[i]);
  }

  _embedCache[slug] = f32;
  return f32;
}

function float16ToFloat32(h) {
  const sign = (h >> 15) & 1;
  const exp  = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;

  if (exp === 0) {
    if (frac === 0) return sign ? -0 : 0;
    return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
  }
  if (exp === 0x1f) {
    return frac ? NaN : (sign ? -Infinity : Infinity);
  }
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}
