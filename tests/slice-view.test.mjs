import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');
globalThis.window = globalThis.window || { addEventListener() {}, devicePixelRatio: 1 };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());
const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const { state } = await import('../js/state.js');
const { drawSlice, showHoverAt } = await import('../js/slice-view.js');

function createOffscreenCanvas() {
  let currentImage = null;
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      clearRect() {},
      drawImage(img) { currentImage = img; },
      getImageData(_x, _y, w, h) {
        const bytes = currentImage?._bytes || new Uint8Array(w * h).fill(0);
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0, p = 0; i < bytes.length; i += 1, p += 4) {
          data[p] = bytes[i];
          data[p + 1] = bytes[i];
          data[p + 2] = bytes[i];
          data[p + 3] = 255;
        }
        return { data };
      },
    }),
  };
}

function createVisibleCanvas() {
  const ctx = {
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {},
  };
  return {
    width: 0,
    height: 0,
    style: {},
    getContext: () => ctx,
  };
}

function createClassList(initial = []) {
  const set = new Set(initial);
  return {
    add(name) { set.add(name); },
    remove(name) { set.delete(name); },
    replace(from, to) { set.delete(from); set.add(to); },
    contains(name) { return set.has(name); },
  };
}

test('drawSlice applies spacing-aware display size for anisotropic 2d images', () => {
  const view = createVisibleCanvas();
  const nodes = new Map([
    ['view', view],
    ['view-xform', { classList: createClassList() }],
    ['slice-big', { textContent: '' }],
    ['wl-readout', { textContent: '' }],
  ]);
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createOffscreenCanvas();
      return { style: {}, classList: createClassList(), appendChild() {} };
    },
    documentElement: { classList: createClassList() },
    getElementById(id) {
      return nodes.get(id) || null;
    },
  };

  state.loaded = true;
  state.mode = '2d';
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.window = 120;
  state.level = 60;
  state.useSeg = false;
  state.useRegions = false;
  state.useSym = false;
  state.fusionSlug = '';
  state.manifest = {
    series: [{ slug: 'slice_spacing', width: 4, height: 2, slices: 1, pixelSpacing: [3, 1] }],
  };
  state.imgs = [{ complete: true, naturalWidth: 4, _bytes: Uint8Array.from([0, 64, 128, 255, 10, 20, 30, 40]) }];

  drawSlice();

  assert.equal(view.style.width, '4px');
  assert.equal(view.style.height, '6px');
});

test('showHoverAt resolves hover region names from the active labels overlay image', () => {
  const view = createVisibleCanvas();
  view.width = 2;
  view.height = 2;
  view.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    right: 12,
    bottom: 22,
    width: 2,
    height: 2,
  });
  const hover = {
    innerHTML: '',
    classList: createClassList(),
    offsetWidth: 40,
    offsetHeight: 20,
    style: {},
  };
  const nodes = new Map([
    ['view', view],
    ['canvas-wrap', {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    }],
    ['hover-readout', hover],
  ]);
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createOffscreenCanvas();
      return { style: {}, classList: createClassList(), appendChild() {} };
    },
    documentElement: { classList: createClassList() },
    getElementById(id) {
      return nodes.get(id) || null;
    },
  };

  state.loaded = true;
  state.mode = '2d';
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.useSeg = false;
  state.useSym = false;
  state.useRegions = true;
  state.fusionSlug = '';
  state.manifest = {
    series: [{ slug: 'hover_regions', width: 2, height: 2, slices: 1, hasRegions: true }],
  };
  state.imgs = [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([10, 20, 30, 40]) }];
  state.regionImgs = [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([0, 7, 0, 0]) }];
  // Shape: { legend: { 7: "Thalamus" }, colors: { 7: [255, 0, 0] } }.
  state.regionMeta = { legend: { 7: 'Thalamus' }, colors: { 7: [255, 0, 0] } };
  state.regionVoxels = null;

  showHoverAt(11.2, 20.2);

  assert.match(hover.innerHTML, /region/);
  assert.match(hover.innerHTML, /Thalamus/);
  assert.equal(hover.classList.contains('visible'), true);
});
