// Compare mode — renders every series in the same DICOM registration
// group side-by-side at the shared slice index.
//
// Compare cells still render peer-specific overlays, but primary-series
// changes now flow through the canonical selectSeries() path so cache
// resets and redraw state stay consistent.

import { $, escapeHtml } from './dom.js';
import { deletePassthroughRootEntry, setPassthroughRootEntry, state } from './state.js';
import { drawAnnotationPins } from './annotation.js';
import { loadImageStack, regionMetaUrlForSeries } from './series-image-stack.js';
import { cachedFetchJson } from './cached-fetch.js';
import {
  closestSliceIndexForPatientPoint,
  inPlaneDisplaySize,
  patientPointAtSlice,
  seriesCompareGroup,
} from './geometry.js';
import { readImageByteData } from './overlay-data.js';
import { COLORMAPS, getFusedWLLut, getFusedWLU32 } from './colormap.js';
import { softFail } from './error.js';
import { renderInspectionReadout, resolveVoxelInspection } from './inspection-readout.js';
import { drawCompositeSlice } from './slice-compositor.js';
import { activeOverlayStateForSeries } from './runtime/active-overlay-state.js';
import { isRenderableImage, overlaySessionForSeries } from './runtime/review-readiness.js';
import { resetCompareViewport, setCompareViewport, setWindowLevel } from './state/viewer-commands.js';
import { setSpinnerPending } from './spinner.js';

let _selectSeries = () => {};
let _step = () => {};
let _hideHover = () => {};
const SLICE_WINDOW_RADIUS = 5;
let _comparePendingToken = 0;
let _comparePendingKey = '';
let _comparePendingPromise = null;

// Shape: { "series_slug": { seg: Image[], sym: Image[], regions: Image[], regionMeta: object|null } }.
const peerOverlays = {};

function compareViewport() {
  return state.compare?.viewport || { zoom: 1, tx: 0, ty: 0 };
}

function applyCompareViewport(host = $('cmp-grid')) {
  const view = compareViewport();
  host?.querySelectorAll?.('.cmp-cell canvas').forEach((canvas) => {
    canvas.style.transformOrigin = '50% 50%';
    canvas.style.transform = `translate(${view.tx || 0}px, ${view.ty || 0}px) scale(${view.zoom || 1})`;
  });
}

function showCompareHover(cell, clientX, clientY) {
  const slug = cell?.dataset?.slug || '';
  const series = state.manifest.series.find((entry) => entry.slug === slug);
  if (!series) { _hideHover(); return; }
  const primary = state.manifest.series[state.seriesIdx];
  const match = closestSliceIndexForPatientPoint(series, patientPointAtSlice(primary, state.sliceIdx));
  if (match.outOfRange) { _hideHover(); return; }
  const stack = state.cmpStacks[slug];
  const zi = match.index;
  const img = stack?.[zi];
  if (!img?.complete || img.naturalWidth === 0) { _hideHover(); return; }
  const canvas = cell.querySelector('canvas');
  const rect = canvas?.getBoundingClientRect?.();
  if (!canvas || !rect) { _hideHover(); return; }
  const vx = Math.floor((clientX - rect.left) / rect.width * canvas.width);
  const vy = Math.floor((clientY - rect.top) / rect.height * canvas.height);
  if (vx < 0 || vx >= series.width || vy < 0 || vy >= series.height) { _hideHover(); return; }

  const baseBytes = readImageByteData(img, series.width, series.height);
  if (!baseBytes) { _hideHover(); return; }
  const po = peerOverlays[slug] || {};
  const overlays = activeOverlayStateForSeries(series);
  const segLabel = overlays.tissue.enabled && po.seg?.[zi]?.complete
    ? readImageByteData(po.seg[zi], series.width, series.height)?.[vy * series.width + vx] ?? null
    : null;
  const regionLabel = overlays.labels.enabled && po.regions?.[zi]?.complete
    ? readImageByteData(po.regions[zi], series.width, series.height)?.[vy * series.width + vx] ?? null
    : null;
  const inspection = resolveVoxelInspection(series, vx, vy, zi, {
    intensity: baseBytes[vy * series.width + vx],
    tissueLabel: segLabel,
    regionLabel,
    regionMeta: po.regionMeta || null,
    useLiveOverlays: false,
  });

  const hov = $('hover-readout');
  hov.innerHTML = renderInspectionReadout(inspection, { coordLabel: 'px', includeSlice: true });
  hov.classList.add('visible');
  const wrap = $('canvas-wrap').getBoundingClientRect();
  let x = clientX - wrap.left + 14;
  let y = clientY - wrap.top + 14;
  const hw = hov.offsetWidth;
  const hh = hov.offsetHeight;
  if (x + hw > wrap.width - 8) x = clientX - wrap.left - hw - 10;
  if (y + hh > wrap.height - 8) y = clientY - wrap.top - hh - 10;
  hov.style.left = `${x}px`;
  hov.style.top = `${y}px`;
}

