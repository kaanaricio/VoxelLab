// Canonical patient-space geometry helpers shared by browser import,
// MPR, 3D scaling, measurements, compare, and SR export.

function numberList(value, minLength = 0) {
  if (Array.isArray(value)) {
    const out = value.map(Number).filter(Number.isFinite);
    return out.length >= minLength ? out : [];
  }
  if (typeof value === 'string') {
    const out = value.split('\\').map(Number).filter(Number.isFinite);
    return out.length >= minLength ? out : [];
  }
  return [];
}

function positiveNumber(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const DEFAULT_IOP = Object.freeze([1, 0, 0, 0, 1, 0]);

export function dot3(a, b) {
  return (a[0] * b[0]) + (a[1] * b[1]) + (a[2] * b[2]);
}

/** Return the right-handed cross product for two 3-vectors. */
export function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function norm3(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Normalize a 3-vector or return `null` when its magnitude is effectively zero. */
export function normalize3(v) {
  const length = norm3(v);
  return length > 1e-6 ? v.map((item) => item / length) : null;
}

export function orientationFromIOP(iop) {
  const values = numberList(iop, 6);
  if (values.length < 6) return null;
  const row = normalize3(values.slice(0, 3));
  const col = normalize3(values.slice(3, 6));
  if (!row || !col) return null;
  return { row, col };
}

/** Derive the normalized slice normal from a DICOM ImageOrientationPatient value. */
export function sliceNormalFromIOP(iop) {
  const basis = orientationFromIOP(iop);
  return basis ? normalize3(cross3(basis.row, basis.col)) : null;
}

/** Project a DICOM slice position onto a known slice normal in patient space. */
export function projectionAlongNormal(meta, normal) {
  const ipp = numberList(meta?.ImagePositionPatient, 3);
  return ipp.length >= 3 && normal ? dot3(ipp, normal) : null;
}

/** Sort slice-like datasets in spatial order, falling back to InstanceNumber when needed. */
export function sortDatasetsSpatially(datasets = [], getMeta = (item) => item?.meta || item) {
  if (!datasets.length) return [];
  const firstMeta = getMeta(datasets[0]);
  const normal = sliceNormalFromIOP(firstMeta?.ImageOrientationPatient);
  return datasets.slice().sort((a, b) => {
    const aMeta = getMeta(a);
    const bMeta = getMeta(b);
    const aProjection = projectionAlongNormal(aMeta, normal);
    const bProjection = projectionAlongNormal(bMeta, normal);
    const aInstance = Number(aMeta?.InstanceNumber || 0);
    const bInstance = Number(bMeta?.InstanceNumber || 0);
    if (aProjection == null || bProjection == null) return aInstance - bInstance;
    return aProjection - bProjection || aInstance - bInstance;
  });
}

/** Summarize inter-slice spacing and whether the stack is regular enough for volume use. */
export function sliceSpacingStatsFromPositions(positions = [], normal) {
  if (positions.length < 2 || !normal) {
    return { mean: 0, min: 0, max: 0, regular: false };
  }
  const scalars = positions.map((position) => dot3(position, normal));
  const diffs = [];
  for (let i = 0; i < scalars.length - 1; i++) {
    const diff = Math.abs(scalars[i + 1] - scalars[i]);
    if (diff > 1e-4) diffs.push(diff);
  }
  if (!diffs.length) return { mean: 0, min: 0, max: 0, regular: false };
  const min = Math.min(...diffs);
  const max = Math.max(...diffs);
  const mean = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const tolerance = Math.max(0.1, mean * 0.02);
  return { mean, min, max, regular: (max - min) <= tolerance };
}

/** Build the browser-facing geometry record from a manifest series entry. */
export function geometryFromSeries(series = {}) {
  const basis = orientationFromIOP(series.orientation || DEFAULT_IOP) || {
    row: [1, 0, 0],
    col: [0, 1, 0],
  };
  const firstIPP = numberList(series.firstIPP, 3);
  const lastIPP = numberList(series.lastIPP, 3);
  const slices = Number(series.slices || 0);
  const rowSpacing = Number(series.pixelSpacing?.[0] || 1);
  const colSpacing = Number(series.pixelSpacing?.[1] || rowSpacing);
  const fallbackSpacing = Number(series.sliceThickness || 1);
  let sliceSpacing = Number(series.sliceSpacing || 0);
  if (!(sliceSpacing > 0) && firstIPP.length >= 3 && lastIPP.length >= 3 && slices > 1) {
    sliceSpacing = Math.hypot(
      lastIPP[0] - firstIPP[0],
      lastIPP[1] - firstIPP[1],
      lastIPP[2] - firstIPP[2],
    ) / (slices - 1);
  }
  if (!(sliceSpacing > 0)) sliceSpacing = fallbackSpacing > 0 ? fallbackSpacing : 1;

  const normal = normalize3(cross3(basis.row, basis.col)) || [0, 0, 1];
  let sliceDir = normal;
  if (firstIPP.length >= 3 && lastIPP.length >= 3 && slices > 1) {
    const byEndpoints = normalize3([
      (lastIPP[0] - firstIPP[0]) / (slices - 1),
      (lastIPP[1] - firstIPP[1]) / (slices - 1),
      (lastIPP[2] - firstIPP[2]) / (slices - 1),
    ]);
    if (byEndpoints) sliceDir = byEndpoints;
  }

  const affineLps = [
    [basis.row[0] * colSpacing, basis.col[0] * rowSpacing, sliceDir[0] * sliceSpacing, firstIPP[0] || 0],
    [basis.row[1] * colSpacing, basis.col[1] * rowSpacing, sliceDir[1] * sliceSpacing, firstIPP[1] || 0],
    [basis.row[2] * colSpacing, basis.col[2] * rowSpacing, sliceDir[2] * sliceSpacing, firstIPP[2] || 0],
    [0, 0, 0, 1],
  ];

  return {
    rowSpacing,
    colSpacing,
    sliceSpacing,
    sliceSpacingRegular: series.sliceSpacingRegular !== false,
    row: basis.row,
    col: basis.col,
    normal,
    sliceDir,
    firstIPP: firstIPP.length >= 3 ? firstIPP : [0, 0, 0],
    lastIPP: lastIPP.length >= 3 ? lastIPP : (firstIPP.length >= 3 ? firstIPP : [0, 0, 0]),
    affineLps,
    frameOfReferenceUID: String(series.frameOfReferenceUID || ''),
  };
}

/** Return the patient-space point at a clamped slice index along the series slice axis. */
export function patientPointAtSlice(series = {}, sliceIdx = 0) {
  const geo = geometryFromSeries(series);
  const slices = Math.max(1, Math.floor(Number(series.slices || 1)));
  const index = Math.max(0, Math.min(Math.round(Number(sliceIdx) || 0), slices - 1));
  return geo.firstIPP.map((value, axis) => value + (geo.sliceDir[axis] * geo.sliceSpacing * index));
}

/** Return the nearest slice index to a patient-space point or flag it as out-of-range. */
export function closestSliceIndexForPatientPoint(series = {}, patientPoint = null) {
  const slices = Math.max(0, Math.floor(Number(series.slices || 0)));
  if (!Array.isArray(patientPoint) || patientPoint.length < 3 || !slices) {
    return { index: 0, outOfRange: true, distanceMm: Infinity, toleranceMm: 0 };
  }
  const geo = geometryFromSeries(series);
  const start = dot3(geo.firstIPP, geo.sliceDir);
  const target = dot3(patientPoint, geo.sliceDir);
  const rawIndex = Number.isFinite(target) ? ((target - start) / Math.max(geo.sliceSpacing, 1e-6)) : 0;
  const index = Math.max(0, Math.min(Math.round(rawIndex), slices - 1));
  const matched = start + (index * geo.sliceSpacing);
  const distanceMm = Math.abs(target - matched);
  const toleranceMm = Math.max(geo.sliceSpacing * 0.5, 1e-3);
  return { index, outOfRange: distanceMm > toleranceMm, distanceMm, toleranceMm };
}

// Shape: { rowMm: 0.5, colMm: 0.5, known: true } for in-plane pixel spacing.
export function inPlanePixelSpacing(series = {}) {
  const ps = Array.isArray(series.pixelSpacing) ? series.pixelSpacing : [];
  const row = Number(ps[0]);
  const col = Number(ps[1]);
  const known = row > 0 && col > 0;
  return {
    rowMm: known ? row : 1,
    colMm: known ? col : 1,
    known,
  };
}

// Shape: { width: 512, height: 768 } for a 2D slice whose displayed aspect follows physical pixel spacing.
export function inPlaneDisplaySize(series = {}) {
  const width = Math.max(1, Math.round(Number(series.width || 1)));
  const height = Math.max(1, Math.round(Number(series.height || 1)));
  const spacing = inPlanePixelSpacing(series);
  const rowSpacing = positiveNumber(spacing.rowMm, 1);
  const colSpacing = positiveNumber(spacing.colMm, rowSpacing);
  const minSpacing = Math.max(1e-6, Math.min(rowSpacing, colSpacing));
  return {
    width: Math.max(1, Math.round(width * colSpacing / minSpacing)),
    height: Math.max(1, Math.round(height * rowSpacing / minSpacing)),
  };
}

/** Convert voxel coordinates to patient-space LPS millimeters using the series affine. */
export function voxelToPatientLps(series, vx, vy, vz) {
  const geometry = geometryFromSeries(series);
  const m = geometry.affineLps;
  return [
    m[0][0] * vx + m[0][1] * vy + m[0][2] * vz + m[0][3],
    m[1][0] * vx + m[1][1] * vy + m[1][2] * vz + m[1][3],
    m[2][0] * vx + m[2][1] * vy + m[2][2] * vz + m[2][3],
  ];
}

/** Derive spacing, orientation, and IPP endpoints from a sorted list of DICOM metas. */
export function geometryFromDicomMetas(metas = []) {
  const first = metas[0] || {};
  const basis = orientationFromIOP(first.ImageOrientationPatient || DEFAULT_IOP) || {
    row: [1, 0, 0],
    col: [0, 1, 0],
  };
  const normal = normalize3(cross3(basis.row, basis.col)) || [0, 0, 1];
  const positions = metas
    .map((meta) => numberList(meta.ImagePositionPatient, 3))
    .filter((position) => position.length >= 3);
  const spacingStats = sliceSpacingStatsFromPositions(positions, normal);
  const pixelSpacing = numberList(first.PixelSpacing, 2);
  const rowSpacing = pixelSpacing[0] > 0 ? pixelSpacing[0] : 1;
  const colSpacing = pixelSpacing[1] > 0 ? pixelSpacing[1] : rowSpacing;
  const sliceThickness = Number(first.SliceThickness || 0);
  return {
    pixelSpacing: [rowSpacing, colSpacing],
    sliceThickness: sliceThickness > 0 ? sliceThickness : (spacingStats.mean > 0 ? spacingStats.mean : 1),
    sliceSpacing: spacingStats.mean > 0 ? spacingStats.mean : (sliceThickness > 0 ? sliceThickness : 1),
    sliceSpacingRegular: spacingStats.regular,
    sliceSpacingStats: spacingStats,
    firstIPP: positions[0] || [0, 0, 0],
    lastIPP: positions[positions.length - 1] || (positions[0] || [0, 0, 0]),
    orientation: [...basis.row, ...basis.col],
    frameOfReferenceUID: String(first.FrameOfReferenceUID || ''),
  };
}

/** Classify whether slice geometry is volumetric, irregular, single-frame, or insufficient. */
export function classifyGeometryKind(spacingStats, sliceCount) {
  if (sliceCount <= 0) return 'insufficient';
  if (sliceCount === 1) return 'single_frame';
  if (!(spacingStats?.mean > 0)) return 'insufficient';
  return spacingStats.regular ? 'cartesian_volume' : 'cartesian_stack_irregular';
}

/** Package a complete geometry contract object for manifests, tests, and downstream tools. */
export function buildGeometryRecord(metas = [], { width = 0, height = 0, source = 'dicom_classic_singleframe' } = {}) {
  const sliceCount = metas.length;
  if (!sliceCount) {
    return {
      kind: 'insufficient',
      dimensions: { width, height, depth: 0 },
      spacingMm: { row: 1, col: 1, slice: 1 },
      sliceSpacingStatsMm: { mean: 0, min: 0, max: 0, regular: false },
      orientation: [...DEFAULT_IOP],
      firstIPP: [0, 0, 0],
      lastIPP: [0, 0, 0],
      affineLps: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
      frameOfReferenceUID: '',
      source,
    };
  }

  const geo = geometryFromDicomMetas(metas);
  const spacingStats = geo.sliceSpacingStats;
  const kind = classifyGeometryKind(spacingStats, sliceCount);

  // Build affine via geometryFromSeries using the DICOM-meta-derived geometry.
  const seriesForAffine = {
    pixelSpacing: geo.pixelSpacing,
    sliceSpacing: geo.sliceSpacing,
    slices: sliceCount,
    firstIPP: geo.firstIPP,
    lastIPP: geo.lastIPP,
    orientation: geo.orientation,
    sliceSpacingRegular: geo.sliceSpacingRegular,
  };
  const derived = geometryFromSeries(seriesForAffine);

  return {
    kind,
    dimensions: { width, height, depth: sliceCount },
    spacingMm: { row: geo.pixelSpacing[0], col: geo.pixelSpacing[1], slice: geo.sliceSpacing },
    sliceSpacingStatsMm: spacingStats,
    orientation: geo.orientation,
    firstIPP: geo.firstIPP,
    lastIPP: geo.lastIPP,
    affineLps: derived.affineLps,
    frameOfReferenceUID: geo.frameOfReferenceUID,
    source,
  };
}

/** Return a stable compare-group key from FrameOfReferenceUID or a geometry fallback. */
export function seriesCompareGroup(series = {}) {
  const frame = String(series.frameOfReferenceUID || '').trim();
  if (frame) return `for:${frame}`;
  const firstIPP = numberList(series.firstIPP, 3);
  const orientation = numberList(series.orientation, 6);
  if (firstIPP.length < 3 || orientation.length < 6) return null;
  const ippKey = firstIPP.map((value) => value.toFixed(1)).join(',');
  const iopKey = orientation.map((value) => value.toFixed(4)).join(',');
  return `fallback:${ippKey}|${iopKey}`;
}
