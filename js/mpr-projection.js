import { cross3 } from './geometry.js';

export const MPR_PROJECTION_MODES = ['thin', 'avg', 'mip', 'minip'];
const MAX_SLAB_SAMPLES = 24;

function voxelToPhysical(vec, spacing) {
  return [
    vec[0] * (spacing.col || 1),
    vec[1] * (spacing.row || 1),
    vec[2] * (spacing.slice || 1),
  ];
}

export function normalizeMprProjectionMode(mode) {
  return MPR_PROJECTION_MODES.includes(mode) ? mode : 'thin';
}

export function clampSlabThicknessMm(value) {
  return Math.max(0, Math.min(160, Number(value) || 0));
}

// Shape: { origin: [0, 0, 12], axisU: [255, 0, 0], axisV: [0, 255, 0] } in voxel coordinates.
export function planeForAxis(axis, outW, outH, series, crosshair, mprVoxelForPixel) {
  const tl = mprVoxelForPixel(axis, 0, 0, outW, outH, series, crosshair);
  const tr = mprVoxelForPixel(axis, Math.max(1, outW - 1), 0, outW, outH, series, crosshair);
  const bl = mprVoxelForPixel(axis, 0, Math.max(1, outH - 1), outW, outH, series, crosshair);
  return {
    origin: tl,
    axisU: [tr[0] - tl[0], tr[1] - tl[1], tr[2] - tl[2]],
    axisV: [bl[0] - tl[0], bl[1] - tl[1], bl[2] - tl[2]],
  };
}

export function planeForOblique(outW, outH, center, du, dv) {
  const halfW = (outW - 1) / 2;
  const halfH = (outH - 1) / 2;
  return {
    origin: [
      center[0] - halfW * du[0] - halfH * dv[0],
      center[1] - halfW * du[1] - halfH * dv[1],
      center[2] - halfW * du[2] - halfH * dv[2],
    ],
    axisU: [du[0] * Math.max(1, outW - 1), du[1] * Math.max(1, outW - 1), du[2] * Math.max(1, outW - 1)],
    axisV: [dv[0] * Math.max(1, outH - 1), dv[1] * Math.max(1, outH - 1), dv[2] * Math.max(1, outH - 1)],
  };
}

// Shape: { mode: "mip", slabThicknessMm: 12, sampleCount: 13, slabStep: [0, 0, 1] }.
export function createMprProjection(
  { mode = 'thin', slabThicknessMm = 0 } = {},
  spacing = { row: 1, col: 1, slice: 1 },
  plane = null,
) {
  const normalizedMode = normalizeMprProjectionMode(mode);
  const thickness = clampSlabThicknessMm(slabThicknessMm);
  if (!plane || normalizedMode === 'thin' || thickness <= 0) {
    return {
      mode: normalizedMode,
      slabThicknessMm: thickness,
      sampleCount: 1,
      slabStep: [0, 0, 0],
    };
  }
  const physicalNormal = cross3(
    voxelToPhysical(plane.axisU, spacing),
    voxelToPhysical(plane.axisV, spacing),
  );
  const normalMm = Math.hypot(physicalNormal[0], physicalNormal[1], physicalNormal[2]);
  if (!(normalMm > 0)) {
    return {
      mode: normalizedMode,
      slabThicknessMm: thickness,
      sampleCount: 1,
      slabStep: [0, 0, 0],
    };
  }
  const minSpacing = Math.max(0.5, Math.min(spacing.row || 1, spacing.col || 1, spacing.slice || 1));
  const sampleCount = Math.max(2, Math.min(MAX_SLAB_SAMPLES, Math.round(thickness / minSpacing) + 1));
  const stepMm = thickness / Math.max(1, sampleCount - 1);
  // Shape: [0.0, 0.0, 0.5] -> voxel-space slab step whose physical direction is plane-normal.
  const physicalStep = physicalNormal.map((value) => value / normalMm * stepMm);
  return {
    mode: normalizedMode,
    slabThicknessMm: thickness,
    sampleCount,
    slabStep: [
      physicalStep[0] / (spacing.col || 1),
      physicalStep[1] / (spacing.row || 1),
      physicalStep[2] / (spacing.slice || 1),
    ],
  };
}

export function projectionCacheToken(projection = null) {
  if (!projection || projection.sampleCount <= 1) return 'thin:0:1';
  return `${projection.mode}:${projection.slabThicknessMm}:${projection.sampleCount}`;
}

export function projectVolumeSample(volume, x, y, z, dims, sampler, projection = null) {
  if (!projection || projection.sampleCount <= 1 || projection.mode === 'thin') {
    return sampler(volume, x, y, z, dims.W, dims.H, dims.D);
  }
  const centerOffset = (projection.sampleCount - 1) / 2;
  if (projection.mode === 'avg') {
    let sum = 0;
    for (let i = 0; i < projection.sampleCount; i++) {
      const offset = i - centerOffset;
      sum += sampler(
        volume,
        x + projection.slabStep[0] * offset,
        y + projection.slabStep[1] * offset,
        z + projection.slabStep[2] * offset,
        dims.W,
        dims.H,
        dims.D,
      );
    }
    return sum / projection.sampleCount;
  }
  let best = projection.mode === 'minip' ? Infinity : -Infinity;
  for (let i = 0; i < projection.sampleCount; i++) {
    const offset = i - centerOffset;
    const sample = sampler(
      volume,
      x + projection.slabStep[0] * offset,
      y + projection.slabStep[1] * offset,
      z + projection.slabStep[2] * offset,
      dims.W,
      dims.H,
      dims.D,
    );
    if (projection.mode === 'minip') best = Math.min(best, sample);
    else best = Math.max(best, sample);
  }
  return Number.isFinite(best) ? best : 0;
}