function wireCompareInteractions() {
  const host = $('cmp-grid');
  if (!host || host._compareWired) return;
  host._compareWired = true;
  let dragging = false;
  let panning = false;
  let lastX = 0;
  let lastY = 0;
  let pendingWindow = state.window;
  let pendingLevel = state.level;
  let wlFramePending = false;

  host.addEventListener('wheel', (e) => {
    if (state.mode !== 'cmp') return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const view = compareViewport();
      const rect = host.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const oldZoom = view.zoom || 1;
      const newZoom = Math.max(1, Math.min(8, oldZoom * factor));
      if (newZoom === oldZoom) return;
      setCompareViewport({
        zoom: newZoom,
        tx: cx - (cx - (view.tx || 0)) * (newZoom / oldZoom),
        ty: cy - (cy - (view.ty || 0)) * (newZoom / oldZoom),
      });
      applyCompareViewport(host);
      return;
    }
    _step(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  host.addEventListener('mousedown', (e) => {
    if (state.mode !== 'cmp') return;
    lastX = e.clientX;
    lastY = e.clientY;
    const view = compareViewport();
    const wantsPan = e.metaKey || e.ctrlKey || (view.zoom || 1) > 1.01;
    if (wantsPan) {
      panning = true;
      host.classList.add('panning');
      e.preventDefault();
      return;
    }
    dragging = true;
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    if (panning) {
      panning = false;
      host.classList.remove('panning');
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (state.mode !== 'cmp') return;
    if (dragging) {
      pendingWindow = Math.max(1, Math.min(512, pendingWindow + (e.clientX - lastX)));
      pendingLevel = Math.max(0, Math.min(255, pendingLevel - (e.clientY - lastY)));
      lastX = e.clientX;
      lastY = e.clientY;
      if (!wlFramePending) {
        wlFramePending = true;
        requestAnimationFrame(() => {
          wlFramePending = false;
          setWindowLevel(pendingWindow, pendingLevel);
        });
      }
    } else if (panning) {
      const view = compareViewport();
      setCompareViewport({
        zoom: view.zoom,
        tx: (view.tx || 0) + (e.clientX - lastX),
        ty: (view.ty || 0) + (e.clientY - lastY),
      });
      lastX = e.clientX;
      lastY = e.clientY;
      applyCompareViewport(host);
    }
  });

  host.addEventListener('dblclick', () => {
    resetCompareViewport();
    applyCompareViewport(host);
    _hideHover();
  });
  host.addEventListener('mousemove', (e) => {
    if (state.mode !== 'cmp' || dragging || panning) {
      _hideHover();
      return;
    }
    const cell = e.target?.closest?.('.cmp-cell');
    if (!cell) {
      _hideHover();
      return;
    }
    showCompareHover(cell, e.clientX, e.clientY);
  });
  host.addEventListener('mouseleave', () => _hideHover());
}

export function trimCompareCaches(keepSlugs = []) {
  const keep = new Set(keepSlugs);
  for (const slug of Object.keys(state.cmpStacks)) {
    if (!keep.has(slug)) deletePassthroughRootEntry('cmpStacks', slug);
  }
  for (const slug of Object.keys(peerOverlays)) {
    if (!keep.has(slug)) delete peerOverlays[slug];
  }
}

export function initCompare({ selectSeries, step = () => {}, hideHover = () => {} }) {
  if (typeof selectSeries === 'function') _selectSeries = selectSeries;
  if (typeof step === 'function') _step = step;
  if (typeof hideHover === 'function') _hideHover = hideHover;
  wireCompareInteractions();
}

function compareSpinner(pending, token = _comparePendingToken) {
  if (token !== _comparePendingToken) return;
  setSpinnerPending('compare', !!pending);
  const scrub = $('scrub');
  if (scrub) scrub.disabled = !!pending;
  const zScrub = $('s-zscrub');
  if (zScrub) zScrub.disabled = !!pending;
}

function stackImageReady(stack, index) {
  return isRenderableImage(stack?.[index]);
}

// Shape: { "peer_slug": { index: 17, outOfRange: false, distanceMm: 0.2, toleranceMm: 0.5 } }.
function compareSliceMatches(peers, primarySeries, z) {
  const point = patientPointAtSlice(primarySeries, z);
  return Object.fromEntries(peers.map((peer) => [peer.slug, closestSliceIndexForPatientPoint(peer, point)]));
}

function comparePendingKey(peers, z, matches = {}) {
  return [
    z,
    state.useBrain ? 'brain' : 'base',
    state.useSeg ? 'seg' : '',
    state.useRegions ? 'regions' : '',
    state.useSym ? 'sym' : '',
    state.fusionSlug || '',
    state.manifest.series[state.seriesIdx]?.slug || '',
    ...peers.map((peer) => {
      const match = matches[peer.slug];
      return `${peer.slug}:${match?.index ?? 0}:${match?.outOfRange ? 'x' : ''}`;
    }),
  ].join('|');
}

function ensureCompareCurrentSlice(peers, z, primarySlug, matches = {}) {
  const tasks = [];
  for (const series of peers) {
    const match = matches[series.slug];
    if (match?.outOfRange) continue;
    const zi = match?.index ?? Math.min(z, series.slices - 1);
    const overlays = activeOverlayStateForSeries(series);
    const po = peerOverlays[series.slug] || {};
    const overlaySession = overlaySessionForSeries(series, {
      sliceIdx: zi,
      overlays,
      stacks: {
        tissue: po.seg,
        heatmap: po.sym,
        labels: po.regions,
        fusion: series.slug === primarySlug && overlays.fusion.enabled
          ? (state.cmpStacks[state.fusionSlug] || overlays.fusion.imgs)
          : null,
      },
    });
    const stack = state.cmpStacks[series.slug];
    if (stack?.ensureIndex && !stackImageReady(stack, zi)) {
      tasks.push(stack.ensureIndex(zi, { priority: 'high' }));
    }
    if (overlaySession.tissue.enabled && !overlaySession.tissue.currentSliceReady && po.seg?.ensureIndex) {
      tasks.push(po.seg.ensureIndex(zi, { priority: 'high' }));
    }
    if (overlaySession.heatmap.enabled && !overlaySession.heatmap.currentSliceReady && po.sym?.ensureIndex) {
      tasks.push(po.sym.ensureIndex(zi, { priority: 'high' }));
    }
    if (overlaySession.labels.enabled) {
      if (!overlaySession.labels.currentSliceReady && po.regions?.ensureIndex) {
        tasks.push(po.regions.ensureIndex(zi, { priority: 'high' }));
      }
      if (!overlaySession.labels.metaReady && !po.regionMeta) {
        tasks.push(
          softFail(
            cachedFetchJson(regionMetaUrlForSeries(series)).then((data) => { if (data) po.regionMeta = data; }),
            `${series.slug} compare anatomy metadata`,
          ),
        );
      }
    }
    const fusionStack = series.slug === primarySlug && overlays.fusion.enabled
      ? (state.cmpStacks[state.fusionSlug] || overlays.fusion.imgs)
      : null;
    if (overlaySession.fusion.enabled && !overlaySession.fusion.currentSliceReady && fusionStack?.ensureIndex) {
      tasks.push(fusionStack.ensureIndex(zi, { priority: 'high' }));
    }
  }
  if (!tasks.length) return null;
  const key = comparePendingKey(peers, z, matches);
  if (_comparePendingPromise && _comparePendingKey === key) return _comparePendingPromise;
  const token = ++_comparePendingToken;
  _comparePendingKey = key;
  compareSpinner(true, token);
  _comparePendingPromise = Promise.all(tasks)
    .then(() => {
      if (token !== _comparePendingToken) return false;
      if (state.mode === 'cmp' && state.sliceIdx === z) drawCompare();
      return true;
    })
    .finally(() => {
      if (token !== _comparePendingToken) return;
      _comparePendingPromise = null;
      _comparePendingKey = '';
      compareSpinner(false, token);
    });
  return _comparePendingPromise;
}

function resolvedCompareGroup(series) {
  return seriesCompareGroup(series) ?? series?.group ?? null;
}

export function getGroupPeers() {
  const series = state.manifest.series;
  // Manual selection overrides auto-grouping
  const manual = state.cmpManualSlugs;
  if (manual && manual.length >= 2) {
    const set = new Set(manual);
    return series.filter((s) => set.has(s.slug));
  }
  const cur = series[state.seriesIdx];
  const group = resolvedCompareGroup(cur);
  if (group === undefined || group === null) return [];
  return series.filter((item) => resolvedCompareGroup(item) === group);
}

/** Build checkbox menu items inside the compare dropdown. */
export function buildCompareMenu(menuEl) {
  menuEl.innerHTML = '';
  const series = state.manifest.series;
  if (series.length < 2) return;
  // Which slugs are currently selected (manual or auto-group)
  const peers = getGroupPeers();
  const activeSlugs = new Set(peers.map((p) => p.slug));

  for (const s of series) {
    const item = document.createElement('label');
    item.className = 'dd-item cmp-pick ui-checkbox';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'ui-checkbox-input';
    cb.value = s.slug;
    cb.checked = activeSlugs.has(s.slug);
    const box = document.createElement('span');
    box.className = 'ui-checkbox-box';
    box.setAttribute('aria-hidden', 'true');
    const toggle = document.createElement('span');
    toggle.className = 'ui-checkbox-toggle';
    toggle.appendChild(cb);
    toggle.appendChild(box);
    const span = document.createElement('span');
    span.textContent = s.name;
    item.appendChild(toggle);
    item.appendChild(span);
    item.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => applyMenuSelection(menuEl));
    menuEl.appendChild(item);
  }
}

/** Read checked state from the menu and update cmpManualSlugs. */
function applyMenuSelection(menuEl) {
  const checked = [...menuEl.querySelectorAll('input:checked')].map((cb) => cb.value);
  state.cmpManualSlugs = checked.length >= 2 ? checked : null;
  // If already in compare mode, refresh the grid live
  if (state.mode === 'cmp') {
    buildCompareGrid();
    loadComparePeers().then(() => drawCompare());
  }
}

export async function loadComparePeers() {
  const peers = getGroupPeers();
  trimCompareCaches(peers.map(peer => peer.slug));
  const currentIndex = state.sliceIdx;
  const primarySeries = state.manifest.series[state.seriesIdx];
  const matches = compareSliceMatches(peers, primarySeries, currentIndex);
  const currentLoaders = [];
  const backgroundLoaders = [];
  for (const p of peers) {
    const overlays = activeOverlayStateForSeries(p);
    const variant = state.useBrain && p.hasBrain ? `${p.slug}_brain` : p.slug;
    const match = matches[p.slug];
    const initialIndex = match?.index ?? Math.min(currentIndex, p.slices - 1);
    const base = loadImageStack(variant, p.slices, state.cmpStacks[p.slug], p, {
      label: `${p.slug} compare stack`,
      windowRadius: SLICE_WINDOW_RADIUS,
      initialIndex,
    });
    setPassthroughRootEntry('cmpStacks', p.slug, base.imgs);
    if (!match?.outOfRange) currentLoaders.push(base.imgs.ensureIndex?.(initialIndex) || Promise.resolve(true));
    backgroundLoaders.push(...base.loaders);

    if (!peerOverlays[p.slug]) peerOverlays[p.slug] = {};
    const po = peerOverlays[p.slug];

    if (overlays.tissue.enabled) {
      const seg = loadImageStack(`${p.slug}_seg`, p.slices, po.seg, p, {
        label: `${p.slug} compare tissue overlay`,
        windowRadius: SLICE_WINDOW_RADIUS,
        initialIndex,
      });
      po.seg = seg.imgs;
      if (!match?.outOfRange) currentLoaders.push(seg.imgs.ensureIndex?.(initialIndex) || Promise.resolve(true));
      backgroundLoaders.push(...seg.loaders);
    }

    if (overlays.heatmap.enabled) {
      const sym = loadImageStack(`${p.slug}_sym`, p.slices, po.sym, p, {
        label: `${p.slug} compare symmetry overlay`,
        windowRadius: SLICE_WINDOW_RADIUS,
        initialIndex,
      });
      po.sym = sym.imgs;
      if (!match?.outOfRange) currentLoaders.push(sym.imgs.ensureIndex?.(initialIndex) || Promise.resolve(true));
      backgroundLoaders.push(...sym.loaders);
    }

    if (overlays.labels.enabled) {
      const regions = loadImageStack(`${p.slug}_regions`, p.slices, po.regions, p, {
        label: `${p.slug} compare anatomy overlay`,
        windowRadius: SLICE_WINDOW_RADIUS,
        initialIndex,
      });
      po.regions = regions.imgs;
      if (!match?.outOfRange) currentLoaders.push(regions.imgs.ensureIndex?.(initialIndex) || Promise.resolve(true));
      backgroundLoaders.push(...regions.loaders);
      if (!po.regionMeta) {
        currentLoaders.push(
          softFail(
            cachedFetchJson(regionMetaUrlForSeries(p)).then((d) => { if (d) po.regionMeta = d; }),
            `${p.slug} compare anatomy metadata`,
          ),
        );
      }
    }
  }
  Promise.all(backgroundLoaders).then(() => {
    if (state.mode === 'cmp') drawCompare();
  });
  if (!currentLoaders.length) return;
  const token = ++_comparePendingToken;
  _comparePendingKey = comparePendingKey(peers, currentIndex, matches);
  compareSpinner(true, token);
  try {
    await Promise.all(currentLoaders);
  } finally {
    if (token === _comparePendingToken) {
      _comparePendingKey = '';
      _comparePendingPromise = null;
      compareSpinner(false, token);
    }
  }
}

export function buildCompareGrid() {
  const host = $('cmp-grid');
  host.innerHTML = '';
  const peers = getGroupPeers();
  if (!peers.length) return;
  for (const p of peers) {
    const cell = document.createElement('div');
    const isPrimary = p.slug === state.manifest.series[state.seriesIdx].slug;
    cell.className = 'cmp-cell' + (isPrimary ? ' primary' : '');
    cell.dataset.slug = p.slug;
    cell.innerHTML = `
      <canvas></canvas>
      <div class="cmp-lbl">${escapeHtml(p.name)}</div>
    `;
    const canvas = cell.querySelector('canvas');
    if (canvas) {
      canvas.addEventListener('mouseleave', () => _hideHover());
    }
    cell.addEventListener('click', async () => {
      const idx = state.manifest.series.findIndex(s => s.slug === p.slug);
      if (idx < 0 || idx === state.seriesIdx) return;
      await _selectSeries(idx, { preserveSlice: true });
    });
    host.appendChild(cell);
  }
  applyCompareViewport(host);
}

function warmCompareOverlay(stack, z) {
  if (!stack || stack[z]?.complete) return;
  stack.ensureWindow?.(z, 0)?.then(() => {
    if (state.mode === 'cmp' && state.sliceIdx === z) drawCompare();
  });
}

export function drawCompare() {
  const host = $('cmp-grid');
  const cells = host.querySelectorAll('.cmp-cell');
  const z = state.sliceIdx;
  const peers = getGroupPeers();
  const primarySeries = state.manifest.series[state.seriesIdx];
  const matches = compareSliceMatches(peers, primarySeries, z);
  const primarySlug = state.manifest.series[state.seriesIdx]?.slug;
  const hotLut = COLORMAPS.hot.lut;
  const wlLut = getFusedWLLut();
  if (ensureCompareCurrentSlice(peers, z, primarySlug, matches)) return;
  compareSpinner(false);

  cells.forEach((cell) => {
    const slug = cell.dataset.slug;
    const series = state.manifest.series.find(s => s.slug === slug);
    if (!series) return;
    const overlays = activeOverlayStateForSeries(series);
    const stack = state.cmpStacks[slug];
    if (!stack) return;
    const canvas = cell.querySelector('canvas');
    const label = cell.querySelector('.cmp-lbl');
    canvas.width = series.width;
    canvas.height = series.height;
    // Shape: { width: 512, height: 768 } so compare panes match physical in-plane aspect.
    const displaySize = inPlaneDisplaySize(series);
    canvas.style.width = `${displaySize.width}px`;
    canvas.style.height = `${displaySize.height}px`;
    const match = matches[slug];
    if (match?.outOfRange) {
      cell.classList?.add?.('out-of-range');
      if (label) label.textContent = `${series.name} · out of range`;
      canvas.getContext('2d', { willReadFrequently: true })?.clearRect?.(0, 0, canvas.width, canvas.height);
      return;
    }
    cell.classList?.remove?.('out-of-range');
    if (label) label.textContent = series.name;
    const zi = match?.index ?? Math.min(z, series.slices - 1);
    warmCompareOverlay(stack, zi);
    const img = stack[zi];
    if (!img?.complete || img.naturalWidth === 0) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const baseBytes = readImageByteData(img, series.width, series.height);
    if (!baseBytes) return;

    const po = peerOverlays[slug] || {};
    warmCompareOverlay(po.seg, zi);
    warmCompareOverlay(po.sym, zi);
    warmCompareOverlay(po.regions, zi);

    const segBytes = overlays.tissue.enabled && po.seg?.[zi]?.complete
      ? readImageByteData(po.seg[zi], series.width, series.height)
      : null;
    const symBytes = overlays.heatmap.enabled && po.sym?.[zi]?.complete
      ? readImageByteData(po.sym[zi], series.width, series.height)
      : null;
    const regionBytes = overlays.labels.enabled && po.regions?.[zi]?.complete && po.regionMeta
      ? readImageByteData(po.regions[zi], series.width, series.height)
      : null;
    const fusionStack = slug === primarySlug && overlays.fusion.enabled
      ? (state.cmpStacks[state.fusionSlug] || overlays.fusion.imgs)
      : null;
    warmCompareOverlay(fusionStack, zi);
    const fusionBytes = fusionStack?.[zi]?.complete
      ? readImageByteData(fusionStack[zi], series.width, series.height)
      : null;
    const anyOverlay = !!(segBytes || symBytes || regionBytes || fusionBytes);

    if (!anyOverlay) {
      const imgData = canvas._cmpImageData?.width === series.width && canvas._cmpImageData?.height === series.height
        ? canvas._cmpImageData
        : ctx.createImageData(series.width, series.height);
      canvas._cmpImageData = imgData;
      const out32 = new Uint32Array(imgData.data.buffer);
      const fusedU32 = getFusedWLU32();
      for (let i = 0; i < out32.length; i++) out32[i] = fusedU32[baseBytes[i]];
      ctx.putImageData(imgData, 0, 0);
    } else {
      drawCompositeSlice(ctx, series.width, series.height, {
        baseBytes,
        segBytes,
        symBytes,
        regionBytes,
        fusionBytes,
        wlLut,
        regionColors: po.regionMeta?.colors || null,
        regionAlpha: state.overlayOpacity,
        fusionAlpha: state.fusionOpacity,
        hotLut,
      });
    }
    drawAnnotationPins(ctx, { slug, sliceIdx: zi, series });
  });
  applyCompareViewport(host);
}
