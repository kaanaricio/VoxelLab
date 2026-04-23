// Colormap registry. Each colormap is a 256×4 Uint8Array (RGBA LUT).
// The active colormap replaces the hardcoded grayscale in the W/L
// pixel-walk. Selectable via a dropdown in the toolbar.
//
// General-purpose: works for any modality. PET and functional MR need
// color LUTs; standard radiological grayscale is the default.

import { state } from './state.js';
import { setColormap as setColormapState } from './state/viewer-commands.js';

// Build a 256-entry RGBA LUT from a generator function.
// fn(t) → [r, g, b] where t ∈ [0, 1], r/g/b ∈ [0, 255].
function buildLUT(fn) {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const [r, g, b] = fn(t);
    lut[i * 4]     = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

export const COLORMAPS = {
  grayscale: {
    label: 'Grayscale',
    lut: buildLUT(t => { const v = clamp(t * 255); return [v, v, v]; }),
  },
  inverted: {
    label: 'Inverted',
    lut: buildLUT(t => { const v = clamp((1 - t) * 255); return [v, v, v]; }),
  },
  hot: {
    label: 'Hot',
    lut: buildLUT(t => [
      clamp(t < 0.33 ? t * 3 * 255 : 255),
      clamp(t < 0.33 ? 0 : t < 0.66 ? (t - 0.33) * 3 * 255 : 255),
      clamp(t < 0.66 ? 0 : (t - 0.66) * 3 * 255),
    ]),
  },
  cool: {
    label: 'Cool',
    lut: buildLUT(t => [
      clamp(t * 255),
      clamp((1 - t) * 255),
      255,
    ]),
  },
  bone: {
    label: 'Bone',
    lut: buildLUT(t => {
      // Blue-tinted grayscale — classic CT bone window look
      const r = clamp(t < 0.75 ? t * 255 * 0.99 : (0.25 + (t - 0.75) * 3) * 255);
      const g = clamp(t < 0.375 ? t * 255 * 0.99 : t < 0.75 ? (0.125 + (t - 0.375) * 2) * 255 * 0.99 : (0.375 + (t - 0.75) * 2.5) * 255);
      const b = clamp(t * 255 * 1.1);
      return [r, g, b];
    }),
  },
  pet: {
    label: 'PET',
    lut: buildLUT(t => {
      // Black → blue → cyan → green → yellow → red → white
      if (t < 0.15)      return [0, 0, clamp(t / 0.15 * 200)];
      if (t < 0.30)      return [0, clamp((t - 0.15) / 0.15 * 255), 200];
      if (t < 0.45)      return [0, 255, clamp(200 - (t - 0.30) / 0.15 * 200)];
      if (t < 0.60)      return [clamp((t - 0.45) / 0.15 * 255), 255, 0];
      if (t < 0.75)      return [255, clamp(255 - (t - 0.60) / 0.15 * 255), 0];
      if (t < 0.90)      return [255, clamp((t - 0.75) / 0.15 * 200), clamp((t - 0.75) / 0.15 * 200)];
      return [255, clamp(200 + (t - 0.90) / 0.10 * 55), clamp(200 + (t - 0.90) / 0.10 * 55)];
    }),
  },
  rainbow: {
    label: 'Rainbow',
    lut: buildLUT(t => {
      // HSV hue sweep, full saturation
      const h = t * 300; // 0-300 degrees (skip magenta wrap)
      const s = 1, v = 1;
      const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
      let r, g, b;
      if (h < 60)       { r = c; g = x; b = 0; }
      else if (h < 120) { r = x; g = c; b = 0; }
      else if (h < 180) { r = 0; g = c; b = x; }
      else if (h < 240) { r = 0; g = x; b = c; }
      else               { r = x; g = 0; b = c; }
      return [clamp((r + m) * 255), clamp((g + m) * 255), clamp((b + m) * 255)];
    }),
  },
};

export function getActiveLUT() {
  return COLORMAPS[state.colormap]?.lut || COLORMAPS.grayscale.lut;
}

export function setColormap(name) {
  if (!COLORMAPS[name]) return;
  setColormapState(name);
}

// Shape: uint8 source intensity 0..255 mapped into a uint8 LUT index 0..255.
export function mapWindowLevelByte(value, window = state.window, level = state.level) {
  const lo = level - window / 2;
  const range = Math.max(1, window);
  let idx = (((value - lo) / range) * 255 + 0.5) | 0;
  if (idx < 0) idx = 0;
  else if (idx > 255) idx = 255;
  return idx;
}

// Fused W/L + colormap: single 256-entry LUT for uint8 canvas pixels; rebuilt when
// window, level, or colormap change.

let _fusedKey = '';
let _fusedR = new Uint8Array(256);
let _fusedG = new Uint8Array(256);
let _fusedB = new Uint8Array(256);
let _fusedU32 = new Uint32Array(256);

function ensureFusedLUT() {
  const key = `${state.window}/${state.level}/${state.colormap}`;
  if (key === _fusedKey) return;
  _fusedKey = key;

  const cmapLut = getActiveLUT();

  for (let v = 0; v < 256; v++) {
    const idx = mapWindowLevelByte(v, state.window, state.level);
    const base = idx * 4;
    const r = cmapLut[base];
    const g = cmapLut[base + 1];
    const b = cmapLut[base + 2];
    _fusedR[v] = r;
    _fusedG[v] = g;
    _fusedB[v] = b;
    _fusedU32[v] = (255 << 24) | (b << 16) | (g << 8) | r;  // ABGR for little-endian
  }
}

// Apply W/L + colormap to an RGBA pixel buffer in place.
// Uses a precomputed 256-entry fused LUT — one array lookup per pixel,
// no per-pixel arithmetic.
export function applyWindowLevelWithColormap(d) {
  ensureFusedLUT();
  const len = d.length;
  // Fast path: Uint32Array bulk writes when possible
  const u32 = new Uint32Array(d.buffer, d.byteOffset, len >> 2);
  for (let i = 0, n = u32.length; i < n; i++) {
    // Read the red channel (first byte in RGBA) — all channels are
    // identical in the source grayscale image.
    u32[i] = _fusedU32[d[i << 2]];
  }
}

// Expose the fused LUT components for callers that need per-channel
// access (e.g. overlay compositing in slice-view.js).
export function getFusedWLLut() {
  ensureFusedLUT();
  return { r: _fusedR, g: _fusedG, b: _fusedB };
}

export function getFusedWLU32() {
  ensureFusedLUT();
  return _fusedU32;
}
