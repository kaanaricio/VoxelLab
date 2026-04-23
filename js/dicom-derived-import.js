// DICOM derived-object import path. Normalizes SEG, RTSTRUCT, and
// lightweight SR into the existing viewer primitives:
//   - SEG -> region overlay stack on the bound source series
//   - RTSTRUCT -> ROI polygons on the bound source series
//   - SR -> annotation notes on the bound source series

import { state } from './state.js';
import { DCMJS_IMPORT_URL } from './dependencies.js';
import { frameMetasForInstance } from './dicom-frame-meta.js';
import { geometryFromSeries } from './geometry.js';
import { fetchSeriesItems, fetchSeriesMetadataJson } from './dicomweb/dicomweb-source.js';
import {
  buildDerivedRegistryEntry,
  getDerivedRegistryEntry,
  listDerivedRegistryEntriesForSeries,
  upsertDerivedRegistryEntry,
} from './derived-objects.js';
import {
  nextDrawingEntryId,
  noteEntriesForSlice,
  roiEntriesForSlice,
  setNoteEntriesForSlice,
  setRoiEntriesForSlice,
} from './annotation-graph.js';
import { setSeriesOverlayHints } from './runtime/overlay-kinds.js';

const DERIVED_MODALITIES = new Set(['SEG', 'RTSTRUCT', 'SR', 'RTDOSE']);

let _dcmjs = null;

function shapeColor(index) {
  const hue = (index * 57) % 360;
  const sat = 0.72;
  const light = 0.58;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const [r1, g1, b1] = hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
    : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c]
    : hue < 300 ? [x, 0, c]
    : [c, 0, x];
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

async function ensureDcmjs() {
  if (_dcmjs) return _dcmjs;
  _dcmjs = await import(DCMJS_IMPORT_URL);
  return _dcmjs;
}

function normalizeModality(modality) {
  return String(modality || '').trim().toUpperCase();
}

export function isDerivedObjectModality(modality) {
  return DERIVED_MODALITIES.has(normalizeModality(modality));
}

function sourceSeriesFromUIDOrFrameOfReference(manifest, sourceUID, frameOfReferenceUID) {
  if (sourceUID) {
    const byUid = findSeriesByUID(manifest, sourceUID);
    if (byUid) return byUid;
  }
  if (!frameOfReferenceUID) return null;
  const matches = (manifest?.series || [])
    .map((series, index) => ({ series, index }))
    .filter(({ series }) => String(series?.frameOfReferenceUID || '') === frameOfReferenceUID);
  if (matches.length === 1) return matches[0];
  return null;
}

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

function seqFirst(value) {
  return Array.isArray(value) ? (value[0] || null) : (value || null);
}

function bitPackedFrame(bytes, pixelCount) {
  const out = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const byte = bytes[i >> 3] || 0;
    out[i] = (byte >> (i & 7)) & 1;
  }
  return out;
}

function segFramePixels(bytes, pixelCount, bitsAllocated) {
  if (bitsAllocated !== 1 || bytes.byteLength >= pixelCount) return bytes.slice(0, pixelCount);
  return bitPackedFrame(bytes, pixelCount);
}

function bytesFromValue(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') {
    const binary = globalThis.atob ? globalThis.atob(value) : '';
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(0);
}

function findSeriesByUID(manifest, seriesUID) {
  const index = (manifest?.series || []).findIndex((series) => series?.sourceSeriesUID === seriesUID);
  return index >= 0 ? { index, series: manifest.series[index] } : null;
}

function invert3x3(matrix) {
  const [
    [a, b, c],
    [d, e, f],
    [g, h, i],
  ] = matrix;
  const cofactor00 = (e * i) - (f * h);
  const cofactor01 = -((d * i) - (f * g));
  const cofactor02 = (d * h) - (e * g);
  const det = (a * cofactor00) + (b * cofactor01) + (c * cofactor02);
  if (Math.abs(det) < 1e-8) return null;
  const invDet = 1 / det;
  return [
    [cofactor00 * invDet, -((b * i) - (c * h)) * invDet, ((b * f) - (c * e)) * invDet],
    [cofactor01 * invDet, ((a * i) - (c * g)) * invDet, -((a * f) - (c * d)) * invDet],
    [cofactor02 * invDet, -((a * h) - (b * g)) * invDet, ((a * e) - (b * d)) * invDet],
  ];
}

