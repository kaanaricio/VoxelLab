// Plugin API — allows external code to extend the viewer with custom
// tools, overlays, panels, and export formats without touching core code.
//
// Usage from a plugin:
//   import { registerPlugin } from './js/plugin.js';
//   registerPlugin({
//     name: 'my-tool',
//     init(api) {
//       api.addPanel({ id: 'my-panel', title: 'My Panel', render: (el) => { ... } });
//       api.addTool({ id: 'my-tool', icon: '🔬', tip: 'My Tool', onActivate: () => { ... } });
//     }
//   });

import { state, subscribe, getStateSnapshot } from './state.js';
import { $ } from './dom.js';
import { getRawSliceData } from './raw-slice-data.js';
import { wireCollapsiblePanels } from './collapsible-sidebar.js';

const plugins = [];
const sliceHooks = new Set();
const seriesHooks = new Set();
const toolRegistry = new Map();
const overlayRegistry = new Map();
const exportRegistry = new Map();
const contextMenuRegistry = new Map();
let activeToolId = '';
let contextMenuBound = false;
let contextMenuHost = null;

// The API object passed to each plugin's init function.
function createPluginAPI(_pluginName) {
  return {
    // Read-only access to viewer state
    getState: () => getStateSnapshot(),
    getManifest: () => state.manifest,
    getCurrentSeries: () => state.manifest?.series[state.seriesIdx],
    getCurrentSlice: () => state.sliceIdx,
    getCanvas: () => $('view'),
    getVoxelData: (sliceIdx = state.sliceIdx) => getRawSliceData(sliceIdx),

    // Register a new panel in the right sidebar
    addPanel({ id, title, render }) {
      const aside = document.querySelector('aside.right');
      if (!aside || $(id)) return;
      const section = document.createElement('div');
      section.className = 'rp-section collapsible collapsed';
      section.dataset.panel = id;
      section.innerHTML = `<div class="sec-title"><span class="sec-title-text"><span>${title}</span></span><span class="rp-collapse-ico" aria-hidden="true"><svg class="rp-collapse-svg"><use href="icons.svg#i-plus"/></svg></span></div><div class="rp-body"><div class="rp-body-inner" id="${id}"></div></div>`;
      aside.appendChild(section);
      wireCollapsiblePanels();
      if (typeof render === 'function') {
        render($(id));
      }
    },

    addTool(definition) {
      return addTool(definition);
    },

    addContextMenuItem(definition) {
      return addContextMenuItem(definition);
    },

    addOverlay(definition) {
      return addOverlay(definition);
    },

    addExportFormat(definition) {
      return addExportFormat(definition);
    },

    // Register a callback for slice changes
    onSliceChange(fn) {
      if (typeof fn !== 'function') return () => {};
      const emit = () => fn(state.sliceIdx, state.seriesIdx);
      sliceHooks.add(emit);
      const unsubscribe = subscribe('sliceIdx', emit);
      return () => {
        sliceHooks.delete(emit);
        unsubscribe();
      };
    },

    // Register a callback for series changes
    onSeriesChange(fn) {
      if (typeof fn !== 'function') return () => {};
      let seenSeriesIdx = state.loaded ? state.seriesIdx : null;
      const emit = () => fn(state.seriesIdx);
      const maybeEmit = () => {
        if (!state.loaded) return;
        if (seenSeriesIdx === state.seriesIdx) return;
        seenSeriesIdx = state.seriesIdx;
        emit();
      };
      seriesHooks.add(emit);
      const unsubscribeSeries = subscribe('seriesIdx', maybeEmit);
      const unsubscribeLoaded = subscribe('loaded', maybeEmit);
      return () => {
        seriesHooks.delete(emit);
        unsubscribeSeries();
        unsubscribeLoaded();
      };
    },
  };
}

export function registerPlugin(plugin) {
  if (!plugin || !plugin.name || !plugin.init) return;
  plugins.push(plugin);
  plugin.init(createPluginAPI(plugin.name));
}

// Called by viewer.js after slice changes — notifies all plugins
export function notifyPluginsSliceChange() {
  for (const emit of sliceHooks) {
    try { emit(); } catch {}
  }
}

// Called by viewer.js after series changes — notifies all plugins
export function notifyPluginsSeriesChange() {
  for (const emit of seriesHooks) {
    try { emit(); } catch {}
  }
}

export function drawPluginOverlays(ctx) {
  const snapshot = getStateSnapshot();
  for (const overlay of overlayRegistry.values()) {
    try {
      overlay.render(ctx, snapshot);
    } catch (error) {
      console.error(`[plugin overlay:${overlay.id}]`, error);
    }
  }
}

function addTool({ id, icon = '', tip = '', onActivate = () => {}, onDeactivate = () => {} }) {
  if (!id || toolRegistry.has(id)) return () => {};
  const group = ensurePluginToolGroup();
  if (!group) return () => {};

  const button = document.createElement('button');
  button.className = 'icon-btn plugin-tool-btn';
  button.type = 'button';
  button.id = `plugin-tool-${id}`;
  if (tip) {
    button.dataset.tip = tip;
    button.setAttribute('aria-label', tip);
  } else {
    button.setAttribute('aria-label', id);
  }
  button.innerHTML = renderToolIcon(icon);
  button.addEventListener('click', () => togglePluginTool(id));
  group.appendChild(button);

  toolRegistry.set(id, { id, button, onActivate, onDeactivate });
  return () => removePluginTool(id);
}

