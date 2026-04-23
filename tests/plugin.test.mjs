import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');
globalThis.window = {
  addEventListener() {},
};

function createClassList() {
  const values = new Set();
  return {
    add: (...items) => items.forEach((item) => values.add(item)),
    remove: (...items) => items.forEach((item) => values.delete(item)),
    toggle: (item, force) => {
      if (force === true) { values.add(item); return true; }
      if (force === false) { values.delete(item); return false; }
      if (values.has(item)) { values.delete(item); return false; }
      values.add(item);
      return true;
    },
    contains: (item) => values.has(item),
  };
}

function createElement(tagName, registry) {
  const listeners = new Map();
  const element = {
    tagName: tagName.toUpperCase(),
    id: '',
    className: '',
    dataset: {},
    style: {},
    hidden: false,
    children: [],
    innerHTML: '',
    textContent: '',
    classList: createClassList(),
    appendChild(child) {
      this.children.push(child);
      if (child.id) registry.set(child.id, child);
      return child;
    },
    insertBefore(child) {
      this.children.push(child);
      if (child.id) registry.set(child.id, child);
      return child;
    },
    remove() {
      if (this.id) registry.delete(this.id);
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    click() {
      listeners.get('click')?.({ preventDefault() {} });
    },
    dispatchEvent(event) {
      listeners.get(event.type)?.(event);
    },
  };
  return element;
}

const registry = new Map();
const controls = createElement('div', registry);
controls.className = 'controls';
const toolboxMore = createElement('div', registry);
toolboxMore.id = 'toolbox-more';
registry.set('toolbox-more', toolboxMore);
const toolboxPanel = createElement('div', registry);
toolboxPanel.className = 'toolbox-panel';
toolboxMore.appendChild(toolboxPanel);
controls.appendChild(toolboxMore);
const rightAside = createElement('aside', registry);
const canvas = createElement('canvas', registry);
canvas.id = 'view';
registry.set('view', canvas);
const body = createElement('body', registry);
body.appendChild(controls);
body.appendChild(rightAside);
body.appendChild(canvas);

globalThis.document = {
  body,
  createElement: (tagName) => createElement(tagName, registry),
  getElementById: (id) => registry.get(id) || null,
  querySelector(selector) {
    if (selector === 'aside.right') return rightAside;
    if (selector === '.controls') return controls;
    if (selector === '#toolbox-more .toolbox-panel') return toolboxPanel;
    return null;
  },
};

const { state } = await import('../js/state.js');
const {
  registerPlugin,
  notifyPluginsSeriesChange,
  notifyPluginsSliceChange,
  drawPluginOverlays,
} = await import('../js/plugin.js');

test('registered plugins receive series and slice lifecycle notifications', () => {
  const seen = [];
  state.seriesIdx = 2;
  state.sliceIdx = 7;

  registerPlugin({
    name: 'test-hook',
    init(api) {
      api.onSeriesChange((seriesIdx) => seen.push(['series', seriesIdx]));
      api.onSliceChange((sliceIdx, seriesIdx) => seen.push(['slice', sliceIdx, seriesIdx]));
    },
  });

  notifyPluginsSeriesChange();
  notifyPluginsSliceChange();

  assert.deepEqual(seen, [
    ['series', 2],
    ['slice', 7, 2],
  ]);
});

test('registered plugins also receive automatic reactive notifications', () => {
  const seen = [];
  state.loaded = false;
  state.seriesIdx = 0;
  state.sliceIdx = 0;

  registerPlugin({
    name: 'test-reactive-hook',
    init(api) {
      api.onSeriesChange((seriesIdx) => seen.push(['series', seriesIdx]));
      api.onSliceChange((sliceIdx, seriesIdx) => seen.push(['slice', sliceIdx, seriesIdx]));
    },
  });

  state.seriesIdx = 3;
  state.sliceIdx = 4;
  state.loaded = true;

  assert.deepEqual(seen, [
    ['slice', 4, 3],
    ['series', 3],
  ]);
});

test('plugins can register toolbar tools, overlays, and export actions', async () => {
  const seen = [];
  const ctx = { marker: [] };

  registerPlugin({
    name: 'tooling-plugin',
    init(api) {
      api.addTool({
        id: 'tooling-plugin-tool',
        icon: 'i-help',
        tip: 'Plugin tool',
        onActivate: () => seen.push('activate'),
        onDeactivate: () => seen.push('deactivate'),
      });
      api.addOverlay({
        id: 'tooling-plugin-overlay',
        render: (canvasCtx, snapshot) => canvasCtx.marker.push(snapshot.sliceIdx),
      });
      api.addExportFormat({
        id: 'tooling-plugin-export',
        label: 'Plugin export',
        export: () => seen.push('export'),
      });
      assert.ok(Object.isFrozen(api.getState()));
      assert.equal(api.getCanvas(), canvas);
      assert.equal(api.getVoxelData(), null);
    },
  });

  const toolButton = registry.get('plugin-tool-tooling-plugin-tool');
  const exportButton = registry.get('plugin-export-tooling-plugin-export');
  assert.ok(toolButton);
  assert.ok(exportButton);

  state.sliceIdx = 9;
  toolButton.click();
  toolButton.click();
  drawPluginOverlays(ctx);
  exportButton.click();

  assert.deepEqual(seen, ['activate', 'deactivate', 'export']);
  assert.deepEqual(ctx.marker, [9]);
});
