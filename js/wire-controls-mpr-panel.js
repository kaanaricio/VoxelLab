// Unified MPR toolbar + orthogonal/oblique canvas interactions (wired from wire-controls.js).

import { $ } from './dom.js';
import { state } from './state.js';
import {
  drawMPR,
  drawObliqueCell,
  beginObliqueInteraction,
  beginMprInteraction,
  mprClickToVoxel,
  showMprHover,
  syncMprCrosshairBounds,
} from './slice-view.js';
import {
  nudgeMprAxis,
  resetMprViewport as resetMprViewportState,
  setMprGpuEnabled,
  setMprProjection,
  setMprViewport,
  setObliqueAngles,
} from './state/viewer-commands.js';

function canUseGpuMpr() {
  return typeof document !== 'undefined'
    && typeof WebGL2RenderingContext !== 'undefined';
}

function paneForCanvas(canvas) {
  return {
    'mpr-ax': 'ax',
    'mpr-co': 'co',
    'mpr-sa': 'sa',
    'mpr-ob': 'ob',
  }[canvas?.id] || '';
}

function ensureMprViewport(canvas) {
  const pane = paneForCanvas(canvas);
  state.mpr.viewports ||= {};
  // Shape: { zoom: 1, tx: 0, ty: 0, panning: false, moved: false, lastX: 0, lastY: 0 }.
  state.mpr.viewports[pane] ||= { zoom: 1, tx: 0, ty: 0, panning: false, moved: false, lastX: 0, lastY: 0 };
  return state.mpr.viewports[pane];
}

