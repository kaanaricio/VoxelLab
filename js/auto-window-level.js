// Auto window/level from current slice histogram (mean ± spread of non-background).
import { state } from './state.js';
import { setWindowLevel } from './state/viewer-commands.js';

export function autoWindowLevel() {
  if (!state.loaded) return;
  const series = state.manifest.series[state.seriesIdx];
  const img = state.imgs[state.sliceIdx];
  if (!img || !img.complete) return;
  if (!autoWindowLevel._c) autoWindowLevel._c = document.createElement('canvas');
  const c = autoWindowLevel._c;
  c.width = series.width;
  c.height = series.height;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const data = cx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let p = 0; p < data.length; p += 4) {
    const v = data[p];
    if (v < 8) continue;
    sum += v;
    sum2 += v * v;
    n++;
  }
  if (n < 100) return;
  const mean = sum / n;
  const variance = Math.max(1, sum2 / n - mean * mean);
  const std = Math.sqrt(variance);
  setWindowLevel(
    Math.round(Math.max(16, Math.min(512, std * 3))),
    Math.round(Math.max(0, Math.min(255, mean))),
  );
}