function voxelPointForLps(series, point) {
  const geo = geometryFromSeries(series);
  const delta = [
    point[0] - geo.firstIPP[0],
    point[1] - geo.firstIPP[1],
    point[2] - geo.firstIPP[2],
  ];
  const inverse = invert3x3([
    [geo.affineLps[0][0], geo.affineLps[0][1], geo.affineLps[0][2]],
    [geo.affineLps[1][0], geo.affineLps[1][1], geo.affineLps[1][2]],
    [geo.affineLps[2][0], geo.affineLps[2][1], geo.affineLps[2][2]],
  ]);
  if (!inverse) return null;
  const x = (inverse[0][0] * delta[0]) + (inverse[0][1] * delta[1]) + (inverse[0][2] * delta[2]);
  const y = (inverse[1][0] * delta[0]) + (inverse[1][1] * delta[1]) + (inverse[1][2] * delta[2]);
  const z = (inverse[2][0] * delta[0]) + (inverse[2][1] * delta[1]) + (inverse[2][2] * delta[2]);
  return [x, y, z];
}

function sliceIndexForIPP(series, ipp, toleranceMm = 1.2) {
  const voxelPoint = voxelPointForLps(series, ipp);
  if (!voxelPoint) return -1;
  const [, , z] = voxelPoint;
  const rounded = Math.round(z);
  return Math.abs(z - rounded) <= toleranceMm / Math.max(geoSliceSpacing(series), 1e-6)
    ? Math.max(0, Math.min(series.slices - 1, rounded))
    : -1;
}

function geoSliceSpacing(series) {
  const geo = geometryFromSeries(series);
  return geo.sliceSpacing || series.sliceSpacing || series.sliceThickness || 1;
}

function emptyLabelSlices(width, height, depth) {
  return Array.from({ length: depth }, () => new Uint8Array(width * height));
}

function buildRegionMeta(sourceSeries, segmentDefs) {
  const voxelMl = (sourceSeries.pixelSpacing?.[0] || 1)
    * (sourceSeries.pixelSpacing?.[1] || 1)
    * geoSliceSpacing(sourceSeries)
    / 1000;
  const regions = {};
  const colors = {};
  for (const segment of segmentDefs) {
    regions[segment.label] = {
      name: segment.name,
      mL: +(segment.voxelCount * voxelMl).toFixed(3),
      source: segment.kind,
    };
    colors[segment.label] = segment.color;
  }
  return { regions, colors };
}

function labelSlicesToImages(labelSlices, width, height) {
  return labelSlices.map((labels) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    for (let i = 0; i < labels.length; i++) {
      const value = labels[i];
      const base = i * 4;
      image.data[base] = value;
      image.data[base + 1] = value;
      image.data[base + 2] = value;
      image.data[base + 3] = value ? 255 : 0;
    }
    ctx.putImageData(image, 0, 0);
    const img = new Image();
    img.src = canvas.toDataURL('image/png');
    return img;
  });
}

function mergeLabelSlices(existing, incoming, offset) {
  return existing.map((slice, index) => {
    const merged = slice.slice();
    const next = incoming[index];
    for (let i = 0; i < merged.length; i++) {
      if (next[i] > 0) merged[i] = next[i] + offset;
    }
    return merged;
  });
}

function nextLocalLabelOffset(meta = null) {
  const regionIds = Object.keys(meta?.regions || {}).map(Number).filter(Number.isFinite);
  return regionIds.length ? Math.max(...regionIds) : 0;
}

function sourceSeriesDerivedState(series) {
  state._localDerivedObjects[series.slug] = state._localDerivedObjects[series.slug] || {};
  return state._localDerivedObjects[series.slug];
}

function objectUIDForMeta(meta, fallbackKind = 'derived') {
  return String(meta?.SOPInstanceUID || meta?.SeriesInstanceUID || `${fallbackKind}:${meta?.SeriesDescription || 'object'}`);
}

function derivedSeriesForBinding(sourceSeries, meta, geometryKind = 'source-compatible') {
  const frameOfReferenceUID = String(meta?.FrameOfReferenceUID || sourceSeries?.frameOfReferenceUID || '');
  if (geometryKind === 'source-compatible') return { ...sourceSeries, frameOfReferenceUID };
  return { frameOfReferenceUID };
}

