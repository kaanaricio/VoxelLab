import { batch, state } from '../state.js';
import {
  angleEntriesForSlice,
  deleteDrawingEntryById,
  measurementEntriesForSlice,
  nextDrawingEntryId,
  setAngleEntriesForSlice,
  setMeasurementEntriesForSlice,
} from '../annotation-graph.js';

function parseSliceKey(key) {
  const [slug = '', slicePart = '0'] = String(key || '').split('|');
  return { slug, sliceIdx: Number(slicePart || 0) };
}

export function setMeasureMode(enabled) {
  batch(() => {
    state.measureMode = !!enabled;
    state.measurePending = null;
  });
  return state.measureMode;
}

export function setMeasurePending(point) {
  state.measurePending = point ? { ...point } : null;
  return state.measurePending;
}

export function appendMeasurement(key, measurement) {
  const { slug, sliceIdx } = parseSliceKey(key);
  const list = measurementEntriesForSlice(state, slug, sliceIdx);
  // Shape: { id: 3, x1: 10, y1: 20, x2: 40, y2: 20, mm: 12.4 }.
  const { _new, ...persisted } = measurement || {};
  const next = [...list, { ...persisted, id: persisted?.id ?? nextDrawingEntryId(list) }];
  return setMeasurementEntriesForSlice(state, slug, sliceIdx, next);
}

export function deleteMeasurementAt(key, measurement) {
  const { slug, sliceIdx } = parseSliceKey(key);
  const list = measurementEntriesForSlice(state, slug, sliceIdx);
  const next = measurement?.id != null
    ? deleteDrawingEntryById(list, measurement.id)
    : list.filter((entry) => entry !== measurement);
  setMeasurementEntriesForSlice(state, slug, sliceIdx, next);
}

export function setAngleMode(enabled) {
  batch(() => {
    state.angleMode = !!enabled;
    state.anglePending = null;
  });
  return state.angleMode;
}

export function setAnglePending(points) {
  state.anglePending = Array.isArray(points) ? points.map((point) => ({ ...point })) : null;
  return state.anglePending;
}

export function appendAngleMeasurement(key, measurement) {
  const { slug, sliceIdx } = parseSliceKey(key);
  const list = angleEntriesForSlice(state, slug, sliceIdx);
  // Shape: { id: 2, p1: {x,y}, vertex: {x,y}, p3: {x,y}, deg: 42.1 }.
  const next = [...list, { ...measurement, id: measurement?.id ?? nextDrawingEntryId(list) }];
  return setAngleEntriesForSlice(state, slug, sliceIdx, next);
}

export function deleteAngleMeasurementAt(key, measurement) {
  const { slug, sliceIdx } = parseSliceKey(key);
  const list = angleEntriesForSlice(state, slug, sliceIdx);
  const next = measurement?.id != null
    ? deleteDrawingEntryById(list, measurement.id)
    : list.filter((entry) => entry !== measurement);
  setAngleEntriesForSlice(state, slug, sliceIdx, next);
}

export function setAnnotateMode(enabled) {
  batch(() => {
    state.annotateMode = !!enabled;
    state.annotationEdit = null;
  });
  return state.annotateMode;
}

export function setAskMode(enabled) {
  batch(() => {
    state.askMode = !!enabled;
    if (!enabled) state.askMarquee = null;
  });
  return state.askMode;
}

export function setAskMarquee(marquee) {
  state.askMarquee = marquee ? { ...marquee } : null;
  return state.askMarquee;
}

export function setAskHistory(entries) {
  state.askHistory = Array.isArray(entries) ? entries : [];
  return state.askHistory;
}

export function setHiddenLabels(hidden) {
  state.hiddenLabels = hidden instanceof Set ? new Set(hidden) : new Set(hidden || []);
  return state.hiddenLabels;
}
