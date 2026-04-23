// Ultrasound / echo special-coordinates subsystem.
//
// Ultrasound data lives in probe-specific coordinate systems (sector,
// linear, curvilinear) that are NOT directly compatible with the Cartesian
// patient-space geometry used by CT/MR. This module provides:
//
//   1. Classification of ultrasound source types
//   2. Volumetric eligibility rules (fail-closed by default)
//   3. Scan-conversion abstraction (stub — real implementation is a
//      dedicated project, not a few lines of adapter code)
//
// Invariant: ultrasound data NEVER becomes MPR/3D-safe without an
// explicit scan-converted Cartesian derived volume re-entering through
// the standard geometry pipeline.

const _PROBE_GEOMETRIES = new Set(['sector', 'linear', 'curvilinear', '3d-probe', 'unknown']);

const _US_DATA_TYPES = new Set(['cine', 'still', '3d-volume', 'doppler', 'm-mode']);

function calibrationSummary(summary = null) {
  if (!summary || typeof summary !== 'object') return null;
  const status = String(summary.status || '').trim().toLowerCase();
  const source = String(summary.source || '').trim().toLowerCase();
  const probeGeometry = String(summary.probeGeometry || '').trim().toLowerCase();
  const mode = String(summary.mode || '').trim().toLowerCase();
  if (status !== 'calibrated' || source !== 'external-json' || !_PROBE_GEOMETRIES.has(probeGeometry)) return null;
  return { status, source, probeGeometry, mode };
}

export function classifyUltrasoundSource(meta = {}, summary = null) {
  const modality = String(meta.Modality || '').toUpperCase();
  const numberOfFrames = Number(meta.NumberOfFrames || 1);
  const imageType = Array.isArray(meta.ImageType) ? meta.ImageType : [];

  if (modality !== 'US') return null;

  // Determine data type from frame count and ImageType tokens.
  let dataType = 'still';
  if (numberOfFrames > 1) dataType = 'cine';
  if (imageType.some(t => String(t).toUpperCase() === 'VOLUME')) dataType = '3d-volume';
  if (imageType.some(t => String(t).toUpperCase() === 'DOPPLER')) dataType = 'doppler';
  if (imageType.some(t => String(t).toUpperCase() === 'M_MODE' || String(t).toUpperCase() === 'M-MODE')) dataType = 'm-mode';

  // Probe geometry from SequenceOfUltrasoundRegions or heuristics.
  const regionSeq = meta.SequenceOfUltrasoundRegions;
  let probeGeometry = 'unknown';
  if (Array.isArray(regionSeq) && regionSeq.length > 0) {
    const regionType = Number(regionSeq[0]?.RegionSpatialFormat || 0);
    if (regionType === 1) probeGeometry = 'sector';
    else if (regionType === 2) probeGeometry = 'linear';
    else if (regionType === 3) probeGeometry = 'curvilinear';
  }

  const calibration = calibrationSummary(summary);
  const reconstructionEligible = !!calibration && dataType !== 'doppler' && dataType !== 'm-mode';
  return {
    modality: 'US',
    dataType,
    probeGeometry,
    numberOfFrames,
    volumetricEligible: false,
    scanConversionAvailable: reconstructionEligible,
    reconstructionEligible,
    calibrationStatus: calibration ? 'calibrated' : 'missing',
    calibrationSource: calibration?.source || '',
    calibrationSummary: calibration,
    reason: reconstructionEligible
      ? 'Calibrated ultrasound source requires scan conversion before volumetric use.'
      : volumetricBlockReason(dataType, probeGeometry),
  };
}

function volumetricBlockReason(dataType, _probeGeometry) {
  if (dataType === 'doppler') return 'Doppler data is not spatial — volumetric use is not applicable.';
  if (dataType === 'm-mode') return 'M-mode is a time-distance plot — not a spatial volume.';
  if (dataType === '3d-volume') return '3D ultrasound volumes require probe-specific scan-conversion before Cartesian volumetric use.';
  if (dataType === 'cine') return 'Ultrasound cine loops are temporal sequences — volumetric use requires scan-converted spatial reconstruction.';
  return 'Ultrasound data stays 2D until scan-conversion produces a Cartesian derived volume.';
}

// Scan-conversion eligibility check — currently always returns false
// because no scan-conversion engine is implemented yet.
export function canScanConvert(_classification) {
  return Boolean(_classification?.reconstructionEligible && _classification?.scanConversionAvailable);
}

// Stub for future scan-conversion pipeline entry point.
// When implemented, this would:
//   1. Read probe geometry and calibration from DICOM tags
//   2. Convert sector/curvilinear coordinates to Cartesian voxels
//   3. Produce a derived volume that re-enters the standard geometry pipeline
export function scanConvertToVolume(_ultrasoundData, _probeCalibration) {
  throw new Error(
    'Scan conversion is not yet implemented. ' +
    'Ultrasound volumetric use requires a dedicated scan-conversion engine.',
  );
}
