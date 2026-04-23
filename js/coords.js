// Voxel ↔ physical coordinate conversions. Same math as the MPR
// reslicer but exposed as a pure function so the hover readout, ROI
// tool, and DICOM SR exporter all agree on where a voxel lives in the
// scanner's LPS frame.
//
// DICOM LPS convention (Left-Posterior-Superior positive):
//   +X → Left (patient left)
//   +Y → Posterior
//   +Z → Superior
// So the radiologist-friendly labels R/A/I correspond to negative axes.

import { voxelToPatientLps } from './geometry.js';

// Convert voxel (vx, vy, vz) to patient LPS mm using the per-slice
// ImagePositionPatient + ImageOrientationPatient. Slice direction is
// estimated as (lastIPP - firstIPP) / (D - 1) because we don't have
// ImagePositionPatient on every slice in the manifest (only first &
// last) — linear interpolation between endpoints is exact for evenly-
// spaced slices which is every MR / CT acquisition in our dataset.
//
// Returns [x, y, z] in mm, or null if the series lacks the required
// DICOM metadata in the manifest.
export function voxelToMM(series, vx, vy, vz) {
  if (!series.firstIPP || !series.orientation) return null;
  return voxelToPatientLps(series, vx, vy, vz);
}

// Format an LPS coordinate tuple with radiologist-friendly axis labels:
//    (-120.5, 8.2, 42.0) →  "120.5R 8.2P 42.0S"
export function formatLPS(mm) {
  if (!mm) return '';
  const [x, y, z] = mm;
  const lr = x < 0 ? 'R' : 'L';
  const ap = y < 0 ? 'A' : 'P';
  const si = z < 0 ? 'I' : 'S';
  return `${Math.abs(x).toFixed(1)}${lr} ${Math.abs(y).toFixed(1)}${ap} ${Math.abs(z).toFixed(1)}${si}`;
}
