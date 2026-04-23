// DICOM / NIfTI parsing — robust handling of real-world DICOM variations.
// Compressed transfer syntaxes are routed through dicom-codecs.js and fail
// closed when the browser cannot recover medically faithful pixel samples.
//
// Correctness notes:
//   - Slice ordering: uses ImagePositionPatient (spatial) when available,
//     falls back to InstanceNumber (acquisition order). IPP sorting is
//     critical for non-axial acquisitions where InstanceNumber may not
//     correspond to spatial position.
//   - BitsStored vs BitsAllocated: masks pixel values to BitsStored to
//     discard padding bits in the upper portion of the allocated word.
//   - PhotometricInterpretation: handles MONOCHROME1 (inverted) by
//     flipping the pixel values after windowing.
//   - PixelSpacing: treated as optional. When absent, measurements are
//     disabled (pixelSpacing = [0, 0]) rather than assuming 1mm.
//   - RescaleSlope/Intercept: applied per-slice (can vary per frame in
//     enhanced DICOM, though we read per-file for now).
//   - WindowCenter/WindowWidth: read from DICOM tags. If absent,
//     auto-computed from the 2nd-98th percentile of the pixel data
//     (not min/max, which is dominated by outliers).

import { isCompressed, decodePixelData } from './dicom-codecs.js';
import { CT_HU_LO, CT_HU_HI } from './constants.js';
import { DCMJS_IMPORT_URL, PAKO_ESM_URL } from './dependencies.js';
import {
  extractEnhancedMultiFrameMetas,
  frameMetasForInstance,
} from './dicom-frame-meta.js';
import {
  DEFAULT_IOP,
  geometryFromDicomMetas,
  normalize3,
  sliceNormalFromIOP,
  sortDatasetsSpatially,
} from './geometry.js';
import { classifyUltrasoundSource } from './ultrasound.js';
import { parseDicomFilesInWorker } from './volume-worker-client.js';

export { extractEnhancedMultiFrameMetas } from './dicom-frame-meta.js';

let dcmjs = null;
let pako = null;

async function ensureDcmjs() {
  if (dcmjs) return dcmjs;
  dcmjs = await import(DCMJS_IMPORT_URL);
  return dcmjs;
}

async function ensurePako() {
  if (pako) return pako;
  const mod = await import(PAKO_ESM_URL);
  pako = mod;
  return pako;
}

function getFloat(meta, key, fallback = 0) {
  const v = meta[key];
  if (v == null) return fallback;
  if (Array.isArray(v)) return parseFloat(v[0]) || fallback;
  return parseFloat(v) || fallback;
}

function getInt(meta, key, fallback = 0) {
  const v = meta[key];
  if (v == null) return fallback;
  const parsed = Array.isArray(v) ? parseInt(v[0], 10) : parseInt(v, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getStr(meta, key, fallback = '') {
  const v = meta[key];
  if (v == null) return fallback;
  if (Array.isArray(v)) return String(v[0] || fallback);
  return String(v || fallback);
}

function getFloatArray(meta, key) {
  const v = meta[key];
  if (!v) return null;
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === 'string') return v.split('\\').map(Number);
  return null;
}

function decodeBase64Bytes(value) {
  const text = String(value || '');
  if (!text) return new Uint8Array(0);
  const binary = globalThis.atob ? globalThis.atob(text) : '';
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesFromValue(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') return decodeBase64Bytes(value);
  return null;
}

function typedPixelsFromBytes(bytes, bitsAllocated, pixelRepresentation, pixelCount) {
  if (!bytes || bytes.byteLength < pixelCount) return null;
  if (bitsAllocated === 8) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, pixelCount);
  }
  const neededBytes = pixelCount * 2;
  if (bytes.byteLength < neededBytes) return null;
  if (pixelRepresentation === 1) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, pixelCount);
  }
  return new Uint16Array(bytes.buffer, bytes.byteOffset, pixelCount);
}

const PROJECTION_MODALITIES = new Set(['CR', 'DX', 'XA', 'RF', 'MG', 'IO', 'PX']);
const PROJECTION_IMAGE_TYPE_TOKENS = new Set(['LOCALIZER', 'SCOUT', 'PROJECTION']);
const DERIVED_OBJECT_MODALITIES = new Set(['SEG', 'RTSTRUCT', 'SR']);
const MONOCHROME_PHOTOMETRICS = new Set(['MONOCHROME1', 'MONOCHROME2']);
function normalizeModality(modality) {
  return String(modality || 'OT').trim().toUpperCase();
}