function rememberDerivedObject(sourceSeries, meta, derivedKind, name, payload = null, geometryKind = 'source-compatible') {
  const objectUID = objectUIDForMeta(meta, derivedKind);
  if (getDerivedRegistryEntry(sourceSeries, objectUID)) return { accepted: false, objectUID };
  const entry = buildDerivedRegistryEntry({
    derivedKind,
    sourceSeries,
    derivedSeries: derivedSeriesForBinding(sourceSeries, meta, geometryKind),
    objectUID,
    name,
    modality: normalizeModality(meta?.Modality || derivedKind),
    payload,
  });
  const { persisted } = upsertDerivedRegistryEntry(entry);
  sourceSeriesDerivedState(sourceSeries)[objectUID] = { kind: derivedKind, name: entry.name };
  return { accepted: true, objectUID, persisted };
}

function serializeSegPayload(labelSlices, regionMeta) {
  const sparseSlices = [];
  let pairCount = 0;
  for (const labels of labelSlices) {
    const sparse = [];
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label > 0) {
        sparse.push(i, label);
        pairCount += 1;
      }
    }
    sparseSlices.push(sparse);
  }
  if (pairCount > 200000) return null;
  return {
    format: 'seg-overlay-v1',
    sparseSlices,
    regionMeta,
  };
}

function deserializeSegPayload(payload, width, height, slices) {
  if (payload?.format !== 'seg-overlay-v1' || !Array.isArray(payload?.sparseSlices)) return null;
  const total = width * height;
  const labelSlices = emptyLabelSlices(width, height, slices);
  for (let z = 0; z < Math.min(slices, payload.sparseSlices.length); z++) {
    const sparse = payload.sparseSlices[z];
    if (!Array.isArray(sparse)) continue;
    const target = labelSlices[z];
    for (let i = 0; i + 1 < sparse.length; i += 2) {
      const index = Number(sparse[i]);
      const label = Number(sparse[i + 1]);
      if (Number.isInteger(index) && index >= 0 && index < total && Number.isFinite(label) && label > 0) {
        target[index] = label;
      }
    }
  }
  return {
    labelSlices,
    regionMeta: payload?.regionMeta || { regions: {}, colors: {} },
  };
}

function attachRegionOverlay(sourceSeries, overlay) {
  const existingMeta = state._localRegionMetaBySlug[sourceSeries.slug] || null;
  const existingSlices = state._localRegionLabelSlicesBySlug[sourceSeries.slug] || null;
  if (sourceSeries.hasRegions && !existingMeta && !existingSlices) {
    throw new Error(`${sourceSeries.name} already uses the region-overlay slot; refusing to overwrite it with imported SEG data`);
  }

  const offset = nextLocalLabelOffset(existingMeta);
  const mergedSlices = existingSlices
    ? mergeLabelSlices(existingSlices, overlay.labelSlices, offset)
    : mergeLabelSlices(emptyLabelSlices(sourceSeries.width, sourceSeries.height, sourceSeries.slices), overlay.labelSlices, offset);
  const mergedMeta = existingMeta ? {
    regions: { ...(existingMeta.regions || {}) },
    colors: { ...(existingMeta.colors || {}) },
  } : { regions: {}, colors: {} };
  for (const [label, region] of Object.entries(overlay.regionMeta.regions)) {
    const shifted = Number(label) + offset;
    mergedMeta.regions[shifted] = region;
    mergedMeta.colors[shifted] = overlay.regionMeta.colors[label];
  }

  state._localRegionMetaBySlug[sourceSeries.slug] = mergedMeta;
  state._localRegionLabelSlicesBySlug[sourceSeries.slug] = mergedSlices;
  state._localStacks[`${sourceSeries.slug}_regions`] = labelSlicesToImages(mergedSlices, sourceSeries.width, sourceSeries.height);
  setSeriesOverlayHints(sourceSeries, {
    labels: {
      source: overlay.overlaySource || (overlay.kind === 'seg' ? 'dicom-seg' : 'local-regions'),
      legacyKinds: [overlay.legacySlot || 'regions', overlay.kind],
    },
  });
  sourceSeries.hasRegions = true;
  return { count: Object.keys(overlay.regionMeta.regions).length };
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += (x1 * y2) - (x2 * y1);
  }
  return Math.abs(sum) * 0.5;
}

function appendRois(sourceSeries, objectUID, roisBySlice) {
  for (const [sliceIndex, rois] of Object.entries(roisBySlice)) {
    const existing = roiEntriesForSlice(sourceSeries.slug, sliceIndex);
    setRoiEntriesForSlice(sourceSeries.slug, sliceIndex, existing.concat(rois));
  }
  return { skipped: false, count: Object.keys(roisBySlice).length };
}

