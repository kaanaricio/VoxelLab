// Pure orthogonal MPR geometry. The volume is stored row-major as (z, y, x);
// x is DICOM column, y is DICOM row, z is slice index.

import { geometryFromSeries } from './geometry.js';

function positiveNumber(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function effectiveSliceSpacing(series) {
  return positiveNumber(geometryFromSeries(series).sliceSpacing, positiveNumber(series?.sliceThickness, 1));
}

export function mprPlaneSizes(series) {
  const D = series.slices;
  const W = series.width;
  const H = series.height;
  // Use shared geometry contract for all spacing values.
  const geo = geometryFromSeries(series);
  const colSpacing = positiveNumber(geo.colSpacing, 1);
  const rowSpacing = positiveNumber(geo.rowSpacing, colSpacing);
  const zSpacing = positiveNumber(geo.sliceSpacing, 1);
  const clamp = (v) => Math.max(16, Math.min(2048, v));
  return {
    axW: W,
    axH: clamp(Math.round(H * rowSpacing / colSpacing)),
    coW: W,
    coH: clamp(Math.round(D * zSpacing / colSpacing)),
    saW: H,
    saH: clamp(Math.round(D * zSpacing / rowSpacing)),
  };
}

export function mprVoxelForPixel(axis, ox, oy, outW, outH, series, crosshair) {
  const W = series.width;
  const H = series.height;
  const D = series.slices;
  const xFromPixel = ox * (W - 1) / Math.max(1, outW - 1);
  const yFromPixel = ox * (H - 1) / Math.max(1, outW - 1);
  const zFromPixel = (outH - 1 - oy) * (D - 1) / Math.max(1, outH - 1);
  if (axis === 'ax') return [xFromPixel, oy * (H - 1) / Math.max(1, outH - 1), crosshair.z];
  if (axis === 'co') return [xFromPixel, crosshair.y, zFromPixel];
  return [crosshair.x, yFromPixel, zFromPixel];
}