function pixelDataRestrictionReason(meta = {}) {
  const samplesPerPixel = getInt(meta, 'SamplesPerPixel', 1);
  const photometric = getStr(meta, 'PhotometricInterpretation', 'MONOCHROME2').trim().toUpperCase();
  const bitsAllocated = getInt(meta, 'BitsAllocated', 16);
  const bitsStored = getInt(meta, 'BitsStored', bitsAllocated);
  if (samplesPerPixel !== 1) {
    return `unsupported DICOM import requires single-sample pixels (SamplesPerPixel=${samplesPerPixel})`;
  }
  if (!MONOCHROME_PHOTOMETRICS.has(photometric)) {
    return `unsupported DICOM import requires MONOCHROME1/2 pixels (PhotometricInterpretation=${photometric || 'missing'})`;
  }
  if (bitsAllocated !== 8 && bitsAllocated !== 16) {
    return `unsupported DICOM import requires 8- or 16-bit allocated pixels (BitsAllocated=${bitsAllocated})`;
  }
  if (bitsStored <= 0 || bitsStored > bitsAllocated) {
    return `unsupported DICOM import requires 1 <= BitsStored <= BitsAllocated (BitsStored=${bitsStored}, BitsAllocated=${bitsAllocated})`;
  }
  return '';
}

function getStrArray(meta, key) {
  const v = meta[key];
  if (!v) return [];
  if (Array.isArray(v)) return v.map(item => String(item || ''));
  return String(v).split('\\');
}

function projectionAlongNormal(meta, normal) {
  const ipp = getFloatArray(meta, 'ImagePositionPatient');
  if (!ipp || ipp.length < 3 || ipp.some(v => !Number.isFinite(v))) return null;
  return ipp[0] * normal[0] + ipp[1] * normal[1] + ipp[2] * normal[2];
}

function hasVolumeStackGeometry(metas) {
  if (metas.length < 2) return false;
  const normal = sliceNormalFromIOP(getFloatArray(metas[0], 'ImageOrientationPatient'));
  if (!normal) return false;

  const positions = [];
  for (const meta of metas) {
    const sliceNormal = sliceNormalFromIOP(getFloatArray(meta, 'ImageOrientationPatient'));
    if (!sliceNormal) return false;
    const dot = normal[0] * sliceNormal[0] + normal[1] * sliceNormal[1] + normal[2] * sliceNormal[2];
    if (Math.abs(dot) < 0.999) return false;
    const p = projectionAlongNormal(meta, normal);
    if (p == null) return false;
    positions.push(p);
  }

  const min = Math.min(...positions);
  const max = Math.max(...positions);
  if (max - min < 0.01) return false;

  const unique = new Set(positions.map(p => p.toFixed(3)));
  return unique.size >= 2;
}

function hasProjectionImageType(metas) {
  return metas.some(meta =>
    getStrArray(meta, 'ImageType').some(value =>
      PROJECTION_IMAGE_TYPE_TOKENS.has(value.trim().toUpperCase())
    )
  );
}

function stripBasicOffsetTable(values, frameCount) {
  if (values.length !== frameCount + 1) return values;
  const first = bytesFromValue(values[0]);
  if (!first || first.byteLength % 4 !== 0) return values;
  return values.slice(1);
}

function looksLikeSourceManifest(payload) {
  return payload && typeof payload === 'object'
    && (payload.sourceKind === 'projection' || payload.sourceKind === 'ultrasound');
}

async function parseSourceManifests(files = []) {
  const bySeriesUID = new Map();
  for (const file of files) {
    if (!/\.json$/i.test(file?.name || '')) continue;
    try {
      const payload = JSON.parse(await file.text());
      if (!looksLikeSourceManifest(payload)) continue;
      const key = String(payload.seriesUID || '');
      if (key) bySeriesUID.set(key, payload);
    } catch {
      // Ignore non-source JSON attachments.
    }
  }
  return bySeriesUID;
}

/** Expand an enhanced multi-frame instance into per-frame `{ meta, pixels|encodedValue }` records. */
export function extractEnhancedMultiFramePixels(item) {
  const meta = item?.meta || item;
  const pixelData = item?.pixelData || meta?.PixelData;
  const frameCount = getInt(meta, 'NumberOfFrames', 1);
  const rows = getInt(meta, 'Rows');
  const cols = getInt(meta, 'Columns');
  const bitsAllocated = getInt(meta, 'BitsAllocated', 16);
  const pixelRepresentation = getInt(meta, 'PixelRepresentation', 0);
  const frameMetas = frameMetasForInstance(meta);

  if (!pixelData || !frameMetas || frameMetas.length !== frameCount || !rows || !cols) return null;

  const values = Array.isArray(pixelData?.Value) ? pixelData.Value : [];
  const inlineBinary = pixelData?.InlineBinary;
  const framePixelCount = rows * cols;
  const frameByteCount = framePixelCount * (bitsAllocated <= 8 ? 1 : 2);
  const transferSyntax = getStr(meta, 'TransferSyntaxUID');

  const frames = [];
  if (!isCompressed(transferSyntax)) {
    const bytes = bytesFromValue(values[0] ?? inlineBinary);
    if (!bytes || bytes.byteLength < frameCount * frameByteCount) return null;
    for (let i = 0; i < frameCount; i++) {
      const frameBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + (i * frameByteCount), frameByteCount);
      const pixels = typedPixelsFromBytes(frameBytes, bitsAllocated, pixelRepresentation, framePixelCount);
      if (!pixels) return null;
      frames.push({ meta: frameMetas[i], pixels });
    }
    return frames;
  }

  const encodedValues = stripBasicOffsetTable(values, frameCount);
  if (encodedValues.length !== frameCount) return null;
  return encodedValues.map((value, index) => ({
    meta: frameMetas[index],
    encodedValue: value,
  }));
}

