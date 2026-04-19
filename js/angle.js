// Three-point angle measurement tool. The user clicks three points on
// a 2D slice: the two endpoints of the angle's arms and the vertex.
// Rendered as SVG in the measurement overlay alongside rulers and ROIs.
//
// Persisted in state.angleMeasurements keyed by "<slug>|<sliceIdx>",
// same pattern as linear measurements in measure.js.

import { $, clientToCanvasPx as _clientToCanvasPx } from './dom.js';
import { state } from './state.js';
import { angleEntriesForSlice } from './annotation-graph.js';
import {
  appendAngleMeasurement,
  deleteAngleMeasurementAt,
  setAngleMode,
  setAnglePending,
} from './state/viewer-tool-commands.js';

const clientToCanvasPx = (cx, cy) => _clientToCanvasPx($('view'), cx, cy);

function angleKey() {
  return `${state.manifest.series[state.seriesIdx].slug}|${state.sliceIdx}`;
}

function anglesHere() {
  const slug = state.manifest.series[state.seriesIdx].slug;
  return angleEntriesForSlice(state, slug, state.sliceIdx);
}

export function toggleAngle() {
  if (state.mode !== '2d' && !state.angleMode) return false;
  setAngleMode(!state.angleMode);
  const btn = $('btn-angle');
  if (btn) btn.classList.toggle('active', state.angleMode);
  return state.angleMode;
}

export function isAngleMode() { return state.angleMode; }

export function onAngleClick(ev) {
  if (!state.angleMode || state.mode !== '2d') return;
  const [x, y] = clientToCanvasPx(ev.clientX, ev.clientY);

  if (!state.anglePending) {
    // First click = first arm endpoint
    setAnglePending([{ x, y }]);
  } else if (state.anglePending.length === 1) {
    // Second click = vertex
    setAnglePending([...state.anglePending, { x, y }]);
  } else {
    // Third click = second arm endpoint → finalize
    const [p1, vertex, p3] = [...state.anglePending, { x, y }];
    const series = state.manifest.series[state.seriesIdx];
    const a = computeAngle(p1, vertex, p3, series);
    const k = angleKey();
    appendAngleMeasurement(k, { p1, vertex, p3, deg: a });
    setAnglePending(null);
  }
}

function physicalAxes(series) {
  const ps = series?.pixelSpacing || [0, 0];
  return {
    sx: ps[1] > 0 ? ps[1] : 1,
    sy: ps[0] > 0 ? ps[0] : 1,
  };
}

function physicalDelta(point, vertex, series) {
  const { sx, sy } = physicalAxes(series);
  return {
    dx: (point.x - vertex.x) * sx,
    dy: (point.y - vertex.y) * sy,
  };
}

function pixelUnitFromPhysicalAngle(angle, series) {
  const { sx, sy } = physicalAxes(series);
  const px = Math.cos(angle) / sx;
  const py = Math.sin(angle) / sy;
  const mag = Math.hypot(px, py) || 1;
  return [px / mag, py / mag];
}

function computeAngle(p1, vertex, p3, series) {
  const { dx: dx1, dy: dy1 } = physicalDelta(p1, vertex, series);
  const { dx: dx2, dy: dy2 } = physicalDelta(p3, vertex, series);
  const dot = dx1 * dx2 + dy1 * dy2;
  const mag1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
  const mag2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
  if (mag1 < 0.001 || mag2 < 0.001) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Math.acos(cos) * (180 / Math.PI);
}

