import assert from 'node:assert/strict';
import { test } from 'node:test';

import { effectiveSliceSpacing, mprPlaneSizes, mprVoxelForPixel } from '../js/mpr-geometry.js';

test('MPR geometry uses inter-slice IPP distance instead of slice slab thickness', () => {
  // Example value: 5 mm slice thickness with 6 mm slice-center spacing.
  const series = {
    slices: 11,
    width: 100,
    height: 80,
    pixelSpacing: [0.5, 0.25],
    sliceThickness: 5,
    firstIPP: [10, 20, 30],
    lastIPP: [10, 20, 90],
  };

  assert.equal(effectiveSliceSpacing(series), 6);
  assert.deepEqual(mprPlaneSizes(series), {
    axW: 100,
    axH: Math.round(80 * 0.5 / 0.25),
    coW: 100,
    coH: Math.round(11 * 6 / 0.25),
    saW: 80,
    saH: Math.round(11 * 6 / 0.5),
  });
});

test('MPR geometry falls back to sliceThickness when IPP endpoints are missing', () => {
  const series = {
    slices: 11,
    width: 100,
    height: 80,
    pixelSpacing: [0.5, 0.25],
    sliceThickness: 5,
  };

  assert.equal(effectiveSliceSpacing(series), 5);
  assert.deepEqual(mprPlaneSizes(series), {
    axW: 100,
    axH: Math.round(80 * 0.5 / 0.25),
    coW: 100,
    coH: Math.round(11 * 5 / 0.25),
    saW: 80,
    saH: Math.round(11 * 5 / 0.5),
  });
});

test('MPR pixel mapping preserves exact coronal and sagittal voxel axes', () => {
  const series = {
    slices: 5,
    width: 7,
    height: 9,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
  };
  const crosshair = { x: 3, y: 4, z: 2 };

  assert.deepEqual(mprVoxelForPixel('co', 6, 0, 7, 5, series, crosshair), [6, 4, 4]);
  assert.deepEqual(mprVoxelForPixel('co', 0, 4, 7, 5, series, crosshair), [0, 4, 0]);
  assert.deepEqual(mprVoxelForPixel('sa', 8, 0, 9, 5, series, crosshair), [3, 8, 4]);
  assert.deepEqual(mprVoxelForPixel('sa', 0, 4, 9, 5, series, crosshair), [3, 0, 0]);
});

test('MPR pixel mapping preserves axial voxels when row spacing stretches the pane height', () => {
  const series = {
    slices: 5,
    width: 7,
    height: 9,
    pixelSpacing: [2, 1],
    sliceThickness: 1,
  };
  const crosshair = { x: 3, y: 4, z: 2 };

  assert.deepEqual(mprVoxelForPixel('ax', 6, 0, 7, 17, series, crosshair), [6, 0, 2]);
  assert.deepEqual(mprVoxelForPixel('ax', 0, 16, 7, 17, series, crosshair), [0, 8, 2]);
});
