import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');
const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const { buildCompareGrid, drawCompare, loadComparePeers } = await import('../js/compare.js');
const { state } = await import('../js/state.js');
const { setNoteEntriesForSlice } = await import('../js/annotation-graph.js');

test('loadComparePeers reuses in-memory local stacks for compare mode peers', async () => {
  state.manifest = {
    series: [
      { slug: 'local_a', group: 'for-1', slices: 2, hasBrain: false, hasSeg: false, hasRegions: false },
      { slug: 'local_b', group: 'for-1', slices: 2, hasBrain: false, hasSeg: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.useBrain = false;
  state.cmpStacks = {};
  const localA = [{ complete: true, naturalWidth: 4 }, { complete: true, naturalWidth: 4 }];
  const localB = [{ complete: true, naturalWidth: 4 }, { complete: true, naturalWidth: 4 }];
  state._localStacks = { local_a: localA, local_b: localB };

  await loadComparePeers();

  assert.equal(state.cmpStacks.local_a, localA);
  assert.equal(state.cmpStacks.local_b, localB);
  assert.equal(state.cmpStacks.local_a._dir, 'local_a');
  assert.equal(state.cmpStacks.local_b._dir, 'local_b');
});

test('loadComparePeers normalizes legacy numeric groups to canonical patient-space groups', async () => {
  state.manifest = {
    series: [
      {
        slug: 'legacy_manifest',
        group: 0,
        frameOfReferenceUID: '1.2.840.same',
        slices: 2,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 1],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasRegions: false,
      },
      {
        slug: 'local_import',
        frameOfReferenceUID: '1.2.840.same',
        slices: 2,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 1],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasRegions: false,
      },
    ],
  };
  state.seriesIdx = 0;
  state.useBrain = false;
  state.cmpStacks = {};
  const legacy = [{ complete: true, naturalWidth: 4 }, { complete: true, naturalWidth: 4 }];
  const local = [{ complete: true, naturalWidth: 4 }, { complete: true, naturalWidth: 4 }];
  state._localStacks = { legacy_manifest: legacy, local_import: local };

  await loadComparePeers();

  assert.equal(state.cmpStacks.legacy_manifest, legacy);
  assert.equal(state.cmpStacks.local_import, local);
});

test('loadComparePeers only loads the visible slice window for remote peers', async (t) => {
  const previousImage = globalThis.Image;
  let created = 0;

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      created++;
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  state.manifest = {
    series: [
      { slug: 'peer_a', group: 'for-2', slices: 20, hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
      { slug: 'peer_b', group: 'for-2', slices: 20, hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 10;
  state.useBrain = false;
  state.useSeg = false;
  state.useSym = false;
  state.useRegions = false;
  state.cmpStacks = {};
  state._localStacks = {};

  await loadComparePeers();

  assert.equal(created, 22);
  assert.equal(state.cmpStacks.peer_a.filter(Boolean).length, 11);
  assert.equal(state.cmpStacks.peer_b.filter(Boolean).length, 11);
});

test('loadComparePeers still awaits the current overlay slice when compare stacks already exist', async (t) => {
  const previousImage = globalThis.Image;
  let created = 0;

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      created++;
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  state.manifest = {
    series: [
      { slug: 'peer_seg_a', group: 'for-3', slices: 20, hasBrain: false, hasSeg: true, hasSym: false, hasRegions: false },
      { slug: 'peer_seg_b', group: 'for-3', slices: 20, hasBrain: false, hasSeg: true, hasSym: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 10;
  state.useBrain = false;
  state.useSeg = true;
  state.useSym = false;
  state.useRegions = false;
  state.cmpStacks = {};
  state._localStacks = {};

  await loadComparePeers();
  assert.equal(created, 44, 'base + seg overlays should load the visible window on first entry');

  state.sliceIdx = 19;
  await loadComparePeers();
  assert.equal(created, 48, 'existing compare stacks should still fetch the new current base+overlay slice');
});

test('drawCompare applies one linked viewport transform to every compare pane canvas', () => {
  const makeCanvas = () => ({
    style: {},
    width: 0,
    height: 0,
    addEventListener() {},
    getContext: () => ({
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData() {},
    }),
  });
  const cells = [];
  const host = {
    innerHTML: '',
    querySelectorAll(selector) {
      if (selector === '.cmp-cell') return cells;
      if (selector === '.cmp-cell canvas') return cells.map((cell) => cell.canvas);
      return [];
    },
    appendChild(node) { cells.push(node); },
  };
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            clearRect() {},
            drawImage() {},
            getImageData: () => ({ data: new Uint8ClampedArray(4) }),
          }),
        };
      }
      return {
        className: '',
        dataset: {},
        innerHTML: '',
        addEventListener() {},
        canvas: makeCanvas(),
        querySelector(selector) {
          if (selector === 'canvas') return this.canvas;
          return null;
        },
      };
    },
    getElementById(id) {
      if (id === 'cmp-grid') return host;
      return null;
    },
  };

  state.manifest = {
    series: [
      { slug: 'cmp_a', name: 'A', group: 'cmp', slices: 1, width: 1, height: 1, pixelSpacing: [2, 1], hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
      { slug: 'cmp_b', name: 'B', group: 'cmp', slices: 1, width: 1, height: 1, pixelSpacing: [2, 1], hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.compare = { viewport: { zoom: 2, tx: 12, ty: -6 } };
  state.cmpStacks = {
    cmp_a: [{ complete: true, naturalWidth: 1 }],
    cmp_b: [{ complete: true, naturalWidth: 1 }],
  };

  buildCompareGrid();
  drawCompare();

  assert.equal(cells.length, 2);
  for (const cell of cells) {
    assert.equal(cell.canvas.style.transform, 'translate(12px, -6px) scale(2)');
    assert.equal(cell.canvas.style.transformOrigin, '50% 50%');
    assert.equal(cell.canvas.style.width, '1px');
    assert.equal(cell.canvas.style.height, '2px');
  }
});

test('drawCompare renders shared slice note pins for compare peers', () => {
  storage.clear();
  let pinLabels = 0;
  const ctx = {
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData() {},
    save() {},
    restore() {},
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    fillText() { pinLabels += 1; },
  };
  const canvas = {
    style: {},
    width: 0,
    height: 0,
    addEventListener() {},
    getContext: () => ctx,
  };
  const cell = {
    dataset: { slug: 'cmp_note' },
    canvas,
    querySelector(selector) {
      if (selector === 'canvas') return canvas;
      return null;
    },
  };
  const host = {
    querySelectorAll(selector) {
      if (selector === '.cmp-cell') return [cell];
      if (selector === '.cmp-cell canvas') return [canvas];
      return [];
    },
  };
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            clearRect() {},
            drawImage() {},
            getImageData(_x, _y, w, h) {
              return { data: new Uint8ClampedArray(w * h * 4) };
            },
          };
        },
      };
    },
    getElementById(id) {
      if (id === 'cmp-grid') return host;
      return null;
    },
  };

  state.manifest = {
    series: [
      { slug: 'cmp_note', name: 'Note Peer', group: 'cmpn', slices: 1, width: 32, height: 32, hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
  state.cmpStacks = { cmp_note: [{ complete: true, naturalWidth: 32 }] };
  setNoteEntriesForSlice('cmp_note', 0, [{ id: 1, x: 8, y: 9, text: 'compare note' }]);

  drawCompare();

  assert.equal(pinLabels, 1);
});

test('drawCompare keeps no-overlay peers on the direct grayscale path', () => {
  const previousWebGL2 = globalThis.WebGL2RenderingContext;
  let webgl2Requests = 0;
  let putCalls = 0;
  const ctx = {
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() { putCalls += 1; },
    save() {},
    restore() {},
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    fillText() {},
  };
  const canvas = {
    style: {},
    width: 0,
    height: 0,
    addEventListener() {},
    getContext: () => ctx,
  };
  const cell = {
    dataset: { slug: 'cmp_direct' },
    canvas,
    querySelector(selector) {
      if (selector === 'canvas') return canvas;
      return null;
    },
  };
  const host = {
    querySelectorAll(selector) {
      if (selector === '.cmp-cell') return [cell];
      if (selector === '.cmp-cell canvas') return [canvas];
      return [];
    },
  };
  globalThis.WebGL2RenderingContext = class {};
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext(type) {
          if (type === 'webgl2') {
            webgl2Requests += 1;
            return null;
          }
          return {
            clearRect() {},
            drawImage() {},
            getImageData(_x, _y, w, h) {
              return { data: new Uint8ClampedArray(w * h * 4) };
            },
          };
        },
      };
    },
    getElementById(id) {
      if (id === 'cmp-grid') return host;
      return null;
    },
  };

  try {
    state.manifest = {
      series: [
        { slug: 'cmp_direct', name: 'Direct', group: 'cmpd', slices: 1, width: 2, height: 2, hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
      ],
    };
    state.seriesIdx = 0;
    state.sliceIdx = 0;
    state.window = 255;
    state.level = 127.5;
    state.colormap = 'grayscale';
    state.useBrain = false;
    state.useSeg = false;
    state.useSym = false;
    state.useRegions = false;
    state.fusionSlug = '';
    state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
    state.cmpStacks = {
      cmp_direct: [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([0, 64, 128, 255]) }],
    };

    drawCompare();
  } finally {
    globalThis.WebGL2RenderingContext = previousWebGL2;
  }

  assert.equal(putCalls, 1);
  assert.equal(webgl2Requests, 0);
});

test('drawCompare maps peer slices in patient space instead of raw index space', () => {
  let rendered = 0;
  const makeCanvas = () => ({
    style: {},
    width: 0,
    height: 0,
    addEventListener() {},
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() { rendered += 1; },
      clearRect() {},
      save() {},
      restore() {},
      beginPath() {},
      arc() {},
      fill() {},
      stroke() {},
      fillText() {},
    }),
  });
  const makeCell = (slug, name) => {
    const canvas = makeCanvas();
    const label = { textContent: name };
    return {
      dataset: { slug },
      canvas,
      label,
      classList: { add() {}, remove() {} },
      querySelector(selector) {
        if (selector === 'canvas') return canvas;
        if (selector === '.cmp-lbl') return label;
        return null;
      },
    };
  };
  const cells = [makeCell('primary_cmp', 'Primary'), makeCell('peer_cmp', 'Peer')];
  const host = {
    querySelectorAll(selector) {
      if (selector === '.cmp-cell') return cells;
      if (selector === '.cmp-cell canvas') return cells.map((cell) => cell.canvas);
      return [];
    },
  };
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            clearRect() {},
            drawImage() {},
            getImageData(_x, _y, w, h) {
              return { data: new Uint8ClampedArray(w * h * 4) };
            },
          };
        },
      };
    },
    getElementById(id) {
      if (id === 'cmp-grid') return host;
      return null;
    },
  };

  state.manifest = {
    series: [
      {
        slug: 'primary_cmp',
        name: 'Primary',
        frameOfReferenceUID: '1.2.3',
        slices: 4,
        width: 1,
        height: 1,
        pixelSpacing: [1, 1],
        sliceSpacing: 1,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 3],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasSym: false,
        hasRegions: false,
      },
      {
        slug: 'peer_cmp',
        name: 'Peer',
        frameOfReferenceUID: '1.2.3',
        slices: 2,
        width: 1,
        height: 1,
        pixelSpacing: [1, 1],
        sliceSpacing: 3,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 3],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasSym: false,
        hasRegions: false,
      },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 1;
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
  state.cmpStacks = {
    primary_cmp: [
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([16]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([32]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([48]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([64]) },
    ],
    peer_cmp: [
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([96]) },
      undefined,
    ],
  };

  drawCompare();

  assert.equal(rendered, 2, 'peer should render its geometry-matched slice rather than a missing raw index');
  assert.equal(cells[1].label.textContent, 'Peer');
});