function appendAnnotations(sourceSeries, objectUID, annotationsBySlice) {
  for (const [sliceIndex, notes] of Object.entries(annotationsBySlice)) {
    const existing = noteEntriesForSlice(sourceSeries.slug, sliceIndex);
    const nextId = nextDrawingEntryId(existing);
    setNoteEntriesForSlice(sourceSeries.slug, sliceIndex, existing.concat(notes.map((note, index) => ({
      id: nextId + index,
      x: note.x,
      y: note.y,
      text: note.text,
      createdAt: Date.now(),
      sourceObjectUID: objectUID,
    }))));
  }
  return { skipped: false, count: Object.keys(annotationsBySlice).length };
}

function segSourceSeriesUID(meta) {
  const referenced = seqFirst(meta?.ReferencedSeriesSequence);
  return String(referenced?.SeriesInstanceUID || '');
}

function segmentDefinitions(meta) {
  const sequence = Array.isArray(meta?.SegmentSequence) ? meta.SegmentSequence : [];
  return sequence.map((segment, index) => ({
    number: Number(segment?.SegmentNumber || index + 1),
    label: index + 1,
    name: String(segment?.SegmentLabel || segment?.SegmentDescription || `Segment ${index + 1}`),
    color: shapeColor(index + 1),
    voxelCount: 0,
    kind: 'dicom-seg',
  }));
}

export function buildSegOverlayImport(dataset, sourceSeries) {
  const meta = dataset?.meta || {};
  if (normalizeModality(meta.Modality) !== 'SEG') return null;
  const rows = Number(meta.Rows || 0);
  const cols = Number(meta.Columns || 0);
  if (rows !== sourceSeries.height || cols !== sourceSeries.width) {
    throw new Error(`SEG rows/columns ${cols}×${rows} do not match source series ${sourceSeries.width}×${sourceSeries.height}`);
  }

  const frames = frameMetasForInstance(meta) || [];
  const perFrame = Array.isArray(meta.PerFrameFunctionalGroupsSequence) ? meta.PerFrameFunctionalGroupsSequence : [];
  const pixelData = dataset?.pixelData;
  const values = Array.isArray(pixelData?.Value) ? pixelData.Value : [];
  const inline = pixelData?.InlineBinary;
  const framePixelCount = rows * cols;
  const bitsAllocated = Number(meta.BitsAllocated || 1);
  const packedFrameByteCount = bitsAllocated === 1 ? Math.ceil(framePixelCount / 8) : framePixelCount;
  const frameValues = values.length === frames.length ? values.map((value) => bytesFromValue(value)) : null;
  const packedBytes = frameValues ? null : bytesFromValue(values[0] ?? inline);
  const packedBytesAreUnpacked = bitsAllocated === 1 && packedBytes?.byteLength === frames.length * framePixelCount;
  const frameByteCount = packedBytesAreUnpacked ? framePixelCount : packedFrameByteCount;
  if ((!frameValues && !packedBytes.length) || !frames.length) {
    throw new Error('SEG import requires frame metadata and uncompressed pixel data');
  }

  const segments = segmentDefinitions(meta);
  const segmentByNumber = new Map(segments.map((segment) => [segment.number, segment]));
  const labelSlices = emptyLabelSlices(cols, rows, sourceSeries.slices);

  for (let index = 0; index < frames.length; index++) {
    const frameMeta = frames[index];
    const segIdent = seqFirst(perFrame[index]?.SegmentIdentificationSequence);
    const segmentNumber = Number(segIdent?.ReferencedSegmentNumber || 1);
    const segment = segmentByNumber.get(segmentNumber);
    if (!segment) continue;
    const ipp = numberList(frameMeta.ImagePositionPatient, 3);
    const sliceIndex = ipp.length >= 3 ? sliceIndexForIPP(sourceSeries, ipp) : index;
    if (sliceIndex < 0 || sliceIndex >= sourceSeries.slices) continue;
    const frameBytes = frameValues
      ? frameValues[index]
      : packedBytes.slice(index * frameByteCount, (index + 1) * frameByteCount);
    const pixels = segFramePixels(frameBytes, framePixelCount, bitsAllocated);
    const target = labelSlices[sliceIndex];
    for (let i = 0; i < framePixelCount; i++) {
      if (pixels[i] > 0) {
        target[i] = segment.label;
        segment.voxelCount += 1;
      }
    }
  }

  return {
    kind: 'seg',
    overlayKind: 'labels',
    legacySlot: 'regions',
    overlaySource: 'dicom-seg',
    name: String(meta.SeriesDescription || meta.SeriesInstanceUID || 'SEG import'),
    labelSlices,
    regionMeta: buildRegionMeta(sourceSeries, segments.filter((segment) => segment.voxelCount > 0)),
  };
}

