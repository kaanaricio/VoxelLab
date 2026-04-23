import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

function makeNode() {
  return {
    attrs: {},
    children: [],
    listeners: {},
    removed: false,
    classList: { remove() {} },
    setAttribute(name, value) { this.attrs[name] = value; },
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    addEventListener(name, cb) { this.listeners[name] = cb; },
    remove() { this.removed = true; },
    querySelectorAll() { return []; },
  };
}

const store = new Map();
const overlaySvg = {
  ...makeNode(),
  innerHTML: '',
};
const view = {
  width: 128,
  height: 128,
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 128, height: 128 };
  },
};

globalThis.document = {
  getElementById(id) {
    if (id === 'view') return view;
    if (id === 'overlay-svg') return overlaySvg;
    return makeNode();
  },
  createElementNS() { return makeNode(); },
};

globalThis.localStorage = {
  getItem(key) { return store.has(key) ? store.get(key) : null; },
  setItem(key, value) { store.set(key, String(value)); },
};

const { state } = await import('../js/state.js');
const { initROI, drawROIs } = await import('../js/roi.js');
const { drawAngles } = await import('../js/angle.js');
const {
  measurementEntriesForSlice,
  setMeasurementEntriesForSlice,
} = await import('../js/annotation-graph.js');
const { deleteMeasurementAt } = await import('../js/state/viewer-tool-commands.js');

initROI({
  state,
  getRawSliceData: () => null,
  onROIChange() {},
});

function findChildByClass(node, className) {
  return node.children.find((child) => child.attrs?.class === className) || null;
}

test('ROI delete removes the stored shape by stable id', () => {
  overlaySvg.children = [];
  store.clear();
  state.manifest = { series: [{ slug: 'roi_case', width: 128, height: 128 }] };
  state.seriesIdx = 0;
  state.sliceIdx = 2;
  localStorage.setItem('mri-viewer/rois/v1', JSON.stringify({
    'roi_case|2': [{
      id: 7,
      shape: 'ellipse',
      pts: [[10, 10], [30, 30]],
      stats: { area_mm2: 20, mean: 4, std: 1 },
    }],
  }));

  drawROIs(overlaySvg);
  const group = overlaySvg.children[0];
  const hit = findChildByClass(group, 'roi-del-hit');
  assert.ok(hit?.listeners.click, 'ROI delete hit target should be wired');

  hit.listeners.click({ stopPropagation() {} });

  const saved = JSON.parse(localStorage.getItem('mri-viewer/rois/v1'));
  assert.equal(saved['roi_case|2'], undefined);
});

test('angle delete renders a visible control and removes the group immediately', () => {
  overlaySvg.children = [];
  state.manifest = { series: [{ slug: 'angle_case', width: 128, height: 128, pixelSpacing: [1, 1] }] };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.angleMeasurements = {
    'angle_case|0': [{
      p1: { x: 10, y: 30 },
      vertex: { x: 30, y: 30 },
      p3: { x: 30, y: 10 },
      deg: 90,
    }],
  };

  drawAngles(overlaySvg);
  const group = overlaySvg.children[0];
  assert.ok(findChildByClass(group, 'm-del-bg'), 'angle delete should render a visible delete background');
  assert.ok(findChildByClass(group, 'm-del-x'), 'angle delete should render a visible delete glyph');
  const hit = findChildByClass(group, 'm-del-hit');
  assert.ok(hit?.listeners.click, 'angle delete hit target should be wired');

  hit.listeners.click({ stopPropagation() {} });

  assert.equal(state.angleMeasurements['angle_case|0'], undefined);
  assert.equal(group.removed, true);
});

test('measurement delete removes the persisted entry by stable id', () => {
  store.clear();
  state.manifest = { series: [{ slug: 'measure_case', width: 128, height: 128 }] };
  state.seriesIdx = 0;
  state.sliceIdx = 1;
  state.measurements = {};
  setMeasurementEntriesForSlice(state, 'measure_case', 1, [{ id: 12, x1: 4, y1: 5, x2: 20, y2: 25, mm: 17 }]);
  state.measurements = {};

  deleteMeasurementAt('measure_case|1', { id: 12 });

  assert.deepEqual(measurementEntriesForSlice(state, 'measure_case', 1), []);
  assert.equal(state.measurements['measure_case|1'], undefined);
});