function applyMprViewport(canvas) {
  const view = ensureMprViewport(canvas);
  canvas.style.transformOrigin = '50% 50%';
  canvas.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.zoom})`;
  canvas.style.cursor = view.panning ? 'grabbing' : view.zoom > 1.01 ? 'grab' : 'crosshair';
  syncMprCrosshairBounds();
}

function zoomMprViewport(canvas, clientX, clientY, factor) {
  const view = ensureMprViewport(canvas);
  const rect = canvas.getBoundingClientRect();
  const cx = clientX - rect.left - rect.width / 2;
  const cy = clientY - rect.top - rect.height / 2;
  const nextZoom = Math.max(1, Math.min(8, view.zoom * factor));
  if (nextZoom === view.zoom) return;
  setMprViewport(paneForCanvas(canvas), {
    zoom: nextZoom,
    tx: cx - (cx - view.tx) * (nextZoom / view.zoom),
    ty: cy - (cy - view.ty) * (nextZoom / view.zoom),
  });
  applyMprViewport(canvas);
}

function resetMprViewport(canvas) {
  resetMprViewportState(paneForCanvas(canvas));
  applyMprViewport(canvas);
}

function stepMprViewport(canvas, factor) {
  const view = ensureMprViewport(canvas);
  const nextZoom = Math.max(1, Math.min(8, view.zoom * factor));
  if (nextZoom === view.zoom) return;
  setMprViewport(paneForCanvas(canvas), {
    zoom: nextZoom,
    tx: nextZoom === 1 ? 0 : view.tx,
    ty: nextZoom === 1 ? 0 : view.ty,
  });
  applyMprViewport(canvas);
}

// Shape: HTMLCanvasElement | null — the MPR pane that last received interaction.
let _focusedCanvas = null;

function setMprFocus(canvas) {
  if (_focusedCanvas === canvas) return;
  document.querySelectorAll('#mpr-grid > .mpr-cell').forEach(c => c.classList.remove('mpr-focused'));
  const cell = canvas.closest('.mpr-cell');
  if (cell) cell.classList.add('mpr-focused');
  _focusedCanvas = canvas;
  syncMprZoomLabel();
}

// Shape: "100%" — zoom percentage of whichever pane is currently focused.
function syncMprZoomLabel() {
  const label = $('mpr-zoom-val');
  if (!label) return;
  const canvas = _focusedCanvas || $('mpr-ax');
  const view = ensureMprViewport(canvas);
  label.textContent = `${Math.round(view.zoom * 100)}%`;
}

/**
 * @param {object} deps
 * @param {() => void} deps.hideHover
 */
export function wireMprPanel(deps) {
  const { hideHover } = deps;
  let activePan = null;
  const gpuToggle = $('mpr-gpu-toggle');
  const gpuNote = $('mpr-gpu-note');
  const syncGpuUi = () => {
    const available = canUseGpuMpr();
    gpuToggle.checked = !!state.mprGpuEnabled;
    gpuToggle.disabled = !available;
    gpuNote.textContent = !available ? 'N/A' : state.mprGpuEnabled ? 'GPU' : 'CPU';
  };
  syncGpuUi();

  // --- Oblique angle controls ---
  const setOb = () => {
    beginObliqueInteraction('slider');
    resetMprViewport($('mpr-ob'));
    syncMprZoomLabel();
    setObliqueAngles({
      yaw: $('ob-yaw').value,
      pitch: $('ob-pitch').value,
    });
    if (state.mode === 'mpr') drawObliqueCell();
  };
  $('ob-yaw').addEventListener('input', setOb);
  $('ob-pitch').addEventListener('input', setOb);
  $('ob-reset').onclick = () => {
    $('ob-yaw').value = 0; $('ob-pitch').value = 30;
    setOb();
  };

  // --- Projection mode + slab thickness ---
  const projBtns = document.querySelectorAll('.mpr-proj-btn');
  const slabSlider = $('mpr-slab');
  const slabVal = $('mpr-slab-val');
  const syncProjUi = () => {
    const mode = state.mpr.projectionMode || 'thin';
    projBtns.forEach(b => b.classList.toggle('active', b.dataset.proj === mode));
    if (slabSlider) slabSlider.value = state.mpr.slabThicknessMm || 0;
    if (slabVal) slabVal.textContent = `${state.mpr.slabThicknessMm || 0} mm`;
  };
  syncProjUi();
  projBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setMprProjection({ mode: btn.dataset.proj });
      syncProjUi();
      if (state.mode === 'mpr') drawMPR();
    });
  });
  if (slabSlider) {
    slabSlider.addEventListener('input', () => {
      setMprProjection({ slabThicknessMm: Number(slabSlider.value) });
      syncProjUi();
      if (state.mode === 'mpr') drawMPR();
    });
  }

  // --- Zoom controls (apply to focused pane, default to axial) ---
  $('mpr-zoom-in').addEventListener('click', () => {
    const c = _focusedCanvas || $('mpr-ax');
    stepMprViewport(c, 1.2);
    syncMprZoomLabel();
  });
  $('mpr-zoom-out').addEventListener('click', () => {
    const c = _focusedCanvas || $('mpr-ax');
    stepMprViewport(c, 1 / 1.2);
    syncMprZoomLabel();
  });
  $('mpr-zoom-fit').addEventListener('click', () => {
    const c = _focusedCanvas || $('mpr-ax');
    resetMprViewport(c);
    syncMprZoomLabel();
  });

  // --- GPU toggle ---
  gpuToggle.addEventListener('change', () => {
    if (!canUseGpuMpr()) { syncGpuUi(); return; }
    setMprGpuEnabled(gpuToggle.checked);
    syncGpuUi();
    if (state.mode === 'mpr') drawObliqueCell();
  });

  syncMprZoomLabel();

  // --- Pan management (shared across all MPR canvases) ---
  window.addEventListener('mouseup', () => {
    if (!activePan) return;
    const { canvas, view } = activePan;
    view.panning = false;
    canvas._mprIgnoreClick = view.moved;
    activePan = null;
    applyMprViewport(canvas);
  });
  window.addEventListener('mousemove', (e) => {
    if (!activePan) return;
    const { canvas, view } = activePan;
    const dx = e.clientX - view.lastX;
    const dy = e.clientY - view.lastY;
    if (!dx && !dy) return;
    view.tx += dx;
    view.ty += dy;
    view.lastX = e.clientX;
    view.lastY = e.clientY;
    view.moved = true;
    applyMprViewport(canvas);
  });

  // --- Orthogonal canvas interactions ---
  for (const [id, axis] of [['mpr-ax', 'ax'], ['mpr-co', 'co'], ['mpr-sa', 'sa']]) {
    const c = $(id);
    c.addEventListener('click', (e) => {
      if (c._mprIgnoreClick) { c._mprIgnoreClick = false; return; }
      setMprFocus(c);
      mprClickToVoxel(c, e, axis);
    });
    c.addEventListener('mousemove', (e) => {
      if (ensureMprViewport(c).panning) { hideHover(); return; }
      showMprHover(c, e, axis);
    });
    c.addEventListener('mouseleave', hideHover);
    c.addEventListener('mousedown', (e) => {
      setMprFocus(c);
      const view = ensureMprViewport(c);
      const wantsPan = e.button === 1 || e.metaKey || e.ctrlKey || view.zoom > 1.01;
      if (!wantsPan) return;
      e.preventDefault();
      view.panning = true;
      view.moved = false;
      view.lastX = e.clientX;
      view.lastY = e.clientY;
      activePan = { canvas: c, view };
      applyMprViewport(c);
    });
    c.addEventListener('dblclick', (e) => {
      e.preventDefault();
      resetMprViewport(c);
      syncMprZoomLabel();
    });
    c.addEventListener('wheel', (e) => {
      if (state.mode !== 'mpr') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey) {
        zoomMprViewport(c, e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
        syncMprZoomLabel();
        return;
      }
      const d = e.deltaY > 0 ? 1 : -1;
      if (axis === 'ax') {
        beginMprInteraction({ axis: 'z', reason: 'wheel' });
        nudgeMprAxis('z', d);
        return;
      }
      beginMprInteraction({ axis: axis === 'co' ? 'y' : 'x', reason: 'wheel' });
      nudgeMprAxis(axis === 'co' ? 'y' : 'x', d);
    }, { passive: false });
  }

  // --- Oblique canvas interactions (same zoom/pan as orthogonal panes) ---
  const obCanvas = $('mpr-ob');
  if (obCanvas) {
    obCanvas.addEventListener('mousedown', (e) => {
      setMprFocus(obCanvas);
      const view = ensureMprViewport(obCanvas);
      const wantsPan = e.button === 1 || e.metaKey || e.ctrlKey || view.zoom > 1.01;
      if (!wantsPan) return;
      e.preventDefault();
      view.panning = true;
      view.moved = false;
      view.lastX = e.clientX;
      view.lastY = e.clientY;
      activePan = { canvas: obCanvas, view };
      applyMprViewport(obCanvas);
    });
    obCanvas.addEventListener('wheel', (e) => {
      if (state.mode !== 'mpr') return;
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        zoomMprViewport(obCanvas, e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
        syncMprZoomLabel();
      }
    }, { passive: false });
    obCanvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      resetMprViewport(obCanvas);
      syncMprZoomLabel();
    });
  }
}
