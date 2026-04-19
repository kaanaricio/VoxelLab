// Display mode: 2D / MPR / 3D / MPR+3D / Compare + CT 3D presets.
import { state } from './state.js';
import { $ } from './dom.js';
import { THREE_D_PRESETS, CT_WINDOWS } from './constants.js';
import { isMprActive } from './mode-flags.js';
import { drawMPR } from './slice-view.js';
import {
  sync3DScrubber,
  updateUniforms,
  ensureThree,
  setThreeDView,
  ensureVoxels,
  ensureHRVoxels,
  buildVolume,
  syncThreeSurfaceState,
} from './volume-3d.js';
import {
  getGroupPeers,
  buildCompareGrid,
  loadComparePeers,
  drawCompare,
} from './compare.js';
import { updateClipReadouts } from './clip-readouts.js';
import { syncPanelRangeFills } from './panel-range-fills.js';
import { canUseMpr3D, capabilityBlockReason } from './series-capabilities.js';
import { notify } from './notify.js';
import { syncAskModeAfterViewChange } from './consult-ask.js';
import { syncHistogramPanel } from './sparkline.js';
import { getThreeRuntime } from './runtime/viewer-runtime.js';
import { beginPerfTrace } from './perf-trace.js';
import { syncViewerRuntimeSession } from './runtime/viewer-session.js';
import { deactivate2dAuthoringTools } from './two-d-tools.js';
import { setSpinnerPending } from './spinner.js';
import {
  applyViewerPreset,
  setClipRange,
  syncMprSliceIndex,
  setSliceIndex,
  setViewMode as applyViewModeState,
} from './state/viewer-commands.js';

export function setMode(mode) {
  applyViewModeState(mode);
  if (mode !== '2d') deactivate2dAuthoringTools();
  const wrap = $('canvas-wrap');
  const is3d = mode === '3d' || mode === 'mpr3d';
  const isMpr = mode === 'mpr' || mode === 'mpr3d';
  const three = getThreeRuntime();
  wrap.classList.toggle('threeD', mode === '3d');
  wrap.classList.toggle('mpr', mode === 'mpr');
  wrap.classList.toggle('cmp', mode === 'cmp');
  wrap.classList.toggle('mpr3d', mode === 'mpr3d');
  $('three-container').classList.toggle('active', is3d);
  $('btn-3d').classList.toggle('active', is3d);
  $('btn-mpr').classList.toggle('active', isMpr);
  $('btn-compare').classList.toggle('active', mode === 'cmp');
  $('panel-3d').hidden = !is3d;
  if (!is3d) setSpinnerPending('three-surface', false);
  else syncThreeSurfaceState();
  if (is3d) three.requestRender?.('mode-change', 180);
  else three.stopLoop?.();
  syncAskModeAfterViewChange();
  syncHistogramPanel();
}

export function applyThreeDPresetForSeries(slug) {
  const p = THREE_D_PRESETS[slug];
  if (!p) return;
  applyViewerPreset(p);
  const s = $('s-low');
  if (s) s.value = p.lowT;
  const h = $('s-high');
  if (h) h.value = p.highT;
  const g = $('s-gain');
  if (g) g.value = p.intensity;
  document.querySelectorAll('#render-mode .pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.mode === p.mode);
  });
  syncPanelRangeFills();

  const isCT = slug.startsWith('ct_');
  const ctTitle = $('ct-window-title');
  const ctRow = $('ct-window');
  if (ctTitle && ctRow) {
    ctTitle.hidden = !isCT;
    ctRow.hidden = !isCT;
    if (isCT) {
      const active = detectCTWindow(p.lowT, p.highT) || 'soft';
      document.querySelectorAll('#ct-window .pill').forEach((pill) => {
        pill.classList.toggle('active', pill.dataset.window === active);
      });
    }
  }
}

export function detectCTWindow(lowT, highT) {
  for (const [name, w] of Object.entries(CT_WINDOWS)) {
    if (Math.abs(w.lowT - lowT) < 0.02 && Math.abs(w.highT - highT) < 0.02) {
      return name;
    }
  }
  return null;
}

export function setCTWindow(name) {
  const w = CT_WINDOWS[name];
  if (!w) return;
  applyViewerPreset(w);
  const s = $('s-low');
  if (s) s.value = w.lowT;
  const h = $('s-high');
  if (h) h.value = w.highT;
  const g = $('s-gain');
  if (g) g.value = w.intensity;
  document.querySelectorAll('#ct-window .pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.window === name);
  });
  syncPanelRangeFills();
}

export function enter3D() {
  beginPerfTrace('enter-3d', {
    slug: state.manifest.series[state.seriesIdx]?.slug || '',
  });
  const three = getThreeRuntime();
  const series = state.manifest.series[state.seriesIdx];
  const maxSlice = series.slices - 1;
  setSliceIndex(maxSlice, series);
  setClipRange([0, 0, 0], [1, 1, 1]);

  applyThreeDPresetForSeries(series.slug);
  ensureThree();
  setThreeDView('coronal');

  syncThreeSurfaceState(series);

  const hasVoxels = ensureVoxels();
  syncViewerRuntimeSession(series);
  if (hasVoxels) {
    buildVolume().then(() => {
      syncThreeSurfaceState(series);
    });
  }
  sync3DScrubber();
  updateUniforms();
  updateClipReadouts();

  requestAnimationFrame(() => {
    if (three.renderer) ensureThree();
    syncThreeSurfaceState(series);
  });
}

export function enterMPR() {
  beginPerfTrace('enter-mpr', {
    slug: state.manifest.series[state.seriesIdx]?.slug || '',
  });
  const series = state.manifest.series[state.seriesIdx];
  syncMprSliceIndex();
  const hasBaseVolume = ensureVoxels();
  syncViewerRuntimeSession(series);
  if (hasBaseVolume) drawMPR();
  ensureHRVoxels().then(() => syncViewerRuntimeSession(series));
}

export function toggle3D() {
  const cur = state.manifest.series[state.seriesIdx];
  if (!canUseMpr3D(cur)) {
    notify(capabilityBlockReason(cur));
    return;
  }

  if (state.mode === 'mpr3d') {
    setMode('mpr');
  } else if (state.mode === 'mpr') {
    setMode('mpr3d');
    enter3D();
  } else if (state.mode === '3d') {
    setMode('2d');
  } else {
    setMode('3d');
    enter3D();
  }
}

export function toggleMPR() {
  const cur = state.manifest.series[state.seriesIdx];
  if (!canUseMpr3D(cur)) {
    notify(capabilityBlockReason(cur));
    return;
  }

  if (state.mode === 'mpr3d') {
    setMode('3d');
  } else if (state.mode === '3d') {
    setMode('mpr3d');
    enterMPR();
  } else if (state.mode === 'mpr') {
    setMode('2d');
  } else if (isMprActive()) {
    setMode('2d');
  } else {
    setMode('mpr');
    enterMPR();
  }
}

export async function toggleCompare() {
  if (state.mode === 'cmp') { setMode('2d'); return; }
  const peers = getGroupPeers();
  if (peers.length < 2) return;
  setMode('cmp');
  buildCompareGrid();
  await loadComparePeers();
  drawCompare();
}