function rtstructSourceSeriesUID(meta) {
  const frameRef = seqFirst(meta?.ReferencedFrameOfReferenceSequence);
  const studyRef = seqFirst(frameRef?.RTReferencedStudySequence);
  const seriesRef = seqFirst(studyRef?.RTReferencedSeriesSequence);
  return String(seriesRef?.SeriesInstanceUID || '');
}

function rtdoseSourceSeriesUID(meta) {
  const source = seqFirst(meta?.ReferencedSeriesSequence);
  return String(source?.SeriesInstanceUID || '');
}

export function buildRtDoseImport(meta, sourceSeries) {
  if (normalizeModality(meta?.Modality) !== 'RTDOSE') return null;
  const rows = Number(meta?.Rows || 0);
  const cols = Number(meta?.Columns || 0);
  const frames = Number(meta?.NumberOfFrames || 1);
  const scaling = Number(meta?.DoseGridScaling || 0);
  const doseUnits = String(meta?.DoseUnits || '').trim();
  const doseType = String(meta?.DoseType || '').trim();
  const summationType = String(meta?.DoseSummationType || '').trim();
  return {
    kind: 'rtdose',
    name: String(meta?.SeriesDescription || meta?.SeriesInstanceUID || 'RTDOSE import'),
    summary: {
      format: 'rtdose-summary-v1',
      rows,
      cols,
      frames,
      doseGridScaling: Number.isFinite(scaling) ? scaling : 0,
      doseUnits,
      doseType,
      doseSummationType: summationType,
      frameOfReferenceUID: String(meta?.FrameOfReferenceUID || sourceSeries?.frameOfReferenceUID || ''),
    },
  };
}

export function buildRTStructImport(meta, sourceSeries) {
  if (normalizeModality(meta?.Modality) !== 'RTSTRUCT') return null;
  const sliceSpacing = Math.max(geoSliceSpacing(sourceSeries), 1e-6);
  const planeToleranceMm = 1.2;
  const planeToleranceSlices = planeToleranceMm / sliceSpacing;
  const names = new Map((meta.StructureSetROISequence || []).map((roi) => [
    Number(roi?.ROINumber || 0),
    String(roi?.ROIName || roi?.ROIDescription || `ROI ${roi?.ROINumber || ''}`).trim() || 'ROI',
  ]));
  const roisBySlice = {};
  for (const contourGroup of meta.ROIContourSequence || []) {
    const roiNumber = Number(contourGroup?.ReferencedROINumber || 0);
    const roiName = names.get(roiNumber) || `ROI ${roiNumber || ''}`.trim();
    for (const contour of contourGroup?.ContourSequence || []) {
      if (String(contour?.ContourGeometricType || '').toUpperCase() !== 'CLOSED_PLANAR') continue;
      const raw = numberList(contour?.ContourData, 6);
      if (raw.length < 6 || raw.length % 3 !== 0) continue;
      const points = [];
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let invalidPoint = false;
      for (let i = 0; i < raw.length; i += 3) {
        cx += raw[i];
        cy += raw[i + 1];
        cz += raw[i + 2];
        const point = voxelPointForLps(sourceSeries, [raw[i], raw[i + 1], raw[i + 2]]);
        if (!point) {
          invalidPoint = true;
          break;
        }
        points.push(point);
      }
      if (invalidPoint) continue;
      const centroid = [
        cx / points.length,
        cy / points.length,
        cz / points.length,
      ];
      const zSpread = points.reduce((spread, point) => ({
        min: Math.min(spread.min, point[2]),
        max: Math.max(spread.max, point[2]),
      }), { min: Infinity, max: -Infinity });
      const sliceIndex = sliceIndexForIPP(sourceSeries, centroid, planeToleranceMm);
      if (sliceIndex < 0 || sliceIndex >= sourceSeries.slices) continue;
      if ((zSpread.max - zSpread.min) > planeToleranceSlices) continue;
      const polygon = points.map(([x, y]) => [x, y]);
      const areaPx = polygonArea(polygon);
      const areaMm2 = areaPx * (sourceSeries.pixelSpacing?.[0] || 1) * (sourceSeries.pixelSpacing?.[1] || 1);
      const key = String(sliceIndex);
      roisBySlice[key] = roisBySlice[key] || [];
      roisBySlice[key].push({
        shape: 'polygon',
        pts: polygon,
        text: roiName,
        sourceObjectUID: String(meta.SOPInstanceUID || ''),
        stats: { area_mm2: areaMm2 },
      });
    }
  }
  return { kind: 'rtstruct', name: String(meta.SeriesDescription || meta.SeriesInstanceUID || 'RTSTRUCT import'), roisBySlice };
}