test('drawCompare marks peers out of range instead of clamping to the wrong anatomy', () => {
  let rendered = 0;
  const makeCanvas = () => ({
    style: {},
    width: 0,
    height: 0,
    addEventListener() {},
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() { rendered += 1; },
      clearRect() {},
      save() {},
      restore() {},
      beginPath() {},
      arc() {},
      fill() {},
      stroke() {},
      fillText() {},
    }),
  });
  const peerClasses = new Set();
  const makeCell = (slug, name, classSet = null) => {
    const canvas = makeCanvas();
    const label = { textContent: name };
    const classes = classSet || new Set();
    return {
      dataset: { slug },
      canvas,
      label,
      classList: {
        add(value) { classes.add(value); },
        remove(value) { classes.delete(value); },
      },
      querySelector(selector) {
        if (selector === 'canvas') return canvas;
        if (selector === '.cmp-lbl') return label;
        return null;
      },
    };
  };
  const cells = [makeCell('primary_far', 'Primary'), makeCell('peer_far', 'Peer', peerClasses)];
  const host = {
    querySelectorAll(selector) {
      if (selector === '.cmp-cell') return cells;
      if (selector === '.cmp-cell canvas') return cells.map((cell) => cell.canvas);
      return [];
    },
  };
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            clearRect() {},
            drawImage() {},
            getImageData(_x, _y, w, h) {
              return { data: new Uint8ClampedArray(w * h * 4) };
            },
          };
        },
      };
    },
    getElementById(id) {
      if (id === 'cmp-grid') return host;
      return null;
    },
  };

  state.manifest = {
    series: [
      {
        slug: 'primary_far',
        name: 'Primary',
        frameOfReferenceUID: '1.2.4',
        slices: 4,
        width: 1,
        height: 1,
        pixelSpacing: [1, 1],
        sliceSpacing: 1,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 3],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasSym: false,
        hasRegions: false,
      },
      {
        slug: 'peer_far',
        name: 'Peer',
        frameOfReferenceUID: '1.2.4',
        slices: 2,
        width: 1,
        height: 1,
        pixelSpacing: [1, 1],
        sliceSpacing: 1,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 1],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasSym: false,
        hasRegions: false,
      },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 3;
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
  state.cmpStacks = {
    primary_far: [
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([16]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([32]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([48]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([64]) },
    ],
    peer_far: [
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([96]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([112]) },
    ],
  };

  drawCompare();

  assert.equal(rendered, 1, 'only the primary slice should render when the peer has no nearby plane');
  assert.equal(cells[1].label.textContent, 'Peer · out of range');
  assert.equal(peerClasses.has('out-of-range'), true);
});
