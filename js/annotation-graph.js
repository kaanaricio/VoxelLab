import { storageJsonGet, storageJsonSet } from './derived-objects.js';

export const MEASUREMENT_STORAGE_KEY = 'mri-viewer/measurements/v1';
export const ANGLE_STORAGE_KEY = 'mri-viewer/angles/v1';
export const ROI_STORAGE_KEY = 'mri-viewer/rois/v1';
export const NOTE_STORAGE_KEY = 'mri-viewer/annotations/v1';

function sliceKey(slug, sliceIdx) {
  return `${slug}|${sliceIdx}`;
}

function readBucket(key) {
  return storageJsonGet(key, {});
}

function writeBucket(key, value) {
  return storageJsonSet(key, value);
}

function readSliceBucket(storageKey, slug, sliceIdx) {
  const all = readBucket(storageKey);
  return Array.isArray(all[sliceKey(slug, sliceIdx)]) ? all[sliceKey(slug, sliceIdx)] : [];
}

function writeSliceBucket(storageKey, slug, sliceIdx, list) {
  const all = readBucket(storageKey);
  const key = sliceKey(slug, sliceIdx);
  if (Array.isArray(list) && list.length) all[key] = list;
  else delete all[key];
  writeBucket(storageKey, all);
  return list;
}

function pushSeriesEntries(out, slug, bucket, kind, mapEntry) {
  for (const key of Object.keys(bucket || {})) {
    if (!key.startsWith(`${slug}|`)) continue;
    const sliceIdx = Number(key.split('|')[1] || 0);
    for (const entry of bucket[key] || []) out.push(mapEntry(entry, sliceIdx, key));
  }
}

function entryId(kind, slug, sliceIdx, entry, index) {
  return `${kind}:${slug}|${sliceIdx}:${entry?.id ?? index}`;
}

function listForSlice(hostBucket, storageKey, slug, sliceIdx) {
  const key = sliceKey(slug, sliceIdx);
  const storageList = readSliceBucket(storageKey, slug, sliceIdx);
  if (storageList.length) return storageList;
  return Array.isArray(hostBucket?.[key]) ? hostBucket[key] : [];
}

// Shape: { measurements: 1, angles: 0, rois: 2, notes: 1, total: 4 }.
export function drawingCountsForSlice(host, slug, sliceIdx) {
  const measurements = measurementEntriesForSlice(host, slug, sliceIdx).length;
  const angles = angleEntriesForSlice(host, slug, sliceIdx).length;
  const rois = roiEntriesForSlice(slug, sliceIdx).length;
  const notes = noteEntriesForSlice(slug, sliceIdx).length;
  return {
    measurements,
    angles,
    rois,
    notes,
    total: measurements + angles + rois + notes,
  };
}

// Shape: [{ kind: "line", id: "measure:brain_ax|12:0", sliceIdx: 12, data: {...} }].
export function drawingEntriesForSeries(host, slug) {
  const out = [];
  const seen = new Set();
  const pushUnique = (entry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };
  const measurementBucket = readBucket(MEASUREMENT_STORAGE_KEY);
  for (const key of Object.keys(measurementBucket || {})) {
    if (!key.startsWith(`${slug}|`)) continue;
    const sliceIdx = Number(key.split('|')[1] || 0);
    for (const entry of measurementBucket[key] || []) {
      pushUnique({
        kind: 'line',
        id: entryId('measure', slug, sliceIdx, entry, 0),
        sliceIdx,
        data: entry,
      });
    }
  }
  for (const key of Object.keys(host.measurements || {})) {
    if (!key.startsWith(`${slug}|`)) continue;
    const sliceIdx = Number(key.split('|')[1] || 0);
    for (const [index, entry] of (host.measurements[key] || []).entries()) {
      pushUnique({ kind: 'line', id: entryId('measure', slug, sliceIdx, entry, index), sliceIdx, data: entry });
    }
  }
  const angleBucket = readBucket(ANGLE_STORAGE_KEY);
  for (const key of Object.keys(angleBucket || {})) {
    if (!key.startsWith(`${slug}|`)) continue;
    const sliceIdx = Number(key.split('|')[1] || 0);
    for (const entry of angleBucket[key] || []) {
      pushUnique({ kind: 'angle', id: entryId('angle', slug, sliceIdx, entry, 0), sliceIdx, data: entry });
    }
  }
  for (const key of Object.keys(host.angleMeasurements || {})) {
    if (!key.startsWith(`${slug}|`)) continue;
    const sliceIdx = Number(key.split('|')[1] || 0);
    for (const [index, entry] of (host.angleMeasurements[key] || []).entries()) {
      pushUnique({ kind: 'angle', id: entryId('angle', slug, sliceIdx, entry, index), sliceIdx, data: entry });
    }
  }
  pushSeriesEntries(out, slug, readBucket(ROI_STORAGE_KEY), 'roi', (entry, sliceIdx) => ({
    kind: entry.shape === 'ellipse' ? 'ellipse' : 'polygon',
    id: `roi:${slug}|${sliceIdx}:${entry.id ?? 0}`,
    sliceIdx,
    data: entry,
  }));
  pushSeriesEntries(out, slug, readBucket(NOTE_STORAGE_KEY), 'note', (entry, sliceIdx) => ({
    kind: 'note',
    id: `note:${slug}|${sliceIdx}:${entry.id ?? 0}`,
    sliceIdx,
    data: entry,
  }));
  return out.sort((a, b) => a.sliceIdx - b.sliceIdx);
}

