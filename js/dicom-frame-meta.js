// Shared multi-frame DICOM helpers (local import + DICOMweb).

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

function intValue(value, fallback = 0) {
  if (value == null) return fallback;
  if (Array.isArray(value)) return parseInt(value[0], 10) || fallback;
  return parseInt(value, 10) || fallback;
}

function seqItem(seq) {
  return Array.isArray(seq) ? seq[0] : (seq || null);
}

export function synthesizeFrameMetas(meta, frameCount = intValue(meta?.NumberOfFrames, 1)) {
  if (!(frameCount > 0)) return null;
  return Array.from({ length: frameCount }, (_, index) => ({
    ...meta,
    NumberOfFrames: 1,
    InstanceNumber: index + 1,
    FrameIndex: index + 1,
  }));
}

export function extractEnhancedMultiFrameMetas(meta) {
  const perFrame = meta?.PerFrameFunctionalGroupsSequence;
  const shared = seqItem(meta?.SharedFunctionalGroupsSequence);
  if (!Array.isArray(perFrame) || perFrame.length < 1) return null;

  const sharedOrientation = seqItem(shared?.PlaneOrientationSequence);
  const sharedPixelMeasures = seqItem(shared?.PixelMeasuresSequence);
  const sharedIOP = numberList(sharedOrientation?.ImageOrientationPatient, 6);
  const sharedSpacing = numberList(sharedPixelMeasures?.PixelSpacing, 2);
  const sharedThickness = Number(sharedPixelMeasures?.SliceThickness || 0);
  const frameOfRef = String(meta?.FrameOfReferenceUID || '');

  const frameMetas = [];
  for (const frame of perFrame) {
    const pos = seqItem(frame?.PlanePositionSequence);
    const orient = seqItem(frame?.PlaneOrientationSequence);
    const measures = seqItem(frame?.PixelMeasuresSequence);
    const ipp = numberList(pos?.ImagePositionPatient, 3);
    if (ipp.length < 3) return null;
    const localIOP = numberList(orient?.ImageOrientationPatient, 6);
    const iop = localIOP.length ? localIOP : sharedIOP;
    if (iop.length < 6) return null;
    const localSpacing = numberList(measures?.PixelSpacing, 2);
    const spacing = localSpacing.length ? localSpacing : sharedSpacing;
    const thickness = Number(measures?.SliceThickness || sharedThickness || 0);

    frameMetas.push({
      ImagePositionPatient: ipp,
      ImageOrientationPatient: iop,
      PixelSpacing: spacing,
      SliceThickness: thickness,
      FrameOfReferenceUID: frameOfRef,
    });
  }
  return frameMetas.length ? frameMetas : null;
}

export function frameMetasForInstance(meta) {
  const explicit = extractEnhancedMultiFrameMetas(meta);
  if (explicit?.length) {
    return explicit.map((frameMeta, index) => ({
      ...meta,
      NumberOfFrames: 1,
      InstanceNumber: index + 1,
      FrameIndex: index + 1,
      ...frameMeta,
    }));
  }
  return synthesizeFrameMetas(meta);
}
