import { state } from '../state.js';

export function getManifest() {
  return state.manifest;
}

export function getCurrentSeries(seriesIdx = state.seriesIdx) {
  return state.manifest?.series?.[seriesIdx] || null;
}

export function clampSliceIndex(next, series = getCurrentSeries()) {
  if (!series) return 0;
  return Math.max(0, Math.min(series.slices - 1, next));
}

export function currentSeriesSlug(seriesIdx = state.seriesIdx) {
  return getCurrentSeries(seriesIdx)?.slug || '';
}
