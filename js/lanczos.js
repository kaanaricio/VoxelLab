// Lanczos-3 resampling helpers for the MPR reslicer.
//
// The MPR's sagittal and coronal views reslice the volume across the
// thick-slice axis (typically 5 mm). Between two real slices we have to
// synthesize values, and the sharpness of that synthesis is almost
// entirely determined by the interpolation kernel.
//
// Before this module we used a Catmull-Rom cubic Hermite through 4
// neighboring slices — smooth but slightly soft. Lanczos-3 uses a 6-tap
// windowed-sinc kernel that gives sharper edges at roughly 2× the cost
// per sample. For a coronal view on a 27-slice T2 that's maybe 10-20 ms
// extra per frame. Well worth it for the visible sharpness on tissue
// boundaries.
//
// Reference: https://en.wikipedia.org/wiki/Lanczos_resampling
//
// The sinc function is defined as sin(π x) / (π x) and the Lanczos-a
// window is sinc(x / a) with support on |x| < a. We use a = 3.

const PI = Math.PI;

// --- Precomputed sinc table ---------------------------------------------------
// sinc(x) = sin(πx) / (πx), with sinc(0) = 1.
// We store 1025 entries covering x in [0, 3] so that any |t| < 3 can be
// resolved with a single table lookup + linear interpolation instead of two
// Math.sin calls.  Resolution is 3/1024 ≈ 0.00293 — more than enough for
// visually indistinguishable results from the analytic kernel.
const SINC_TABLE_SIZE = 1024;          // number of *intervals* (entries = SIZE+1)
const SINC_TABLE_MAX  = 3;            // table covers [0, SINC_TABLE_MAX]
const SINC_TABLE_SCALE = SINC_TABLE_SIZE / SINC_TABLE_MAX;  // index = x * SCALE
const _sincTable = new Float64Array(SINC_TABLE_SIZE + 1);

for (let i = 0; i <= SINC_TABLE_SIZE; i++) {
  const x = (i / SINC_TABLE_SIZE) * SINC_TABLE_MAX;   // x in [0, 3]
  if (x === 0) {
    _sincTable[i] = 1;
  } else {
    const pix = PI * x;
    _sincTable[i] = Math.sin(pix) / pix;
  }
}

// Fast sinc lookup with linear interpolation.  x must be >= 0 and < SINC_TABLE_MAX.
function sincLookup(x) {
  const fi = x * SINC_TABLE_SCALE;     // fractional index
  const i  = fi | 0;                   // integer part (floor)
  const f  = fi - i;                   // fractional remainder
  return _sincTable[i] + (_sincTable[i + 1] - _sincTable[i]) * f;
}

// Shape: |x| sampled against the precomputed sinc table over [0, 3].
export function sampleSinc(x) {
  const ax = x < 0 ? -x : x;
  if (ax >= SINC_TABLE_MAX) return 0;
  return sincLookup(ax);
}

// Windowed sinc value at offset t with window radius a. Returns 0 outside
// the support window, handles t=0 directly to avoid the removable
// singularity in sin(πt)/(πt).
//
// Uses the precomputed sinc table instead of Math.sin for speed — eliminates
// ~3.1 M transcendental calls on a 512×512 oblique canvas.
export function lanczosKernel(t, a = 3) {
  if (t === 0) return 1;
  if (t <= -a || t >= a) return 0;
  const at = t < 0 ? -t : t;          // |t|
  return sincLookup(at) * sincLookup(at / a);
}

// Shape: six exact Lanczos-3 weights for z taps iFloor-2..iFloor+3.
const _wBuf = new Float64Array(6);
export function lanczosWeights6(t) {
  _wBuf[0] = lanczosKernel(t + 2);
  _wBuf[1] = lanczosKernel(t + 1);
  _wBuf[2] = lanczosKernel(t);
  _wBuf[3] = lanczosKernel(t - 1);
  _wBuf[4] = lanczosKernel(t - 2);
  _wBuf[5] = lanczosKernel(t - 3);
  return _wBuf;
}

