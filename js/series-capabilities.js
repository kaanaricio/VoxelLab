// UI labels for imaging capabilities; geometry rules live in geometry.js.

import { classifyGeometryKind } from './geometry.js';

// Shape: modalities whose files are projection images, not voxel-grid slices.
const PROJECTION_MODALITIES = new Set(['CR', 'DX', 'MG', 'XA', 'RF']);

export function geometryKindForSeries(series) {
  if (series?.geometryKind) return series.geometryKind;
  const modality = String(series?.modality || '').toUpperCase();
  if (PROJECTION_MODALITIES.has(modality)) {
    return Number(series?.slices || 0) > 1 ? 'projectionSet' : 'singleProjection';
  }
  if (series?.sourceProjectionSetId) return 'derivedVolume';
  if (series?.ultrasoundCalibration?.status === 'calibrated') return 'ultrasoundSource';

  const spacingStats = series?.sliceSpacingStats || {
    mean: Number(series?.sliceSpacing || series?.sliceThickness || 0),
    regular: series?.sliceSpacingRegular !== false,
  };
  const geoKind = classifyGeometryKind(spacingStats, Number(series?.slices || 0));
  if (geoKind === 'cartesian_volume') return 'volumeStack';
  if (geoKind === 'single_frame') return 'singleImage';
  return 'imageStack';
}

export function reconstructionCapabilityForSeries(series) {
  if (series?.reconstructionCapability) return series.reconstructionCapability;
  const kind = geometryKindForSeries(series);
  if (kind === 'volumeStack' || kind === 'derivedVolume') return 'display-volume';
  if (kind === 'projectionSet' || kind === 'ultrasoundSource') return 'requires-reconstruction';
  return '2d-only';
}

export function canUseMpr3D(series) {
  const kind = geometryKindForSeries(series);
  const capability = reconstructionCapabilityForSeries(series);
  if (!(kind === 'volumeStack' || kind === 'derivedVolume') || capability !== 'display-volume') {
    return false;
  }

  const sliceCount = Number(series?.slices || 0);
  const spacingStats = series?.sliceSpacingStats || {
    mean: Number(series?.sliceSpacing || series?.sliceThickness || 0),
    regular: series?.sliceSpacingRegular !== false,
  };
  const geoKind = classifyGeometryKind(spacingStats, sliceCount);

  if (geoKind !== 'cartesian_volume') return false;

  // Minimum viable geometry fields for MPR/3D rendering.
  const spacing = series?.pixelSpacing || [];
  return Number(series?.width || 0) > 0
    && Number(series?.height || 0) > 0
    && Array.isArray(series?.orientation) && series.orientation.length >= 6
    && Array.isArray(series?.firstIPP) && series.firstIPP.length >= 3
    && Array.isArray(series?.lastIPP) && series.lastIPP.length >= 3
    && Number(spacing[0] || 0) > 0
    && Number(spacing[1] || 0) > 0;
}

export function capabilityLabel(series) {
  const kind = geometryKindForSeries(series);
  const capability = reconstructionCapabilityForSeries(series);
  if (kind === 'derivedVolume') return 'Derived volume';
  if (kind === 'volumeStack') return 'Display volume';
  if (kind === 'projectionSet') return 'Projection set · reconstruction required';
  if (kind === 'ultrasoundSource') return 'Ultrasound source · reconstruction required';
  if (kind === 'imageStack') return 'Image stack · 2D only';
  if (kind === 'singleImage') return 'Single image · 2D only';
  if (capability === '2d-only') return '2D projection';
  return capability;
}

export function capabilityBlockReason(series) {
  const kind = geometryKindForSeries(series);
  if (kind === 'singleProjection') return 'Single projection images stay 2D; true 3D requires calibrated multi-view reconstruction.';
  if (kind === 'projectionSet') return 'Projection sets must be reconstructed into a derived volume before MPR or 3D viewing.';
  if (kind === 'ultrasoundSource') return 'Calibrated ultrasound sources must be scan-converted into a derived volume before MPR or 3D viewing.';
  if (kind === 'imageStack') return 'This image stack is missing reliable patient-space slice geometry for MPR or 3D.';
  if (kind === 'singleImage') return 'Single images do not have enough depth for MPR or 3D viewing.';
  if (series?.sliceSpacingRegular === false) return 'This series has irregular slice spacing, so MPR/3D is blocked to avoid geometric distortion.';
  return 'This series lacks the voxel spacing or slice geometry needed for MPR/3D.';
}
