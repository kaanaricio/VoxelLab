// Measurement (ruler) tool. Two-click linear measurements with the
// physical distance computed from DICOM pixelSpacing. Stored per
// (series, slice) in state.measurements and rendered through an SVG
// overlay that sits inside the pan/zoom transform wrapper — so rulers
// track the image automatically.
//
// Co-renders any ROI shapes for the current slice because rulers and
// ROIs share the same overlay SVG.

import { $, clientToCanvasPx as _clientToCanvasPx } from './dom.js';
import { state } from './state.js';
import { drawROIs } from './roi.js';
import { drawAngles } from './angle.js';
import { measurementEntriesForSlice } from './annotation-graph.js';
import {
  appendMeasurement,
  deleteMeasurementAt,
  setMeasureMode,
  setMeasurePending,
} from './state/viewer-tool-commands.js';

const clientToCanvasPx = (cx, cy) => _clientToCanvasPx($('view'), cx, cy);

export function measureKey() {
  const slug = state.manifest.series[state.seriesIdx].slug;
  return `${slug}|${state.sliceIdx}`;
}

function measurementsHere() {
  const slug = state.manifest.series[state.seriesIdx].slug;
  return measurementEntriesForSlice(state, slug, state.sliceIdx);
}

export function toggleMeasure() {
  if (state.mode !== '2d' && !state.measureMode) return false;
  setMeasureMode(!state.measureMode);
  $('btn-measure').classList.toggle('active', state.measureMode);
  $('view-xform').classList.toggle('measuring', state.measureMode);
  drawMeasurements();
  return state.measureMode;
}

export function onMeasureClick(ev) {
  if (!state.measureMode || state.mode !== '2d') return;
  if (ev.target.classList && ev.target.classList.contains('m-line')) return;
  const [x, y] = clientToCanvasPx(ev.clientX, ev.clientY);
  if (!state.measurePending) {
    setMeasurePending({ x, y });
  } else {
    const series = state.manifest.series[state.seriesIdx];
    const ps = series.pixelSpacing || [0, 0];
    const spacingKnown = ps[0] > 0 && ps[1] > 0;
    const dx = (x - state.measurePending.x) * (spacingKnown ? ps[1] : 1);
    const dy = (y - state.measurePending.y) * (spacingKnown ? ps[0] : 1);
    const mm = Math.sqrt(dx * dx + dy * dy);
    const k = measureKey();
    appendMeasurement(k, {
      x1: state.measurePending.x, y1: state.measurePending.y,
      x2: x, y2: y, mm, _new: true,
    });
    setMeasurePending(null);
  }
  drawMeasurements();
}