function contentItems(node) {
  return Array.isArray(node?.ContentSequence) ? node.ContentSequence : [];
}

function itemMeaning(item) {
  return String(seqFirst(item?.ConceptNameCodeSequence)?.CodeMeaning || '').trim();
}

function itemText(item) {
  return String(item?.TextValue || '').trim();
}

function itemNumber(item) {
  const measured = seqFirst(item?.MeasuredValueSequence);
  return Number(measured?.NumericValue);
}

function collectMeasurementGroups(dataset) {
  const groups = [];
  const stack = [...contentItems(dataset)];
  while (stack.length) {
    const item = stack.shift();
    if (itemMeaning(item) === 'Measurement Group') groups.push(item);
    stack.push(...contentItems(item));
  }
  return groups;
}

function srAnnotationText(group) {
  const lines = [];
  for (const item of contentItems(group)) {
    const meaning = itemMeaning(item);
    if (item?.ValueType === 'NUM' && Number.isFinite(itemNumber(item))) {
      lines.push(`${meaning}: ${itemNumber(item)}`);
    } else if (item?.ValueType === 'TEXT' && itemText(item)) {
      lines.push(`${meaning}: ${itemText(item)}`);
    }
  }
  return lines.join('\n').trim();
}

function parseViewerSrReference(item) {
  const text = itemText(item);
  const match = text.match(/^(.+?)\s+slice\s+(\d+)$/i);
  if (!match) return null;
  return {
    sourceSlug: match[1].trim(),
    sliceIndex: Math.max(0, Number(match[2]) - 1),
  };
}

export function buildSRImport(meta, sourceSeries) {
  if (normalizeModality(meta?.Modality) !== 'SR') return null;
  const groups = collectMeasurementGroups(meta);
  if (!groups.length) return null;
  const width = Number(sourceSeries.width || 1);
  const height = Number(sourceSeries.height || 1);
  const annotationsBySlice = {};
  for (const group of groups) {
    const sourceText = contentItems(group).find((item) => itemMeaning(item) === 'Referenced Series');
    const reference = parseViewerSrReference(sourceText);
    if (!reference || reference.sourceSlug !== sourceSeries.slug) {
      throw new Error('SR import currently supports only VoxelLab viewer-exported measurement notes with explicit "<slug> slice N" references');
    }
    const sliceIndex = Math.max(0, Math.min(sourceSeries.slices - 1, reference.sliceIndex));
    const text = srAnnotationText(group);
    if (!text) continue;
    const key = String(sliceIndex);
    annotationsBySlice[key] = annotationsBySlice[key] || [];
    annotationsBySlice[key].push({
      x: width / 2,
      y: height / 2,
      text,
    });
  }
  return {
    kind: 'sr',
    name: String(meta.SeriesDescription || meta.SeriesInstanceUID || 'SR import'),
    annotationsBySlice,
  };
}

async function readLocalDicomObjects(files = []) {
  const dcmjs = await ensureDcmjs();
  const DicomMessage = dcmjs.data.DicomMessage;
  const out = [];
  for (const file of files) {
    try {
      const ab = await file.arrayBuffer();
      const ds = DicomMessage.readFile(ab);
      const meta = dcmjs.data.DicomMetaDictionary.naturalizeDataset(ds.dict);
      out.push({ meta, pixelData: ds.dict['7FE00010'], file });
    } catch {
      // Ignore non-DICOM files.
    }
  }
  return out;
}

