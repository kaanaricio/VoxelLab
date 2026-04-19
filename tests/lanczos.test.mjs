import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lanczosKernel, lanczosWeights6, sampleLanczosZ, sampleSinc } from '../js/lanczos.js';

function exactLanczosKernel(t, a = 3) {
  if (t === 0) return 1;
  if (t <= -a || t >= a) return 0;
  const piT = Math.PI * t;
  const piTa = piT / a;
  return (Math.sin(piT) / piT) * (Math.sin(piTa) / piTa);
}

function exactBilinearXY(vox, z, x, y, W, H) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const i = z * W * H;
  const c00 = vox[i + y0 * W + x0];
  const c10 = vox[i + y0 * W + x1];
  const c01 = vox[i + y1 * W + x0];
  const c11 = vox[i + y1 * W + x1];
  const a = c00 * (1 - fx) + c10 * fx;
  const b = c01 * (1 - fx) + c11 * fx;
  return a * (1 - fy) + b * fy;
}

function exactSampleLanczosZ(vox, x, y, z, W, H, D) {
  if (x < 0) x = 0; else if (x > W - 1) x = W - 1;
  if (y < 0) y = 0; else if (y > H - 1) y = H - 1;
  if (z < 0) z = 0; else if (z > D - 1) z = D - 1;

  const z1 = Math.floor(z);
  const t = z - z1;
  if (D < 6) {
    const z2 = Math.min(D - 1, z1 + 1);
    const a = exactBilinearXY(vox, z1, x, y, W, H);
    const b = exactBilinearXY(vox, z2, x, y, W, H);
    return a * (1 - t) + b * t;
  }

  let sum = 0;
  let norm = 0;
  for (let k = 0; k < 6; k++) {
    const zi = z1 + k - 2;
    const zc = zi < 0 ? 0 : zi >= D ? D - 1 : zi;
    const weight = exactLanczosKernel(t - (k - 2));
    sum += weight * exactBilinearXY(vox, zc, x, y, W, H);
    norm += weight;
  }
  return norm ? sum / norm : exactBilinearXY(vox, z1, x, y, W, H);
}

test('sinc lookup Lanczos kernel stays within analytic error budget', () => {
  let maxError = 0;
  for (let i = 0; i <= 30000; i++) {
    const t = -3 + (i * 6) / 30000;
    maxError = Math.max(maxError, Math.abs(lanczosKernel(t) - exactLanczosKernel(t)));
  }
  assert.ok(maxError < 1e-5, `max Lanczos kernel error ${maxError}`);
});

test('sinc table hits known values at stable points', () => {
  assert.ok(Math.abs(sampleSinc(0) - 1) < 1e-12);
  assert.ok(Math.abs(sampleSinc(0.5) - (2 / Math.PI)) < 5e-4);
  assert.ok(Math.abs(sampleSinc(1) - (Math.sin(Math.PI) / Math.PI)) < 5e-4);
  assert.ok(Math.abs(sampleSinc(2) - (Math.sin(2 * Math.PI) / (2 * Math.PI))) < 5e-4);
});

test('Lanczos-3 tap weights stay normalized around the z support window', () => {
  for (const t of [0, 0.125, 0.25, 0.5, 0.75]) {
    const weights = Array.from(lanczosWeights6(t));
    const sum = weights.reduce((acc, value) => acc + value, 0);
    assert.ok(Math.abs(sum - 1) < 2e-2, `weight sum ${sum} at t=${t}`);
  }
});

test('optimized z sampler tracks analytic Lanczos on a deterministic volume', () => {
  const W = 7, H = 5, D = 9;
  const vox = new Float64Array(W * H * D);
  for (let z = 0; z < D; z++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        vox[z * W * H + y * W + x] = 13 * z + 3 * y + x + ((x * y + z) % 5) / 10;
      }
    }
  }

  for (const [x, y, z] of [[0.2, 0.6, 0.4], [3.4, 2.25, 4.7], [5.8, 3.1, 7.6]]) {
    const fast = sampleLanczosZ(vox, x, y, z, W, H, D);
    const exact = exactSampleLanczosZ(vox, x, y, z, W, H, D);
    assert.ok(Math.abs(fast - exact) < 2e-4, `sample error ${Math.abs(fast - exact)}`);
  }
});

test('optimized z sampler handles a step-function volume across the slice boundary', () => {
  const W = 1, H = 1, D = 8;
  const vox = new Float64Array([0, 0, 0, 0, 1, 1, 1, 1]);

  for (const z of [2.5, 3, 3.25, 3.5, 3.75, 4]) {
    const fast = sampleLanczosZ(vox, 0, 0, z, W, H, D);
    const exact = exactSampleLanczosZ(vox, 0, 0, z, W, H, D);
    assert.ok(Math.abs(fast - exact) < 2e-4, `step sample error ${Math.abs(fast - exact)} at z=${z}`);
  }
});