/** Classify an import batch as volumetric, projection, ultrasound, or 2D-only before conversion. */
export function classifyDICOMImport(items = [], sourceManifest = null) {
  // Example input: [{ meta: { Modality: "CT", ImagePositionPatient: [...] } }, ...].
  const metas = items.map(item => item.meta || item).filter(Boolean);
  const first = metas[0] || {};
  const modality = normalizeModality(getStr(first, 'Modality', 'OT'));
  const imageCount = metas.length;
  const numberOfFrames = Math.max(...metas.map(meta => getInt(meta, 'NumberOfFrames', 1)), 1);
  const isProjectionModality = PROJECTION_MODALITIES.has(modality);
  const imageTypeProjection = hasProjectionImageType(metas);
  const isProjection = isProjectionModality || imageTypeProjection;
  const ultrasoundSummary = sourceManifest?.sourceKind === 'ultrasound'
    ? {
        status: 'calibrated',
        source: 'external-json',
        probeGeometry: String(sourceManifest?.ultrasound?.probeGeometry || ''),
        mode: String(sourceManifest?.ultrasound?.mode || ''),
      }
    : null;
  const ultrasound = classifyUltrasoundSource(first, ultrasoundSummary);
  if (ultrasound) {
    const restrictedUltrasound = ultrasound.dataType === 'cine' || ultrasound.dataType === '3d-volume';
    return {
      kind: ultrasound.reconstructionEligible
        ? 'ultrasound-source'
        : (restrictedUltrasound ? 'ultrasound-cine' : (imageCount > 1 ? 'image-stack' : 'single-image')),
      modality,
      imageCount,
      numberOfFrames,
      isProjection: false,
      isProjectionSet: false,
      isReconstructedVolumeStack: false,
      hasVolumeStackGeometry: false,
      reason: ultrasound.reason,
      ultrasound,
    };
  }
  if (numberOfFrames > 1) {
    const frameMetas = metas.length === 1 ? extractEnhancedMultiFrameMetas(first) : null;
    const hasSpacing = frameMetas?.every(meta => {
      const spacing = getFloatArray(meta, 'PixelSpacing');
      return Array.isArray(spacing) && spacing.length >= 2 && spacing[0] > 0 && spacing[1] > 0;
    });
    if (frameMetas?.length >= 2 && hasSpacing && hasVolumeStackGeometry(frameMetas)) {
      const geometry = geometryFromDicomMetas(frameMetas);
      const regularStack = geometry?.sliceSpacingRegular !== false;
      return {
        kind: regularStack ? 'volume-stack' : 'image-stack',
        modality,
        imageCount,
        numberOfFrames,
        isProjection: false,
        isProjectionSet: false,
        isReconstructedVolumeStack: regularStack,
        hasVolumeStackGeometry: regularStack,
        reason: regularStack
          ? 'enhanced multi-frame per-frame geometry defines a regular Cartesian volume'
          : 'enhanced multi-frame geometry exists but spacing is irregular, so import stays 2D-only',
      };
    }
    // Do not promote enhanced multi-frame to a volumetric-safe import until
    // the browser path can both extract per-frame geometry and decode/frame
    // pixel data correctly end-to-end.
    return {
      kind: 'multiframe-image',
      modality,
      imageCount,
      numberOfFrames,
      isProjection: false,
      isProjectionSet: false,
      isReconstructedVolumeStack: false,
      hasVolumeStackGeometry: false,
      reason: 'multi-frame DICOM requires dedicated per-frame geometry and pixel extraction before volumetric use',
    };
  }
  const hasStackGeometry = hasVolumeStackGeometry(metas);
  const geometry = hasStackGeometry ? geometryFromDicomMetas(metas) : null;
  const regularStack = hasStackGeometry && geometry?.sliceSpacingRegular !== false;
  const kind = isProjection
    ? (imageCount > 1 ? 'projection-set' : 'single-projection')
    : (regularStack ? 'volume-stack' : (imageCount > 1 ? 'image-stack' : 'single-image'));

  return {
    kind,
    modality,
    imageCount,
    isProjection,
    isProjectionSet: kind === 'projection-set',
    isReconstructedVolumeStack: kind === 'volume-stack',
    hasVolumeStackGeometry: regularStack,
    reason: isProjection
      ? (isProjectionModality ? `${modality} is a projection X-ray modality` : 'ImageType marks projection/localizer/scout data')
      : (regularStack
        ? 'distinct IPP positions along IOP-derived slice normal with regular spacing'
        : (hasStackGeometry ? 'slice geometry exists but spacing is irregular, so import stays 2D-only' : 'no reliable volume-stack geometry')),
  };
}