function applyDerivedDataset(manifest, dataset) {
  const meta = dataset?.meta || {};
  const modality = normalizeModality(meta.Modality);
  let sourceUid = '';
  if (modality === 'SEG') sourceUid = segSourceSeriesUID(meta);
  else if (modality === 'RTSTRUCT') sourceUid = rtstructSourceSeriesUID(meta);
  else if (modality === 'RTDOSE') sourceUid = rtdoseSourceSeriesUID(meta);
  const sourceRef = sourceSeriesFromUIDOrFrameOfReference(
    manifest,
    sourceUid,
    String(meta?.FrameOfReferenceUID || ''),
  );
  if (!sourceRef) {
    if (modality === 'SR') return { skipped: true, reason: 'SR import needs a loaded source series with a matching slug/series context' };
    return { skipped: true, reason: `No loaded source series matches derived-object references (uid=${sourceUid || '(missing)'}, for=${String(meta?.FrameOfReferenceUID || '(missing)')})` };
  }

  if (modality === 'SEG') {
    const overlay = buildSegOverlayImport(dataset, sourceRef.series);
    if (!overlay) return { skipped: true, reason: 'SEG import produced no overlay' };
    const payload = serializeSegPayload(overlay.labelSlices, overlay.regionMeta);
    const remember = rememberDerivedObject(sourceRef.series, meta, 'seg', overlay.name, payload, 'source-compatible');
    if (!remember.accepted) return { skipped: true, reason: `Derived object ${remember.objectUID} already imported`, sourceSlug: sourceRef.series.slug, kind: 'seg' };
    const attached = attachRegionOverlay(sourceRef.series, overlay);
    return { skipped: false, ...attached, sourceSlug: sourceRef.series.slug, kind: 'seg', persisted: remember.persisted };
  }
  if (modality === 'RTSTRUCT') {
    const overlay = buildRTStructImport(meta, sourceRef.series);
    if (!overlay) return { skipped: true, reason: 'RTSTRUCT import produced no planar contours' };
    const remember = rememberDerivedObject(sourceRef.series, meta, 'rtstruct', overlay.name, {
      format: 'rtstruct-summary-v1',
      contourSlices: Object.keys(overlay.roisBySlice).length,
    }, 'source-compatible');
    if (!remember.accepted) return { skipped: true, reason: `Derived object ${remember.objectUID} already imported`, sourceSlug: sourceRef.series.slug, kind: 'rtstruct' };
    const appended = appendRois(sourceRef.series, remember.objectUID, overlay.roisBySlice);
    return { skipped: false, ...appended, sourceSlug: sourceRef.series.slug, kind: 'rtstruct', persisted: remember.persisted };
  }
  if (modality === 'RTDOSE') {
    const dose = buildRtDoseImport(meta, sourceRef.series);
    if (!dose) return { skipped: true, reason: 'RTDOSE import produced no summary' };
    const remember = rememberDerivedObject(sourceRef.series, meta, 'rtdose', dose.name, dose.summary, 'frame-only');
    if (!remember.accepted) return { skipped: true, reason: `Derived object ${remember.objectUID} already imported`, sourceSlug: sourceRef.series.slug, kind: 'rtdose' };
    state._localRtDoseBySlug[sourceRef.series.slug] = state._localRtDoseBySlug[sourceRef.series.slug] || [];
    state._localRtDoseBySlug[sourceRef.series.slug].push({
      objectUID: remember.objectUID,
      name: dose.name,
      summary: dose.summary,
    });
    return { skipped: false, count: 1, sourceSlug: sourceRef.series.slug, kind: 'rtdose', persisted: remember.persisted };
  }
  return { skipped: true, reason: `Unsupported derived modality ${modality}` };
}

function applyDerivedSr(manifest, meta) {
  const groups = collectMeasurementGroups(meta);
  if (!groups.length) return { skipped: true, reason: 'SR import contains no measurement groups' };
  const sourceText = contentItems(groups[0]).find((item) => itemMeaning(item) === 'Referenced Series');
  const reference = parseViewerSrReference(sourceText);
  if (!reference) {
    return { skipped: true, reason: 'SR import currently supports only VoxelLab viewer-exported measurement notes with explicit "<slug> slice N" references' };
  }
  const sourceSlug = reference.sourceSlug;
  const sourceSeries = (manifest?.series || []).find((series) => series?.slug === sourceSlug);
  if (!sourceSeries) {
    return { skipped: true, reason: `No loaded source series matches SR reference ${sourceSlug || '(missing)'}` };
  }
  let sr = null;
  try {
    sr = buildSRImport(meta, sourceSeries);
  } catch (error) {
    return { skipped: true, reason: error?.message || 'SR import rejected unsupported measurement encoding' };
  }
  if (!sr) return { skipped: true, reason: 'SR import produced no annotations' };
  const remember = rememberDerivedObject(sourceSeries, meta, 'sr', sr.name, {
    format: 'sr-summary-v1',
    annotationSlices: Object.keys(sr.annotationsBySlice).length,
  }, 'source-compatible');
  if (!remember.accepted) return { skipped: true, reason: `Derived object ${remember.objectUID} already imported`, sourceSlug: sourceSeries.slug, kind: 'sr' };
  const appended = appendAnnotations(sourceSeries, remember.objectUID, sr.annotationsBySlice);
  return { skipped: false, ...appended, sourceSlug: sourceSeries.slug, kind: 'sr', persisted: remember.persisted };
}

