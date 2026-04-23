import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  clampSlabThicknessMm,
  createMprProjection,
  normalizeMprProjectionMode,
  projectVolumeSample,
  projectionCacheToken,
} = await import('../js/mpr-projection.js');

test('projection helpers normalize mode and slab thickness bounds', () => {
  assert.equal(normalizeMprProjectionMode('mip'), 'mip');
  assert.equal(normalizeMprProjectionMode('bad'), 'thin');
  assert.equal(clampSlabThicknessMm(-5), 0);
  assert.equal(clampSlabThicknessMm(999), 160);
});

test('createMprProjection derives slab sampling from plane normal and spacing', () => {
  const projection = createMprProjection(
    { mode: 'avg', slabThicknessMm: 6 },
    { row: 1, col: 1, slice: 2 },
    { axisU: [1, 0, 0], axisV: [0, 1, 0] },
  );

  assert.equal(projection.mode, 'avg');
  assert.ok(projection.sampleCount > 1);
  assert.deepEqual(projection.slabStep, [0, 0, 0.5]);
  assert.equal(projectionCacheToken(projection), `avg:6:${projection.sampleCount}`);
});

test('createMprProjection uses physical-space plane normal for anisotropic voxels', () => {
  const projection = createMprProjection(
    { mode: 'avg', slabThicknessMm: 6 },
    { row: 1, col: 1, slice: 3 },
    { axisU: [1, 0, 0], axisV: [0, 1, 1] },
  );
  const axisUPhysical = [1, 0, 0];
  const axisVPhysical = [0, 1, 3];
  const stepPhysical = [
    projection.slabStep[0],
    projection.slabStep[1],
    projection.slabStep[2] * 3,
  ];

  assert.ok(Math.abs(stepPhysical[0] * axisUPhysical[0] + stepPhysical[1] * axisUPhysical[1] + stepPhysical[2] * axisUPhysical[2]) < 1e-6);
  assert.ok(Math.abs(stepPhysical[0] * axisVPhysical[0] + stepPhysical[1] * axisVPhysical[1] + stepPhysical[2] * axisVPhysical[2]) < 1e-6);
});

test('projectVolumeSample supports avg, mip, and minip slab aggregation', () => {
  const dims = { W: 1, H: 1, D: 3 };
  const vox = Float32Array.from([0.1, 0.5, 0.9]);
  const sampler = (volume, _x, _y, z) => volume[Math.max(0, Math.min(2, Math.round(z)))];
  const avgProjection = {
    mode: 'avg',
    slabThicknessMm: 2,
    sampleCount: 3,
    slabStep: [0, 0, 1],
  };
  const mipProjection = { ...avgProjection, mode: 'mip' };
  const minipProjection = { ...avgProjection, mode: 'minip' };

  assert.ok(Math.abs(projectVolumeSample(vox, 0, 0, 1, dims, sampler, avgProjection) - 0.5) < 1e-6);
  assert.ok(Math.abs(projectVolumeSample(vox, 0, 0, 1, dims, sampler, mipProjection) - 0.9) < 1e-6);
  assert.ok(Math.abs(projectVolumeSample(vox, 0, 0, 1, dims, sampler, minipProjection) - 0.1) < 1e-6);
});