function togglePluginTool(id) {
  if (activeToolId === id) {
    deactivatePluginTool(id);
    activeToolId = '';
    return;
  }
  if (activeToolId) deactivatePluginTool(activeToolId);
  activeToolId = id;
  const tool = toolRegistry.get(id);
  if (!tool) return;
  tool.button.classList.add('active');
  tool.onActivate(getStateSnapshot());
}

function deactivatePluginTool(id) {
  const tool = toolRegistry.get(id);
  if (!tool) return;
  tool.button.classList.remove('active');
  tool.onDeactivate(getStateSnapshot());
}

function removePluginTool(id) {
  if (activeToolId === id) activeToolId = '';
  const tool = toolRegistry.get(id);
  if (!tool) return;
  tool.button.remove();
  toolRegistry.delete(id);
}

function addContextMenuItem({ id, label, condition = () => true, action = () => {} }) {
  if (!id || !label || contextMenuRegistry.has(id)) return () => {};
  contextMenuRegistry.set(id, { id, label, condition, action });
  bindContextMenu();
  return () => contextMenuRegistry.delete(id);
}

function addOverlay({ id, render }) {
  if (!id || typeof render !== 'function' || overlayRegistry.has(id)) return () => {};
  overlayRegistry.set(id, { id, render });
  return () => overlayRegistry.delete(id);
}

function addExportFormat({ id, label, export: runExport }) {
  if (!id || !label || typeof runExport !== 'function' || exportRegistry.has(id)) return () => {};
  const host = ensurePluginExportHost();
  if (!host) return () => {};

  const button = document.createElement('button');
  button.className = 'icon-btn plugin-export-btn';
  button.type = 'button';
  button.id = `plugin-export-${id}`;
  button.textContent = label;
  button.addEventListener('click', async () => {
    try {
      await runExport(getStateSnapshot());
    } catch (error) {
      console.error(`[plugin export:${id}]`, error);
    }
  });
  host.appendChild(button);
  exportRegistry.set(id, { id, button, runExport });
  return () => {
    button.remove();
    exportRegistry.delete(id);
  };
}

function ensurePluginToolGroup() {
  const controls = document.querySelector('.controls');
  if (!controls) return null;
  let host = $('plugin-tool-group');
  if (host) return host;
  host = document.createElement('div');
  host.className = 'tool-group plugin-tool-group';
  host.dataset.tg = 'plugin-tools';
  host.id = 'plugin-tool-group';
  controls.appendChild(host);
  return host;
}

function ensurePluginExportHost() {
  const header = document.querySelector('.viewer-header-actions')
    || document.querySelector('#toolbox-more .toolbox-panel');
  if (!header) return null;
  let host = $('plugin-export-group');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'plugin-export-group';
  host.className = 'plugin-export-group';
  header.appendChild(host);
  return host;
}

function bindContextMenu() {
  if (contextMenuBound) return;
  const canvas = $('view');
  if (!canvas) return;
  contextMenuBound = true;
  canvas.addEventListener('contextmenu', (event) => {
    if (!contextMenuRegistry.size) return;
    const visibleItems = [...contextMenuRegistry.values()].filter((item) => {
      try {
        return item.condition(getStateSnapshot());
      } catch {
        return false;
      }
    });
    if (!visibleItems.length) return;
    event.preventDefault();
    const host = ensureContextMenuHost();
    host.innerHTML = '';
    for (const item of visibleItems) {
      const button = document.createElement('button');
      button.className = 'plugin-context-menu-item';
      button.type = 'button';
      button.textContent = item.label;
      button.addEventListener('click', async () => {
        hideContextMenu();
        await item.action(getStateSnapshot(), { clientX: event.clientX, clientY: event.clientY });
      });
      host.appendChild(button);
    }
    host.style.left = `${event.clientX}px`;
    host.style.top = `${event.clientY}px`;
    host.hidden = false;
  });
  window.addEventListener('click', hideContextMenu);
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideContextMenu();
  });
}

function ensureContextMenuHost() {
  if (contextMenuHost) return contextMenuHost;
  contextMenuHost = document.createElement('div');
  contextMenuHost.id = 'plugin-context-menu';
  contextMenuHost.className = 'plugin-context-menu';
  contextMenuHost.hidden = true;
  document.body.appendChild(contextMenuHost);
  return contextMenuHost;
}

function hideContextMenu() {
  if (contextMenuHost) contextMenuHost.hidden = true;
}

function renderToolIcon(icon) {
  if (String(icon).startsWith('i-')) {
    return `<svg class="ico"><use href="icons.svg#${icon}"/></svg>`;
  }
  return `<span class="plugin-tool-glyph">${icon || 'P'}</span>`;
}
