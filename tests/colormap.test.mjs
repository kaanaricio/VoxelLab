import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const { applyWindowLevelWithColormap, COLORMAPS, mapWindowLevelByte } = await import('../js/colormap.js');
const { state } = await import('../js/state.js');

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function expectedRgb(name, t) {
  if (name === 'grayscale') {
    const v = clamp(t * 255);
    return [v, v, v];
  }
  if (name === 'inverted') {
    const v = clamp((1 - t) * 255);
    return [v, v, v];
  }
  if (name === 'hot') {
    return [
      clamp(t < 0.33 ? t * 3 * 255 : 255),
      clamp(t < 0.33 ? 0 : t < 0.66 ? (t - 0.33) * 3 * 255 : 255),
      clamp(t < 0.66 ? 0 : (t - 0.66) * 3 * 255),
    ];
  }
  if (name === 'cool') {
    return [clamp(t * 255), clamp((1 - t) * 255), 255];
  }
  if (name === 'bone') {
    return [
      clamp(t < 0.75 ? t * 255 * 0.99 : (0.25 + (t - 0.75) * 3) * 255),
      clamp(t < 0.375 ? t * 255 * 0.99 : t < 0.75 ? (0.125 + (t - 0.375) * 2) * 255 * 0.99 : (0.375 + (t - 0.75) * 2.5) * 255),
      clamp(t * 255 * 1.1),
    ];
  }
  if (name === 'pet') {
    if (t < 0.15) return [0, 0, clamp(t / 0.15 * 200)];
    if (t < 0.30) return [0, clamp((t - 0.15) / 0.15 * 255), 200];
    if (t < 0.45) return [0, 255, clamp(200 - (t - 0.30) / 0.15 * 200)];
    if (t < 0.60) return [clamp((t - 0.45) / 0.15 * 255), 255, 0];
    if (t < 0.75) return [255, clamp(255 - (t - 0.60) / 0.15 * 255), 0];
    if (t < 0.90) return [255, clamp((t - 0.75) / 0.15 * 200), clamp((t - 0.75) / 0.15 * 200)];
    return [255, clamp(200 + (t - 0.90) / 0.10 * 55), clamp(200 + (t - 0.90) / 0.10 * 55)];
  }
  if (name === 'rainbow') {
    const h = t * 300;
    const c = 1;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    let r;
    let g;
    let b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else [r, g, b] = [x, 0, c];
    return [clamp(r * 255), clamp(g * 255), clamp(b * 255)];
  }
  throw new Error(`Unhandled colormap ${name}`);
}

function sampleRgba(name, index) {
  const lut = COLORMAPS[name].lut;
  return Array.from(lut.slice(index * 4, index * 4 + 4));
}

afterEach(() => {
  state.window = 255;
  state.level = 127.5;
  state.colormap = 'grayscale';
});

test('each colormap LUT matches boundary RGB samples at t=0, 0.5, 1', () => {
  for (const name of Object.keys(COLORMAPS)) {
    for (const index of [0, 128, 255]) {
      const t = index / 255;
      assert.deepEqual(sampleRgba(name, index), [...expectedRgb(name, t), 255], `${name} index ${index}`);
    }
  }
});

test('window/level byte mapping clamps to the expected grayscale range', () => {
  assert.equal(mapWindowLevelByte(0, 100, 100), 0);
  assert.equal(mapWindowLevelByte(50, 100, 100), 0);
  assert.equal(mapWindowLevelByte(100, 100, 100), 128);
  assert.equal(mapWindowLevelByte(150, 100, 100), 255);
  assert.equal(mapWindowLevelByte(250, 100, 100), 255);
});

test('applyWindowLevelWithColormap transforms grayscale pixels in place', () => {
  state.window = 100;
  state.level = 100;
  state.colormap = 'grayscale';

  // Shape: RGBA grayscale pixels for source intensities [0, 50, 100, 150].
  const data = new Uint8ClampedArray([
    0, 0, 0, 255,
    50, 50, 50, 255,
    100, 100, 100, 255,
    150, 150, 150, 255,
  ]);

  applyWindowLevelWithColormap(data);

  assert.deepEqual(Array.from(data), [
    0, 0, 0, 255,
    0, 0, 0, 255,
    128, 128, 128, 255,
    255, 255, 255, 255,
  ]);
});