function arrayBufferForBytes(bytes) {
  if (!bytes) return null;
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function geometryKindForImportKind(kind) {
  return {
    'volume-stack': 'volumeStack',
    'projection-set': 'projectionSet',
    'single-projection': 'singleProjection',
    'ultrasound-source': 'ultrasoundSource',
    'ultrasound-cine': 'imageStack',
    'multiframe-image': 'imageStack',
    'image-stack': 'imageStack',
    'single-image': 'singleImage',
  }[kind] || 'singleImage';
}

function reconstructionCapabilityForGeometryKind(kind) {
  if (kind === 'volumeStack' || kind === 'derivedVolume') return 'display-volume';
  if (kind === 'projectionSet' || kind === 'ultrasoundSource') return 'requires-reconstruction';
  return '2d-only';
}

/** Build a stable DICOM series grouping key from study + series identifiers. */
export function dicomSeriesGroupKey(meta) {
  const study = getStr(meta, 'StudyInstanceUID', 'study');
  const fallback = [
    getStr(meta, 'SeriesNumber'),
    getStr(meta, 'SeriesDescription'),
    getStr(meta, 'Modality'),
  ].filter(Boolean).join('|') || 'series';
  const series = getStr(meta, 'SeriesInstanceUID') || fallback;
  return `${study}|${series}`;
}

function groupDatasetsBySeries(datasets) {
  const groups = [];
  const byKey = new Map();
  for (const item of datasets) {
    const key = dicomSeriesGroupKey(item.meta);
    let group = byKey.get(key);
    if (!group) {
      group = { key, datasets: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.datasets.push(item);
  }
  return groups;
}

// Sort slices spatially by ImagePositionPatient when available.
// Falls back to InstanceNumber. IPP sorting projects each slice's
// position onto the slice normal (cross product of IOP row × col)
// and sorts by that scalar — correct for any acquisition plane.
function sortSlicesSpatially(datasets) {
  const sorted = sortDatasetsSpatially(datasets, (item) => item.meta);
  datasets.splice(0, datasets.length, ...sorted);
}

// Auto W/L from percentiles (more robust than min/max)
function autoWindowLevel(pixels, count, slope, intercept) {
  // Sample up to 50k pixels for speed
  const step = Math.max(1, Math.floor(count / 50000));
  const samples = [];
  for (let i = 0; i < count; i += step) {
    samples.push(pixels[i] * slope + intercept);
  }
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * 0.02)];
  const hi = samples[Math.floor(samples.length * 0.98)];
  const ww = Math.max(1, hi - lo);
  const wl = (lo + hi) / 2;
  return { wl, ww };
}

/** Parse local DICOM files into one or more importable series groups. */
export async function parseDICOMFileGroups(files, onProgress = () => {}) {
  onProgress('parsing', `reading ${files.length} files...`);
  let datasets = [];
  let sourceManifests = new Map();
  let workerParsed = false;

  if (typeof Worker !== 'undefined') {
    const parsed = await parseDicomFilesInWorker(files, onProgress);
    if (parsed?.datasets?.length) {
      datasets = parsed.datasets;
      sourceManifests = new Map(Object.entries(parsed.sourceManifests || {}));
      workerParsed = true;
    }
  }

  if (!workerParsed) {
    const lib = await ensureDcmjs();
    const DicomMessage = lib.data.DicomMessage;
    sourceManifests = await parseSourceManifests(files);
    let parsed = 0;
    for (const file of files) {
      try {
        const ab = await file.arrayBuffer();
        const ds = DicomMessage.readFile(ab);
        const meta = lib.data.DicomMetaDictionary.naturalizeDataset(ds.dict);
        if (!meta.PixelData) continue;
        datasets.push({ meta, pixelData: ds.dict['7FE00010'], file });
        parsed++;
        if (parsed % 10 === 0) onProgress('parsing', `${parsed} / ${files.length}`);
      } catch {
        // Skip unparseable files
      }
    }
  }

  if (!datasets.length) return null;
  const groups = groupDatasetsBySeries(datasets);
  const renderableGroups = groups.filter((group) => !DERIVED_OBJECT_MODALITIES.has(normalizeModality(group.datasets[0]?.meta?.Modality)));
  for (const group of renderableGroups) {
    const seriesUID = String(group.datasets[0]?.meta?.SeriesInstanceUID || '');
    group.sourceManifest = sourceManifests.get(seriesUID) || null;
  }
  onProgress('sorting', `${datasets.length} valid slices · ${renderableGroups.length} image series`);

  const seed = Date.now().toString(36);
  const results = [];
  const skippedReasons = [];
  for (let i = 0; i < renderableGroups.length; i++) {
    const slug = renderableGroups.length === 1 ? `local_${seed}` : `local_${seed}_${i + 1}`;
    const result = await buildDICOMSeriesResult(
      renderableGroups[i].datasets,
      onProgress,
      slug,
      skippedReasons,
      renderableGroups[i].sourceManifest,
    );
    if (result) results.push(result);
  }
  if (!results.length && skippedReasons.length) {
    throw new Error(skippedReasons.join(' | '));
  }
  return results.length ? results : null;
}

/** Parse local DICOM files and return the first importable series result. */
export async function parseDICOMFiles(files, onProgress = () => {}) {
  const groups = await parseDICOMFileGroups(files, onProgress);
  return groups?.[0] || null;
}

function importRestrictionReason(importClassification) {
  if (!importClassification) return '';
  if (importClassification.kind === 'multiframe-image' || importClassification.kind === 'ultrasound-cine') {
    return importClassification.reason || 'Unsupported multi-frame DICOM import';
  }
  return '';
}

/** Convert a grouped DICOM stack into viewer-ready canvases, manifest metadata, and raw voxels. */
export async function buildDICOMSeriesResult(inputDatasets, onProgress = () => {}, slug, skippedReasons = [], sourceManifest = null) {
  let datasets = inputDatasets.slice();
  const initialClassification = classifyDICOMImport(datasets, sourceManifest);
  const restrictionReason = importRestrictionReason(initialClassification);
  if (restrictionReason) {
    skippedReasons.push(restrictionReason);
    return null;
  }

  if (datasets.length === 1 && getInt(datasets[0].meta, 'NumberOfFrames', 1) > 1) {
    const expandedFrames = extractEnhancedMultiFramePixels(datasets[0]);
    if (expandedFrames) datasets = expandedFrames;
  }

  // Spatial sort (IPP when possible).
  sortSlicesSpatially(datasets);
  const importClassification = classifyDICOMImport(datasets, sourceManifest);
  const postExpansionRestriction = importRestrictionReason(importClassification);
  if (postExpansionRestriction) {
    skippedReasons.push(postExpansionRestriction);
    return null;
  }

  const first = datasets[0].meta;
  const rows = getInt(first, 'Rows');
  const cols = getInt(first, 'Columns');
  if (!rows || !cols) return null;
  const pixelRestriction = pixelDataRestrictionReason(first);
  if (pixelRestriction) {
    skippedReasons.push(pixelRestriction);
    return null;
  }

  const modality = getStr(first, 'Modality', 'OT');
  const bitsAllocated = getInt(first, 'BitsAllocated', 16);
  const bitsStored = getInt(first, 'BitsStored', bitsAllocated);
  const pixelRepresentation = getInt(first, 'PixelRepresentation', 0); // 0=unsigned, 1=signed
  const photometric = getStr(first, 'PhotometricInterpretation', 'MONOCHROME2');
  const isInverted = photometric === 'MONOCHROME1';

  // Bit mask for BitsStored (discard padding bits)
  const bitMask = (1 << bitsStored) - 1;

  // Transfer syntax for codec detection
  const transferSyntax = getStr(first, 'TransferSyntaxUID')
    || first['00020010']?.Value?.[0] || '';
  const compressed = datasets.some(d => isCompressed(getStr(d.meta, 'TransferSyntaxUID') || transferSyntax));
  if (compressed) {
    onProgress('info', `compressed DICOM — loading codecs...`);
  }

  const sliceCanvases = [];
  const acceptedMetas = [];
  const voxelsPerSlice = rows * cols;
  const rawVolume = new Float32Array(voxelsPerSlice * datasets.length);
  let rawSliceIdx = 0;

  for (const item of datasets) {
    const meta = item.meta;
    try {
      if (getInt(meta, 'Rows') !== rows || getInt(meta, 'Columns') !== cols) continue;
      const sliceRestriction = pixelDataRestrictionReason(meta);
      if (sliceRestriction) {
        skippedReasons.push(sliceRestriction);
        return null;
      }

      let pixels;
      const sliceTransferSyntax = getStr(meta, 'TransferSyntaxUID') || transferSyntax;
      if (item.encodedValue) {
        const encodedBytes = bytesFromValue(item.encodedValue);
        if (!encodedBytes) continue;
        const encodedBuffer = arrayBufferForBytes(encodedBytes);
        pixels = await decodePixelData(encodedBuffer, sliceTransferSyntax, rows, cols, bitsAllocated);
        if (!pixels) {
          skippedReasons.push(`unsupported ${sliceTransferSyntax} compressed DICOM requires a lossless medical decoder`);
          return null;
        }
      } else if (item.pixels) {
        pixels = item.pixels;
      } else {
        const pixelData = item.pixelData;
        const buffer = pixelData?.Value?.[0] ?? pixelData?.InlineBinary;
        if (!buffer) continue;
        const bytes = bytesFromValue(buffer);
        if (!bytes) continue;
        const ab = arrayBufferForBytes(bytes);
        if (isCompressed(sliceTransferSyntax)) {
          pixels = await decodePixelData(ab, sliceTransferSyntax, rows, cols, bitsAllocated);
        } else if (bitsAllocated === 8) {
          pixels = new Uint8Array(ab);
        } else if (pixelRepresentation === 1) {
          pixels = new Int16Array(ab);
        } else {
          pixels = new Uint16Array(ab);
        }
      }

      // Per-slice rescale (can vary per frame in enhanced DICOM)
      const slope = getFloat(meta, 'RescaleSlope', 1);
      const intercept = getFloat(meta, 'RescaleIntercept', 0);

      let wl = getFloat(meta, 'WindowCenter');
      let ww = getFloat(meta, 'WindowWidth');
      const count = Math.min(pixels.length, voxelsPerSlice);
      if (!ww) {
        const auto = autoWindowLevel(pixels, count, slope, intercept);
        wl = auto.wl;
        ww = auto.ww;
      }
      const lo = wl - ww / 2;
      const range = Math.max(1, ww);

      const canvas = document.createElement('canvas');
      canvas.width = cols;
      canvas.height = rows;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(cols, rows);
      const d = imgData.data;
      const rawBase = rawSliceIdx * voxelsPerSlice;

      for (let i = 0; i < count; i++) {
        // Shape: signed `-1024`, packed signed `0x0c18`, or unsigned `4095`.
        let raw = pixels[i];
        if (pixelRepresentation === 1) {
          if (bitsStored < bitsAllocated) {
            raw &= bitMask;
            // Shape: sign bit for a 12-bit signed sample stored in 16 bits.
            const signBit = 1 << (bitsStored - 1);
            if (raw & signBit) raw |= ~bitMask;
          }
        } else {
          raw &= bitMask;
        }
        raw = raw * slope + intercept;
        rawVolume[rawBase + i] = raw;

        let v = Math.round(((raw - lo) / range) * 255);
        if (v < 0) v = 0; if (v > 255) v = 255;
        // MONOCHROME1: invert so bright = dense (standard display)
        if (isInverted) v = 255 - v;
        d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
      sliceCanvases.push(canvas);
      acceptedMetas.push(meta);
      rawSliceIdx++;
    } catch {
      // Skip bad slices
    }
  }

  if (!sliceCanvases.length) return null;

  // Normalize to [0,1]. CT: fixed HU band (see convert_ct.py); else data min/max.
  const actualVoxels = rawSliceIdx * voxelsPerSlice;
  const hrVoxels = rawSliceIdx < datasets.length
    ? rawVolume.slice(0, actualVoxels) : rawVolume;
  const isCT = normalizeModality(modality) === 'CT';
  let normLo, normHi;
  if (isCT) {
    normLo = CT_HU_LO; normHi = CT_HU_HI;
  } else {
    normLo = Infinity; normHi = -Infinity;
    for (let i = 0; i < actualVoxels; i++) {
      const v = hrVoxels[i];
      if (v < normLo) normLo = v;
      if (v > normHi) normHi = v;
    }
  }
  const normRange = normHi - normLo || 1;
  const normInv = 1 / normRange;
  for (let i = 0; i < actualVoxels; i++) {
    let v = (hrVoxels[i] - normLo) * normInv;
    if (v < 0) v = 0; if (v > 1) v = 1;
    hrVoxels[i] = v;
  }

  const geometry = geometryFromDicomMetas(acceptedMetas);
  const pixelSpacing = geometry.pixelSpacing || [0, 0];
  const thickness = Number(geometry.sliceThickness || 0);
  const sliceSpacing = Number(geometry.sliceSpacing || thickness || 0);
  const orientation = geometry.orientation || [...DEFAULT_IOP];
  const firstIPP = geometry.firstIPP || [0, 0, 0];
  const lastIPP = geometry.lastIPP || firstIPP;
  const reliableVolumeStack = importClassification.kind === 'volume-stack' && geometry.sliceSpacingRegular !== false;

  const seriesDesc = getStr(first, 'SeriesDescription') || getStr(first, 'StudyDescription');
  const bodyPart = getStr(first, 'BodyPartExamined');
  const patientName = getStr(first, 'PatientName');
  const studyDate = getStr(first, 'StudyDate');
  const geometryKind = reliableVolumeStack ? 'volumeStack' : geometryKindForImportKind(importClassification.kind);
  const reconstructionCapability = reliableVolumeStack
    ? 'display-volume'
    : reconstructionCapabilityForGeometryKind(geometryKind);

  // Build a readable name from available metadata
  let name = seriesDesc;
  if (!name) {
    const parts = [modality];
    if (bodyPart) parts.push(bodyPart);
    parts.push(`${sliceCanvases.length} slices`);
    name = parts.join(' · ');
  }

  let description = `${cols}×${rows} · ${sliceCanvases.length} slices`;
  if (pixelSpacing[0] > 0) description += ` · ${pixelSpacing[0].toFixed(2)} mm`;
  if (sliceSpacing > 0) description += ` / ${sliceSpacing.toFixed(1)} mm`;
  description += ' · local import';

  const entry = {
    slug,
    name,
    description,
    modality,
    slices: sliceCanvases.length,
    width: cols,
    height: rows,
    pixelSpacing,
    sliceThickness: thickness || sliceSpacing || 1,
    sliceSpacing,
    sliceSpacingRegular: geometry.sliceSpacingRegular !== false,
    tr: getFloat(first, 'RepetitionTime'),
    te: getFloat(first, 'EchoTime'),
    sequence: seriesDesc,
    firstIPP,
    lastIPP,
    orientation,
    group: null,
    hasBrain: false,
    hasSeg: false,
    hasSym: false,
    hasRegions: false,
    hasStats: false,
    hasAnalysis: false,
    hasMaskRaw: false,
    hasRaw: true,
    geometryKind,
    reconstructionCapability,
    renderability: reconstructionCapability === 'display-volume' ? 'volume' : '2d',
    dicomImportKind: importClassification.kind,
    isProjection: importClassification.isProjection,
    isProjectionSet: importClassification.isProjectionSet,
    isReconstructedVolumeStack: importClassification.isReconstructedVolumeStack,
    // Extra metadata for display (not used by viewer logic)
    _bodyPart: bodyPart,
    _patientName: patientName,
    _studyDate: studyDate,
    _photometric: photometric,
    _spacingKnown: pixelSpacing[0] > 0,
    _dicomImportClassification: importClassification,
  };
  for (const [key, value] of [
    ['sourceStudyUID', getStr(first, 'StudyInstanceUID')],
    ['sourceSeriesUID', getStr(first, 'SeriesInstanceUID')],
    ['frameOfReferenceUID', geometry.frameOfReferenceUID || getStr(first, 'FrameOfReferenceUID')],
    ['bodyPart', bodyPart],
  ]) {
    if (value) entry[key] = value;
  }
  if (sourceManifest?.sourceKind === 'projection') {
    entry.projectionCalibration = {
      status: 'calibrated',
      source: 'external-json',
      geometry: String(sourceManifest?.projection?.geometry || ''),
      angleCount: Array.isArray(sourceManifest?.projection?.anglesDeg) ? sourceManifest.projection.anglesDeg.length : 0,
    };
  }
  if (importClassification.kind === 'ultrasound-source') {
    entry.geometryKind = 'ultrasoundSource';
    entry.reconstructionCapability = 'requires-reconstruction';
    entry.renderability = '2d';
    entry.ultrasoundCalibration = importClassification.ultrasound?.calibrationSummary || null;
  }

  return { entry, sliceCanvases, rawVolume: hrVoxels };
}

/** Parse a local NIfTI or NIfTI.gz file into the same viewer-ready series result shape as DICOM. */
export async function parseNIfTI(file, onProgress = () => {}) {
  onProgress('reading', file.name);
  let ab = await file.arrayBuffer();

  if (file.name.endsWith('.gz')) {
    const pk = await ensurePako();
    const decompressed = pk.inflate(new Uint8Array(ab));
    ab = decompressed.buffer;
  }

  // NIfTI-1 header (348 bytes)
  const view = new DataView(ab);
  const sizeof_hdr = view.getInt32(0, true);
  const littleEndian = sizeof_hdr === 348;
  if (!littleEndian && view.getInt32(0, false) !== 348) return null;

  const dims = [];
  for (let i = 0; i < 8; i++) dims.push(view.getInt16(40 + i * 2, littleEndian));
  const nx = dims[1], ny = dims[2], nz = dims[3] || 1;
  const datatype = view.getInt16(70, littleEndian);
  const vox_offset = view.getFloat32(108, littleEndian);
  const pixdim = [];
  for (let i = 0; i < 8; i++) pixdim.push(view.getFloat32(76 + i * 4, littleEndian));
  const qform_code = view.getInt16(252, littleEndian);
  const sform_code = view.getInt16(254, littleEndian);
  const quatern_b = view.getFloat32(256, littleEndian);
  const quatern_c = view.getFloat32(260, littleEndian);
  const quatern_d = view.getFloat32(264, littleEndian);
  const qoffset_x = view.getFloat32(268, littleEndian);
  const qoffset_y = view.getFloat32(272, littleEndian);
  const qoffset_z = view.getFloat32(276, littleEndian);
  const srow_x = Array.from({ length: 4 }, (_, i) => view.getFloat32(280 + i * 4, littleEndian));
  const srow_y = Array.from({ length: 4 }, (_, i) => view.getFloat32(296 + i * 4, littleEndian));
  const srow_z = Array.from({ length: 4 }, (_, i) => view.getFloat32(312 + i * 4, littleEndian));

  // Rescale slope/intercept from header (may be 0/0 meaning identity)
  let scl_slope = view.getFloat32(112, littleEndian);
  let scl_inter = view.getFloat32(116, littleEndian);
  if (scl_slope === 0) { scl_slope = 1; scl_inter = 0; }

  onProgress('converting', `${nx}×${ny}×${nz}`);

  const offset = Math.round(vox_offset);
  let volume;
  if (datatype === 4) volume = new Int16Array(ab, offset, nx * ny * nz);
  else if (datatype === 16) volume = new Float32Array(ab, offset, nx * ny * nz);
  else if (datatype === 2) volume = new Uint8Array(ab, offset, nx * ny * nz);
  else if (datatype === 512) volume = new Uint16Array(ab, offset, nx * ny * nz);
  else if (datatype === 8) volume = new Int32Array(ab, offset, nx * ny * nz);
  else if (datatype === 64) volume = new Float64Array(ab, offset, nx * ny * nz);
  else return null;

  // Auto W/L from percentiles (for 8-bit canvas display)
  const totalVoxels = nx * ny * nz;
  const step = Math.max(1, Math.floor(totalVoxels / 50000));
  const samples = [];
  for (let i = 0; i < totalVoxels; i += step) {
    samples.push(volume[i] * scl_slope + scl_inter);
  }
  samples.sort((a, b) => a - b);
  const mn = samples[Math.floor(samples.length * 0.02)];
  const mx = samples[Math.floor(samples.length * 0.98)];
  const range = mx - mn || 1;

  // Z-major buffer: gather min/max then normalize to [0, 1].
  const rawVolume = new Float32Array(totalVoxels);
  let vMin = Infinity, vMax = -Infinity;
  for (let i = 0; i < totalVoxels; i++) {
    const v = volume[i] * scl_slope + scl_inter;
    rawVolume[i] = v;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const normInv = 1 / (vMax - vMin || 1);
  for (let i = 0; i < totalVoxels; i++) {
    rawVolume[i] = Math.max(0, Math.min(1, (rawVolume[i] - vMin) * normInv));
  }

  const fallbackPixelSpacing = [pixdim[1] || 0, pixdim[2] || 0];
  const fallbackSliceThickness = pixdim[3] || 1;
  const fallbackLastIPP = [0, 0, (nz - 1) * fallbackSliceThickness];
  const affineFromHeader = (() => {
    if (sform_code > 0) return [srow_x, srow_y, srow_z];
    if (qform_code <= 0) return null;
    const b = quatern_b;
    const c = quatern_c;
    const d = quatern_d;
    const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d));
    const qfac = pixdim[0] < 0 ? -1 : 1;
    const dx = pixdim[1] || 0;
    const dy = pixdim[2] || 0;
    const dz = pixdim[3] || 0;
    const ab = a * b, ac = a * c, ad = a * d;
    const bb = b * b, bc = b * c, bd = b * d;
    const cc = c * c, cd = c * d, dd = d * d;
    return [
      [(a * a + bb - cc - dd) * dx, 2 * (bc - ad) * dy, qfac * 2 * (bd + ac) * dz, qoffset_x],
      [2 * (bc + ad) * dx, (a * a + cc - bb - dd) * dy, qfac * 2 * (cd - ab) * dz, qoffset_y],
      [2 * (bd - ac) * dx, qfac * 2 * (cd + ab) * dy, qfac * (a * a + dd - bb - cc) * dz, qoffset_z],
    ];
  })();
  const affineValueAt = (matrix, i, j, k) => [
    matrix[0][0] * i + matrix[0][1] * j + matrix[0][2] * k + matrix[0][3],
    matrix[1][0] * i + matrix[1][1] * j + matrix[1][2] * k + matrix[1][3],
    matrix[2][0] * i + matrix[2][1] * j + matrix[2][2] * k + matrix[2][3],
  ];
  let pixelSpacing = fallbackPixelSpacing;
  let sliceThickness = fallbackSliceThickness;
  let firstIPP = [0, 0, 0];
  let lastIPP = fallbackLastIPP;
  let orientation = [...DEFAULT_IOP];
  let spacingKnown = fallbackPixelSpacing[0] > 0;
  if (affineFromHeader) {
    const col0 = [affineFromHeader[0][0], affineFromHeader[1][0], affineFromHeader[2][0]];
    const col1 = [affineFromHeader[0][1], affineFromHeader[1][1], affineFromHeader[2][1]];
    const col2 = [affineFromHeader[0][2], affineFromHeader[1][2], affineFromHeader[2][2]];
    const len0 = Math.hypot(...col0);
    const len1 = Math.hypot(...col1);
    const len2 = Math.hypot(...col2);
    const rowDir = normalize3(col0);
    const colDir = normalize3(col1);
    if (rowDir && colDir) {
      pixelSpacing = [len1, len0];
      orientation = [...rowDir, ...colDir];
      spacingKnown = len0 > 1e-6 && len1 > 1e-6;
    }
    sliceThickness = len2 > 1e-6 ? len2 : fallbackSliceThickness;
    firstIPP = [affineFromHeader[0][3], affineFromHeader[1][3], affineFromHeader[2][3]];
    lastIPP = affineValueAt(affineFromHeader, 0, 0, nz - 1);
  }

  const sliceCanvases = [];
  for (let z = 0; z < nz; z++) {
    const canvas = document.createElement('canvas');
    canvas.width = nx; canvas.height = ny;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(nx, ny);
    const d = img.data;
    const base = z * nx * ny;
    for (let i = 0; i < nx * ny; i++) {
      const raw = volume[base + i] * scl_slope + scl_inter;
      let v = Math.round(((raw - mn) / range) * 255);
      if (v < 0) v = 0; if (v > 255) v = 255;
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    sliceCanvases.push(canvas);
  }

  const slug = `nifti_${Date.now().toString(36)}`;
  const entry = {
    slug,
    name: file.name.replace(/\.nii(\.gz)?$/, ''),
    description: `${nx}×${ny}×${nz} · NIfTI import`,
    modality: 'OT',
    slices: nz,
    width: nx,
    height: ny,
    pixelSpacing,
    sliceThickness,
    tr: 0, te: 0,
    sequence: '',
    firstIPP,
    lastIPP,
    orientation,
    group: null,
    hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false,
    hasStats: false, hasAnalysis: false, hasMaskRaw: false, hasRaw: true,
    _spacingKnown: spacingKnown,
  };

  return { entry, sliceCanvases, rawVolume };
}
