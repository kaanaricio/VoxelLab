// Sparkline (per-slice symmetry bar chart) + histogram (intensity
// distribution for the current slice). Both live in the bottom bar
// under the main canvas. They read from state.stats and state.imgs
// and don't write to anything — pure renderers.

import { $ } from './dom.js';
import { state } from './state.js';

function barColor(alpha) {
  const isLight = document.documentElement.classList.contains('light');
  return isLight ? `rgba(0, 0, 0, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;
}

function panelBackgroundColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
  return v || '#111111';
}

/** W/L band + edges: slightly stronger tint in light mode so it reads on --panel */
function histogramBandFill(isLight) {
  return isLight ? 'rgba(0, 0, 0, 0.07)' : 'rgba(255, 255, 255, 0.08)';
}
function histogramBandStroke(isLight) {
  return isLight ? 'rgba(0, 0, 0, 0.32)' : 'rgba(255, 255, 255, 0.35)';
}

// Slice indices with annotations for the active series — from
// annotation.js via viewer's initSparkline(getAnnotatedSlices).
let getAnnotatedSlices = () => new Set();

export function initSparkline(hook) {
  if (typeof hook === 'function') getAnnotatedSlices = hook;
}

// Shape: persistent offscreen sparkline base, e.g. 640x44 px at DPR=2.
let _sparkBase = null;
// Shape: cached static sparkline inputs used to decide rebuild.
const _sparkCache = {
  w: 0,
  h: 22,
  dpr: 0,
  n: 0,
  scoresRef: null,
  maxV: 1,
  annotKey: '',
  theme: '',
};

function annotationKey(set) {
  if (!set || set.size === 0) return '';
  const vals = Array.from(set).sort((a, b) => a - b);
  return vals.join(',');
}

// Tiny bar chart under the scrubber showing per-slice asymmetry from
// detect.py. Tall bars = slices where the brain differs most left-vs-
// right. Clicking jumps to that slice (handler wired in viewer.js).
export function drawSparkline() {
  const c = $('sparkline');
  if (!c) return;

  // Hide entirely when there's no data to show
  const scores = state.stats?.symmetryScores;
  const hasData = scores && scores.length > 0;
  c.hidden = !hasData;
  if (!hasData) return;

  const n = scores.length;

  // Resize to device pixels for sharp rendering
  const w = c.clientWidth || c.parentElement.clientWidth || 400;
  const h = 22;
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.max(1, Math.round(w * dpr));
  const pxH = Math.max(1, Math.round(h * dpr));
  if (c.width !== pxW || c.height !== pxH) {
    c.width = pxW;
    c.height = pxH;
  }
  if (c.style.height !== h + 'px') c.style.height = h + 'px';
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const annotated = getAnnotatedSlices();
  const annotKey = annotationKey(annotated);

  const currentTheme = document.documentElement.classList.contains('light') ? 'light' : 'dark';
  const needsBaseRebuild =
    !_sparkBase ||
    _sparkCache.w !== w ||
    _sparkCache.h !== h ||
    _sparkCache.dpr !== dpr ||
    _sparkCache.scoresRef !== scores ||
    _sparkCache.n !== n ||
    _sparkCache.annotKey !== annotKey ||
    _sparkCache.theme !== currentTheme;

  if (needsBaseRebuild) {
    let maxV = 1;
    for (let i = 0; i < n; i++) if (scores[i] > maxV) maxV = scores[i];

    if (!_sparkBase) _sparkBase = document.createElement('canvas');
    _sparkBase.width = pxW;
    _sparkBase.height = pxH;
    const bctx = _sparkBase.getContext('2d');
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, w, h);

    const barW = w / n;
    for (let i = 0; i < n; i++) {
      const v = scores[i] / maxV;
      const bh = v * (h - 2);
      bctx.fillStyle = barColor(0.18 + v * 0.5);
      bctx.fillRect(i * barW + 0.5, h - 1 - bh, Math.max(1, barW - 1), bh);
    }

    bctx.fillStyle = barColor(0.85);
    annotated.forEach((z) => {
      const x = (z + 0.5) * barW;
      bctx.beginPath();
      bctx.arc(x, 3, 2, 0, Math.PI * 2);
      bctx.fill();
    });

    _sparkCache.w = w;
    _sparkCache.h = h;
    _sparkCache.dpr = dpr;
    _sparkCache.n = n;
    _sparkCache.scoresRef = scores;
    _sparkCache.maxV = maxV;
    _sparkCache.annotKey = annotKey;
    _sparkCache.theme = currentTheme;
  }

  ctx.drawImage(_sparkBase, 0, 0, w, h);

  const maxV = _sparkCache.maxV || 1;
  const barW = w / n;
  const idx = state.sliceIdx | 0;
  if (idx >= 0 && idx < n) {
    const v = scores[idx] / maxV;
    const bh = v * (h - 2);
    ctx.fillStyle = barColor(0.9);
    ctx.fillRect(idx * barW + 0.5, h - 1 - bh, Math.max(1, barW - 1), bh);
  }

  // Current slice marker (vertical line)
  ctx.strokeStyle = barColor(0.45);
  ctx.lineWidth = 1;
  ctx.beginPath();
  const cx = Math.max(0, Math.min(w - 1, (state.sliceIdx + 0.5) * barW));
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, h);
  ctx.stroke();
}

// Per-slice intensity histogram with the current window/level band
// overlaid. Only renders in 2D mode. Re-uses a scratch canvas (stored
// as a module-level field) to avoid allocating per frame.
let _scratch = null;
const _histCache = { seriesIdx: -1, sliceIdx: -1, bins: null, max: 0 };

/** Returns true when the histogram canvas should be drawn; updates empty placeholder otherwise. */
export function syncHistogramPanel() {
  const c = $('histogram');
  const block = $('histogram-block');
  const emptyEl = $('histogram-empty');
  const hintEl = $('histogram-empty-hint');
  const titleEl = $('histogram-empty-title');
  if (!c || !block || !emptyEl) return false;

  const series = state.manifest?.series[state.seriesIdx];
  const setEmpty = (title, hint) => {
    block.classList.add('histogram-block--empty');
    emptyEl.hidden = false;
    if (titleEl) titleEl.textContent = title;
    if (hintEl) hintEl.textContent = hint;
  };

  // Hide the whole block in non-2D modes — the histogram is single-slice only,
  // and MPR / 3D / compare already show their own spatial context, so a "switch
  // back to 2D" placeholder inside Metadata reads as noise rather than guidance.
  if (state.mode !== '2d') {
    block.hidden = true;
    return false;
  }
  block.hidden = false;

  if (!series) {
    setEmpty('Slice histogram', 'Open 2D slice view to see intensity distribution for the current slice.');
    return false;
  }

  const img = state.imgs[state.sliceIdx];
  if (!img || !img.complete) {
    setEmpty('Slice histogram', 'Waiting for the slice image…');
    return false;
  }

  block.classList.remove('histogram-block--empty');
  emptyEl.hidden = true;
  return true;
}

export function drawHistogram() {
  const c = $('histogram');
  if (!c || !syncHistogramPanel()) return;
  const series = state.manifest.series[state.seriesIdx];
  const img = state.imgs[state.sliceIdx];

  let bins, max;
  const cacheHit =
    _histCache.bins &&
    _histCache.seriesIdx === state.seriesIdx &&
    _histCache.sliceIdx === state.sliceIdx;

  if (cacheHit) {
    bins = _histCache.bins;
    max = _histCache.max;
  } else {
    if (!_scratch) _scratch = document.createElement('canvas');
    _scratch.width = series.width;
    _scratch.height = series.height;
    const sx = _scratch.getContext('2d', { willReadFrequently: true });
    sx.drawImage(img, 0, 0);
    const data = sx.getImageData(0, 0, series.width, series.height).data;

    bins = new Uint32Array(256);
    for (let p = 0; p < data.length; p += 4) {
      const v = data[p];
      if (v < 4) continue;  // skip pure background so it doesn't dominate
      bins[v]++;
    }
    max = 0;
    for (let i = 0; i < 256; i++) if (bins[i] > max) max = bins[i];

    _histCache.seriesIdx = state.seriesIdx;
    _histCache.sliceIdx = state.sliceIdx;
    _histCache.bins = bins;
    _histCache.max = max;
  }

  const w = c.clientWidth || 240;
  const h = 52;
  const dpr = window.devicePixelRatio || 1;
  c.width = w * dpr;
  c.height = h * dpr;
  c.style.height = h + 'px';
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const isLight = document.documentElement.classList.contains('light');
  ctx.fillStyle = panelBackgroundColor();
  ctx.fillRect(0, 0, w, h);

  // Histogram bars — neutral gray
  const binW = w / 256;
  ctx.fillStyle = barColor(isLight ? 0.52 : 0.6);
  for (let i = 0; i < 256; i++) {
    if (bins[i] === 0) continue;
    // log scale so tails are visible
    const bh = (Math.log(1 + bins[i]) / Math.log(1 + max)) * h;
    ctx.fillRect(i * binW, h - bh, Math.max(1, binW), bh);
  }

  // Window/level band — theme-aware overlay on --panel fill
  const lo = state.level - state.window / 2;
  const hi = state.level + state.window / 2;
  ctx.fillStyle = histogramBandFill(isLight);
  ctx.fillRect(lo * binW, 0, Math.max(1, (hi - lo) * binW), h);
  ctx.strokeStyle = histogramBandStroke(isLight);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(lo * binW, 0); ctx.lineTo(lo * binW, h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(hi * binW, 0); ctx.lineTo(hi * binW, h); ctx.stroke();
}
