import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');
globalThis.window = globalThis.window || { addEventListener() {} };

const {
  obliqueBasis,
  obliquePlaneExtentMm,
  fitObliqueCanvas,
  sampleObliqueCompositeSlice,
} = await import('../js/mpr_oblique.js');
const { createMprProjection } = await import('../js/mpr-projection.js');

test('obliqueBasis keeps an orthonormal identity plane at zero yaw/pitch', () => {
  const basis = obliqueBasis(0, 0);
  assert.deepEqual(basis.u, [1, 0, 0]);
  assert.deepEqual(basis.v, [0, 1, 0]);
  assert.deepEqual(basis.n, [0, 0, 1]);
});

test('sampleObliqueCompositeSlice returns the shared byte contract for a base-only plane', () => {
  // Shape: 2x2 axial plane sampled from z=1 in a 2x2x2 byte volume.
  const vox = Uint8Array.from([
    0, 0, 0, 0,
    10, 20, 30, 40,
  ]);
  const sampled = sampleObliqueCompositeSlice(
    2,
    2,
    vox,
    1,
    { W: 2, H: 2, D: 2 },
    { row: 1, col: 1, slice: 1 },
    [0.5, 0.5, 1],
    0,
    0,
    1,
  );

  assert.equal(sampled.width, 2);
  assert.equal(sampled.height, 2);
  assert.deepEqual([...sampled.baseBytes], [10, 20, 30, 40]);
  assert.equal(sampled.segBytes, null);
  assert.equal(sampled.regionBytes, null);
  assert.equal(sampled.symBytes, null);
  assert.equal(sampled.fusionBytes, null);
});

test('sampleObliqueCompositeSlice keeps labels discrete while heatmaps interpolate', () => {
  // Shape: single-pixel oblique sample at x=0.49 between two source voxels.
  const sampled = sampleObliqueCompositeSlice(
    1,
    1,
    Uint8Array.from([0, 255]),
    1,
    { W: 2, H: 1, D: 1 },
    { row: 1, col: 1, slice: 1 },
    [0.49, 0, 0],
    0,
    0,
    0,
    {
      segVoxels: Uint8Array.from([1, 3]),
      regionVoxels: Uint8Array.from([9, 42]),
      symVoxels: Uint8Array.from([0, 200]),
      fusionVoxels: Uint8Array.from([0, 100]),
    },
  );

  assert.equal(sampled.baseBytes[0], 125);
  assert.equal(sampled.segBytes[0], 1, 'seg labels should stay nearest/discrete');
  assert.equal(sampled.regionBytes[0], 9, 'region labels should stay nearest/discrete');
  assert.equal(sampled.symBytes[0], 98, 'sym map should stay interpolated');
  assert.equal(sampled.fusionBytes[0], 49, 'fusion map should stay interpolated');
});

test('sampleObliqueCompositeSlice reuses caller-provided buffers when shape is unchanged', () => {
  // Shape: reusable sampled planes for a 2x2 oblique output.
  const first = sampleObliqueCompositeSlice(
    2,
    2,
    Uint8Array.from([
      0, 0, 0, 0,
      1, 2, 3, 4,
    ]),
    1,
    { W: 2, H: 2, D: 2 },
    { row: 1, col: 1, slice: 1 },
    [0.5, 0.5, 1],
    0,
    0,
    1,
    { segVoxels: Uint8Array.from([0, 0, 0, 0, 1, 2, 3, 0]) },
  );
  const second = sampleObliqueCompositeSlice(
    2,
    2,
    Uint8Array.from([
      0, 0, 0, 0,
      5, 6, 7, 8,
    ]),
    1,
    { W: 2, H: 2, D: 2 },
    { row: 1, col: 1, slice: 1 },
    [0.5, 0.5, 1],
    0,
    0,
    1,
    { segVoxels: Uint8Array.from([0, 0, 0, 0, 3, 2, 1, 0]) },
    first,
  );

  assert.equal(second, first);
  assert.deepEqual([...second.baseBytes], [5, 6, 7, 8]);
  assert.deepEqual([...second.segBytes], [3, 2, 1, 0]);
});

test('sampleObliqueCompositeSlice can thicken the slab with shared projection math', () => {
  const projection = createMprProjection(
    { mode: 'avg', slabThicknessMm: 2 },
    { row: 1, col: 1, slice: 1 },
    { axisU: [1, 0, 0], axisV: [0, 1, 0] },
  );
  const sampled = sampleObliqueCompositeSlice(
    2,
    2,
    Uint8Array.from([
      0, 0, 0, 0,
      100, 100, 100, 100,
      200, 200, 200, 200,
    ]),
    1,
    { W: 2, H: 2, D: 3 },
    { row: 1, col: 1, slice: 1 },
    [0.5, 0.5, 1],
    0,
    0,
    1,
    null,
    null,
    undefined,
    projection,
  );

  assert.deepEqual([...sampled.baseBytes], [100, 100, 100, 100]);
});

test('obliquePlaneExtentMm uses physical spacing so thick slices expand the oblique footprint', () => {
  const extent = obliquePlaneExtentMm(
    { W: 10, H: 8, D: 5 },
    { row: 1, col: 1, slice: 4 },
    [4.5, 3.5, 2],
    0,
    45,
  );

  assert.ok(extent.widthMm > 8, 'tilted plane should span more than the in-plane width');
  assert.ok(extent.heightMm > 16, 'thick-slice contribution should appear in physical-plane height');
});

test('fitObliqueCanvas preserves the physical plane aspect ratio inside the available stage', () => {
  const fitted = fitObliqueCanvas(800, 500, { widthMm: 240, heightMm: 120 });
  assert.deepEqual(fitted, { width: 800, height: 400 });
});