function hydrateSegEntries(sourceSeries, entries) {
  if (state._localRegionLabelSlicesBySlug[sourceSeries.slug]) return;
  const segEntries = entries.filter((entry) => entry?.binding?.derivedKind === 'seg');
  for (const entry of segEntries) {
    const overlay = deserializeSegPayload(entry.payload, sourceSeries.width, sourceSeries.height, sourceSeries.slices);
    if (!overlay) continue;
    attachRegionOverlay(sourceSeries, {
      kind: 'seg',
      overlayKind: 'labels',
      legacySlot: 'regions',
      overlaySource: 'dicom-seg',
      name: entry.name,
      labelSlices: overlay.labelSlices,
      regionMeta: overlay.regionMeta,
    });
  }
}

function hydrateRtDoseEntries(sourceSeries, entries) {
  const doseEntries = entries.filter((entry) => entry?.binding?.derivedKind === 'rtdose' && entry?.payload?.format === 'rtdose-summary-v1');
  if (!doseEntries.length) return;
  state._localRtDoseBySlug[sourceSeries.slug] = doseEntries.map((entry) => ({
    objectUID: entry.objectUID,
    name: entry.name,
    summary: entry.payload,
  }));
}

export function hydrateDerivedStateForSeries(sourceSeries) {
  const entries = listDerivedRegistryEntriesForSeries(sourceSeries);
  const derivedState = sourceSeriesDerivedState(sourceSeries);
  for (const key of Object.keys(derivedState)) delete derivedState[key];
  for (const entry of entries) {
    derivedState[entry.objectUID] = {
      kind: entry.binding.derivedKind,
      name: entry.name,
    };
  }
  hydrateSegEntries(sourceSeries, entries);
  hydrateRtDoseEntries(sourceSeries, entries);
  return entries;
}

export async function importLocalDerivedObjects(files, manifest, onProgress = () => {}) {
  onProgress('derived', 'reading derived objects...');
  const objects = await readLocalDicomObjects(files);
  const summaries = [];
  for (const dataset of objects) {
    const modality = normalizeModality(dataset?.meta?.Modality);
    if (!isDerivedObjectModality(modality)) continue;
    const result = modality === 'SR'
      ? applyDerivedSr(manifest, dataset.meta)
      : applyDerivedDataset(manifest, dataset);
    summaries.push({ modality, ...result });
  }
  return summaries;
}

function naturalizeDicomJsonInstances(rawInstances, dcmjs) {
  return rawInstances.map((instance) => dcmjs.data.DicomMetaDictionary.naturalizeDataset(instance));
}

export async function importDicomwebDerivedObject({
  wadoBase,
  studyUID,
  seriesUID,
  headers = {},
  fetchImpl,
  signal,
  manifest,
}) {
  const rawInstances = await fetchSeriesMetadataJson({ wadoBase, studyUID, seriesUID, headers, fetchImpl, signal });
  const dcmjs = await ensureDcmjs();
  const metas = naturalizeDicomJsonInstances(rawInstances, dcmjs);
  const first = metas[0] || {};
  const modality = normalizeModality(first.Modality);
  if (!isDerivedObjectModality(modality)) {
    throw new Error(`DICOMweb series ${seriesUID} is not a supported derived object`);
  }
  if (modality === 'SEG') {
    const items = await fetchSeriesItems({ wadoBase, studyUID, seriesUID, headers, fetchImpl, signal });
    const dataset = {
      meta: first,
      pixelData: { Value: items.map((item) => item.pixelData?.Value?.[0]).filter(Boolean) },
    };
    return { modality, ...applyDerivedDataset(manifest, dataset) };
  }
  if (modality === 'RTSTRUCT') {
    return { modality, ...applyDerivedDataset(manifest, { meta: first }) };
  }
  if (modality === 'RTDOSE') {
    return { modality, ...applyDerivedDataset(manifest, { meta: first }) };
  }
  return { modality, ...applyDerivedSr(manifest, first) };
}
