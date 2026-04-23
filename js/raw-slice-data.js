import { state } from './state.js';

const cache = {
  canvas: null,
  data: null,
  seriesIdx: -1,
  sliceIdx: -1,
};

export function getRawSliceData(sliceIdx = state.sliceIdx, series = state.manifest?.series?.[state.seriesIdx]) {
  if (!series || !state.imgs?.[sliceIdx]?.complete) return null;
  if (!cache.canvas) cache.canvas = document.createElement('canvas');
  if (cache.seriesIdx === state.seriesIdx && cache.sliceIdx === sliceIdx && cache.data) return cache.data;

  const canvas = cache.canvas;
  canvas.width = series.width;
  canvas.height = series.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, series.width, series.height);
  ctx.drawImage(state.imgs[sliceIdx], 0, 0, series.width, series.height);
  try {
    cache.data = ctx.getImageData(0, 0, series.width, series.height).data;
    cache.seriesIdx = state.seriesIdx;
    cache.sliceIdx = sliceIdx;
    return cache.data;
  } catch {
    return null;
  }
}