export function measurementEntriesForSlice(host, slug, sliceIdx) {
  return listForSlice(host?.measurements, MEASUREMENT_STORAGE_KEY, slug, sliceIdx);
}

export function setMeasurementEntriesForSlice(host, slug, sliceIdx, list) {
  const next = writeSliceBucket(MEASUREMENT_STORAGE_KEY, slug, sliceIdx, list);
  if (host?.measurements) {
    const key = sliceKey(slug, sliceIdx);
    if (Array.isArray(next) && next.length) host.measurements[key] = next.map((entry) => ({ ...entry }));
    else delete host.measurements[key];
  }
  return next;
}

export function angleEntriesForSlice(host, slug, sliceIdx) {
  return listForSlice(host?.angleMeasurements, ANGLE_STORAGE_KEY, slug, sliceIdx);
}

export function setAngleEntriesForSlice(host, slug, sliceIdx, list) {
  const next = writeSliceBucket(ANGLE_STORAGE_KEY, slug, sliceIdx, list);
  if (host?.angleMeasurements) {
    const key = sliceKey(slug, sliceIdx);
    if (Array.isArray(next) && next.length) host.angleMeasurements[key] = next.map((entry) => ({ ...entry }));
    else delete host.angleMeasurements[key];
  }
  return next;
}

export function roiEntriesForSlice(slug, sliceIdx) {
  return readSliceBucket(ROI_STORAGE_KEY, slug, sliceIdx);
}

export function setRoiEntriesForSlice(slug, sliceIdx, list) {
  return writeSliceBucket(ROI_STORAGE_KEY, slug, sliceIdx, list);
}

export function noteEntriesForSlice(slug, sliceIdx) {
  return readSliceBucket(NOTE_STORAGE_KEY, slug, sliceIdx);
}

export function setNoteEntriesForSlice(slug, sliceIdx, list) {
  return writeSliceBucket(NOTE_STORAGE_KEY, slug, sliceIdx, list);
}

export function nextDrawingEntryId(list) {
  return (list.reduce((max, entry) => Math.max(max, Number(entry?.id || 0)), 0) || 0) + 1;
}

export function deleteDrawingEntryById(list, id) {
  return (list || []).filter((entry) => Number(entry?.id || 0) !== Number(id));
}

export function annotatedSlicesForSeries(slug) {
  const all = readBucket(NOTE_STORAGE_KEY);
  const out = new Set();
  for (const key of Object.keys(all)) {
    if (!key.startsWith(`${slug}|`) || !(all[key] || []).length) continue;
    out.add(Number(key.split('|')[1] || 0));
  }
  return out;
}

export function clearDrawingEntriesForSlice(host, slug, sliceIdx) {
  const key = sliceKey(slug, sliceIdx);
  delete host.measurements[key];
  delete host.angleMeasurements?.[key];
  setMeasurementEntriesForSlice(host, slug, sliceIdx, []);
  setAngleEntriesForSlice(host, slug, sliceIdx, []);
  setRoiEntriesForSlice(slug, sliceIdx, []);
  setNoteEntriesForSlice(slug, sliceIdx, []);
}