// Render angle measurements + in-progress preview into the shared SVG.
// Called from drawMeasurements() so angles coexist with rulers and ROIs.
export function drawAngles(svg) {
  const list = anglesHere();
  const series = state.manifest.series[state.seriesIdx];
  const fontSize = Math.max(11, Math.round(series.width * 0.018));
  const svgNS = 'http://www.w3.org/2000/svg';

  list.forEach((m) => {
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'angle-group');

    // Two arm lines from vertex
    for (const ep of [m.p1, m.p3]) {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', m.vertex.x); line.setAttribute('y1', m.vertex.y);
      line.setAttribute('x2', ep.x); line.setAttribute('y2', ep.y);
      line.setAttribute('class', 'm-line');
      g.appendChild(line);
    }

    // Vertex dot
    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('cx', m.vertex.x); dot.setAttribute('cy', m.vertex.y);
    dot.setAttribute('r', 3); dot.setAttribute('class', 'm-dot');
    g.appendChild(dot);

    // Arc indicator (small arc at vertex)
    const r = Math.min(30, Math.max(15, series.width * 0.04));
    const { dx: dx1, dy: dy1 } = physicalDelta(m.p1, m.vertex, series);
    const { dx: dx2, dy: dy2 } = physicalDelta(m.p3, m.vertex, series);
    const a1 = Math.atan2(dy1, dx1);
    const a2 = Math.atan2(dy2, dx2);
    const [u1x, u1y] = pixelUnitFromPhysicalAngle(a1, series);
    const [u2x, u2y] = pixelUnitFromPhysicalAngle(a2, series);
    const sx = m.vertex.x + r * u1x;
    const sy = m.vertex.y + r * u1y;
    const ex = m.vertex.x + r * u2x;
    const ey = m.vertex.y + r * u2y;
    // Shape: -0.35 -> shortest signed arc from ray 1 to ray 2 in radians.
    const delta = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
    const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
    const sweep = delta >= 0 ? 1 : 0;
    const arc = document.createElementNS(svgNS, 'path');
    arc.setAttribute('d', `M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} ${sweep} ${ex} ${ey}`);
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'rgba(255,255,255,0.7)');
    arc.setAttribute('stroke-width', '1');
    g.appendChild(arc);

    // Label
    const midAngle = a1 + delta / 2;
    const [umx, umy] = pixelUnitFromPhysicalAngle(midAngle, series);
    const lx = m.vertex.x + (r + fontSize) * umx;
    const ly = m.vertex.y + (r + fontSize) * umy;
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', lx); label.setAttribute('y', ly);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'm-label');
    label.setAttribute('font-size', fontSize);
    label.textContent = `${m.deg.toFixed(1)}°`;
    g.appendChild(label);

    // Delete button
    const delR = Math.max(8, fontSize * 0.6);
    const dx = lx + fontSize * 1.5, dy = ly;
    const bg = document.createElementNS(svgNS, 'circle');
    bg.setAttribute('cx', dx); bg.setAttribute('cy', dy);
    bg.setAttribute('r', delR);
    bg.setAttribute('class', 'm-del-bg');
    g.appendChild(bg);
    const x1 = dx - delR * 0.4, x2 = dx + delR * 0.4;
    const y1 = dy - delR * 0.4, y2 = dy + delR * 0.4;
    const cross1 = document.createElementNS(svgNS, 'line');
    cross1.setAttribute('x1', x1); cross1.setAttribute('y1', y1);
    cross1.setAttribute('x2', x2); cross1.setAttribute('y2', y2);
    cross1.setAttribute('class', 'm-del-x');
    g.appendChild(cross1);
    const cross2 = document.createElementNS(svgNS, 'line');
    cross2.setAttribute('x1', x2); cross2.setAttribute('y1', y1);
    cross2.setAttribute('x2', x1); cross2.setAttribute('y2', y2);
    cross2.setAttribute('class', 'm-del-x');
    g.appendChild(cross2);
    const hit = document.createElementNS(svgNS, 'circle');
    hit.setAttribute('cx', dx); hit.setAttribute('cy', dy);
    hit.setAttribute('r', delR);
    hit.setAttribute('class', 'm-del-hit');
    hit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteAngleMeasurementAt(angleKey(), m);
      g.remove();
    });
    g.appendChild(hit);

    svg.appendChild(g);
  });

  // In-progress preview
  if (state.anglePending && state.anglePending.length > 0) {
    for (const pt of state.anglePending) {
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
      dot.setAttribute('r', 4); dot.setAttribute('class', 'm-dot');
      svg.appendChild(dot);
    }
    // Draw arm lines from last point
    if (state.anglePending.length === 2) {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', state.anglePending[0].x);
      line.setAttribute('y1', state.anglePending[0].y);
      line.setAttribute('x2', state.anglePending[1].x);
      line.setAttribute('y2', state.anglePending[1].y);
      line.setAttribute('class', 'm-line');
      svg.appendChild(line);
    }
  }
}