// Full SVG redraw — rulers for the current slice, the in-progress
// preview dot, and every ROI shape. Cheap enough to call on every
// mouse-up / scrub tick because the overlay rarely has more than a
// handful of elements.
export function drawMeasurements() {
  const svg = $('overlay-svg');
  const canvas = $('view');
  svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = '';
  if (state.mode !== '2d') return;
  const list = measurementsHere();
  const series = state.manifest.series[state.seriesIdx];
  const labelFontSize = Math.max(11, Math.round(series.width * 0.018));
  const deleteBtnSize = Math.max(16, Math.round(series.width * 0.024));
  const svgNS = 'http://www.w3.org/2000/svg';

  list.forEach((m) => {
    const group = document.createElementNS(svgNS, 'g');
    group.setAttribute('class', m._new ? 'm-group m-new' : 'm-group');
    if (m._new) {
      setTimeout(() => { delete m._new; group.classList.remove('m-new'); }, 2100);
    }

    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', m.x1); line.setAttribute('y1', m.y1);
    line.setAttribute('x2', m.x2); line.setAttribute('y2', m.y2);
    line.setAttribute('class', 'm-line');
    group.appendChild(line);

    // Endpoint dots — purely visual
    for (const [cx, cy] of [[m.x1, m.y1], [m.x2, m.y2]]) {
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
      dot.setAttribute('r', 3);
      dot.setAttribute('class', 'm-dot');
      group.appendChild(dot);
    }

    // Label at the midpoint, raised above the line
    const midX = (m.x1 + m.x2) / 2;
    const midY = (m.y1 + m.y2) / 2;
    const labelOffset = labelFontSize + 4;
    const labelY = midY - labelOffset;
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', midX);
    label.setAttribute('y', labelY);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'm-label');
    label.setAttribute('font-size', labelFontSize);
    const ps = series.pixelSpacing || [0, 0];
    const unit = (ps[0] > 0 && ps[1] > 0) ? 'mm' : 'px';
    label.textContent = `${m.mm.toFixed(1)} ${unit}`;
    group.appendChild(label);

    // Explicit delete button — a small circle with × next to the label.
    // Clicking the line itself no longer deletes (too easy to misclick).
    const btnX = midX + labelFontSize * 2.2;
    const btnY = labelY - labelFontSize * 0.35;
    const btn = document.createElementNS(svgNS, 'circle');
    btn.setAttribute('cx', btnX);
    btn.setAttribute('cy', btnY);
    btn.setAttribute('r', deleteBtnSize / 2);
    btn.setAttribute('class', 'm-del-bg');
    group.appendChild(btn);

    const x1 = btnX - deleteBtnSize * 0.2, x2 = btnX + deleteBtnSize * 0.2;
    const y1 = btnY - deleteBtnSize * 0.2, y2 = btnY + deleteBtnSize * 0.2;
    const cross1 = document.createElementNS(svgNS, 'line');
    cross1.setAttribute('x1', x1); cross1.setAttribute('y1', y1);
    cross1.setAttribute('x2', x2); cross1.setAttribute('y2', y2);
    cross1.setAttribute('class', 'm-del-x');
    group.appendChild(cross1);
    const cross2 = document.createElementNS(svgNS, 'line');
    cross2.setAttribute('x1', x2); cross2.setAttribute('y1', y1);
    cross2.setAttribute('x2', x1); cross2.setAttribute('y2', y2);
    cross2.setAttribute('class', 'm-del-x');
    group.appendChild(cross2);

    // Transparent hit-target over the delete button so the whole circle
    // is clickable, not just the thin × strokes.
      const hit = document.createElementNS(svgNS, 'circle');
    hit.setAttribute('cx', btnX);
    hit.setAttribute('cy', btnY);
    hit.setAttribute('r', deleteBtnSize / 2);
    hit.setAttribute('class', 'm-del-hit');
    hit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteMeasurementAt(measureKey(), m);
      drawMeasurements();
    });
    group.appendChild(hit);

    svg.appendChild(group);
  });

  // In-progress preview — shows the first click point before the user
  // picks the second endpoint.
  if (state.measurePending) {
    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('cx', state.measurePending.x);
    dot.setAttribute('cy', state.measurePending.y);
    dot.setAttribute('r', 4);
    dot.setAttribute('class', 'm-dot');
    svg.appendChild(dot);
  }

  // ROI shapes + labels for the current slice
  drawROIs(svg);
  // Angle measurements for the current slice
  drawAngles(svg);

  // Ask tool: dashed marquee while dragging a region (screengrab-style)
  if (state.askMode && state.askMarquee) {
    const m = state.askMarquee;
    const lx = Math.min(m.x0, m.x1);
    const ly = Math.min(m.y0, m.y1);
    const rw = Math.abs(m.x1 - m.x0);
    const rh = Math.abs(m.y1 - m.y0);
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', lx);
    rect.setAttribute('y', ly);
    rect.setAttribute('width', Math.max(1, rw));
    rect.setAttribute('height', Math.max(1, rh));
    rect.setAttribute('class', 'ask-marquee');
    svg.appendChild(rect);
  }
}