function sampleBilinearAtBase(vox, base, row0, row1, x0, x1, w00, w10, w01, w11) {
  const c00 = vox[base + row0 + x0];
  const c10 = vox[base + row0 + x1];
  const c01 = vox[base + row1 + x0];
  const c11 = vox[base + row1 + x1];
  return c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11;
}

// Sample a 3D volume along the z axis with Lanczos-3, and in-plane with
// bilinear (in-plane resolution is already ~0.5 mm — the z axis is where
// we have the 5 mm gap that needs the sharper kernel).
//
//   vox      — Uint8Array | Float32Array, row-major (D,H,W)
//   x, y, z  — fractional voxel coords (clamped to the volume)
//   W, H, D  — dimensions
//
// Returns a single intensity value in the native unit of `vox`.
export function sampleLanczosZ(vox, x, y, z, W, H, D) {
  if (x < 0) x = 0; else if (x > W - 1) x = W - 1;
  if (y < 0) y = 0; else if (y > H - 1) y = H - 1;
  if (z < 0) z = 0; else if (z > D - 1) z = D - 1;

  const WH = W * H;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < W ? x0 + 1 : x0;
  const y1 = y0 + 1 < H ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const oneMinusFx = 1 - fx;
  const oneMinusFy = 1 - fy;
  const w00 = oneMinusFx * oneMinusFy;
  const w10 = fx * oneMinusFy;
  const w01 = oneMinusFx * fy;
  const w11 = fx * fy;
  const row0 = y0 * W;
  const row1 = y1 * W;

  const z1 = z | 0;
  const t = z - z1;

  // With fewer than 6 slices we can't support Lanczos-3 — fall back
  // to linear in z (the two nearest slices).
  if (D < 6) {
    const z2 = z1 + 1 < D ? z1 + 1 : z1;
    const a = sampleBilinearAtBase(vox, z1 * WH, row0, row1, x0, x1, w00, w10, w01, w11);
    const b = sampleBilinearAtBase(vox, z2 * WH, row0, row1, x0, x1, w00, w10, w01, w11);
    return a * (1 - t) + b * t;
  }

  const weights = lanczosWeights6(t);
  let sum = 0, norm = 0;
  for (let k = 0; k < 6; k++) {
    const zi = z1 - 2 + k;
    // Clamp at volume boundary — extend by edge value rather than
    // sampling outside (which would be undefined).
    const zc = zi < 0 ? 0 : zi >= D ? D - 1 : zi;
    const v = sampleBilinearAtBase(vox, zc * WH, row0, row1, x0, x1, w00, w10, w01, w11);
    sum  += weights[k] * v;
    norm += weights[k];
  }
  // Normalize by the sum of kernel weights — this keeps DC (constant
  // regions) stable even when clamping truncates some taps near the
  // volume edge.
  return norm !== 0 ? sum / norm : 0;
}

// Bilinear sample of a single z-slice at fractional (x, y). Shared by
// both Lanczos and the fast paths.
export function sampleBilinearXY(vox, z, x, y, W, H) {
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 + 1 < W ? x0 + 1 : x0;
  const y1 = y0 + 1 < H ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const pz = z * W * H;
  const c00 = vox[pz + y0 * W + x0];
  const c10 = vox[pz + y0 * W + x1];
  const c01 = vox[pz + y1 * W + x0];
  const c11 = vox[pz + y1 * W + x1];
  const c0 = c00 * (1 - fx) + c10 * fx;
  const c1 = c01 * (1 - fx) + c11 * fx;
  return c0 * (1 - fy) + c1 * fy;
}

export function sampleLinearZ(vox, x, y, z, W, H, D) {
  if (x < 0) x = 0; else if (x > W - 1) x = W - 1;
  if (y < 0) y = 0; else if (y > H - 1) y = H - 1;
  if (z < 0) z = 0; else if (z > D - 1) z = D - 1;
  const z0 = z | 0;
  const z1 = z0 + 1 < D ? z0 + 1 : z0;
  const tz = z - z0;
  const a = sampleBilinearXY(vox, z0, x, y, W, H);
  const b = sampleBilinearXY(vox, z1, x, y, W, H);
  return a * (1 - tz) + b * tz;
}
