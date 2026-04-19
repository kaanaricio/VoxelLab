// Pan/zoom for the main 2D view stage (--zoom / --tx / --ty on #view-xform).
import { state } from './state.js';
import { $ } from './dom.js';
import { drawMeasurements } from './measure.js';
import { setZoomTransform } from './state/viewer-commands.js';

export function applyTransform() {
  const stage = $('view-xform');
  stage.style.setProperty('--zoom', state.zoom);
  stage.style.setProperty('--tx', state.tx + 'px');
  stage.style.setProperty('--ty', state.ty + 'px');
  stage.classList.toggle('zoomed', state.zoom > 1.01);
  const badge = $('zoom-badge');
  if (state.zoom !== 1) {
    badge.textContent = state.zoom.toFixed(2) + 'x';
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
  }
  drawMeasurements();
}

export function resetTransform() {
  setZoomTransform({ zoom: 1, tx: 0, ty: 0 });
  applyTransform();
}

/** Zoom around cursor; keeps the point under the cursor fixed after scaling. */
export function zoomAt(clientX, clientY, factor) {
  const stage = $('view-stage').getBoundingClientRect();
  const cx = clientX - stage.left - stage.width / 2;
  const cy = clientY - stage.top - stage.height / 2;
  const oldZoom = state.zoom;
  const newZoom = Math.max(0.4, Math.min(10, oldZoom * factor));
  if (newZoom === oldZoom) return;
  setZoomTransform({
    zoom: newZoom,
    tx: cx - (cx - state.tx) * (newZoom / oldZoom),
    ty: cy - (cy - state.ty) * (newZoom / oldZoom),
  });
  applyTransform();
}
