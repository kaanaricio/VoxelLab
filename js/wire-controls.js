// DOM event wiring: toolbar, canvas, MPR panels, keyboard shortcuts.
import { state } from './state.js';
import { $, escapeHtml, showDialog, initModals } from './dom.js';
import { loadFusion } from './fusion-regions.js';
import {
  toggleAskMode,
  runConsult,
} from './consult-ask.js';
import {
  setCTWindow,
  toggle3D,
  toggleMPR,
  toggleCompare,
} from './view-modes.js';
import { exportDicomSR } from './dicom_sr.js';
import {
  toggleROI, isROIMode, currentROIMode, cancelROI,
} from './roi.js';
import {
  updateScrubFill as _updateScrubFill, startCine, stopCine, toggleCine,
} from './cine.js';
import { toggleMeasure } from './measure.js';
import { drawCompare, loadComparePeers, buildCompareMenu, getGroupPeers } from './compare.js';
import {
  toggleAnnotate,
  renderAnnotationList,
} from './annotation.js';
import { toggleInvert, zoomToFit, applyMRPreset } from './viewport.js';
import { toggleAngle, isAngleMode } from './angle.js';
import { COLORMAPS, setColormap } from './colormap.js';
import { is3dActive } from './mode-flags.js';
import { clearCurrentSliceDrawings } from './clear-slice-drawings.js';
import { ensureOverlayStack } from './overlay-stack.js';
import { loadImageStack } from './series-image-stack.js';
import { rememberPreferredOverlay, forgetPreferredOverlay } from './overlay-preferences.js';
import { syncOverlays } from './sync.js';
import { takeScreenshot } from './screenshot.js';
import { showStudyUploadModal } from './study-upload-modal.js';
import { initSlimSAMTool, isSlimSAMMode, toggleSlimSAM } from './slimsam-tool.js';
import {
  sync3DScrubber as _sync3DScrubber,
  updateUniforms,
  setThreeDView,
  ensureVoxels,
  ensureHRVoxels,
  buildVolume,
  updateLabelTexture,
} from './volume-3d.js';
import {
  updateSliceDisplay as _updateSliceDisplay,
  drawSlice,
} from './slice-view.js';
import { drawSparkline as _drawSparkline } from './sparkline.js';
import { drawMeasurements as _drawMeasurements } from './measure.js';
import { wireKeyboardShortcuts } from './wire-controls-keyboard.js';
import { wireMprPanel } from './wire-controls-mpr-panel.js';
import { wireViewCanvas } from './wire-controls-view-canvas.js';
import {
  setBrainStack,
  setCineFps,
  setClipAxis,
  setFusionOpacity,
  setLoaded,
  setOverlayEnabled,
  setOverlayOpacity,
  setRenderMode,
  setSliceIndex,
  setVolumeTransfer,
} from './state/viewer-commands.js';
import { syncToolbarReadyState } from './toolbar-chrome.js';
import { invalidateVoxelCache } from './runtime/viewer-runtime.js';
import { beginPerfTrace } from './perf-trace.js';
import { activeOverlayStateForSeries } from './runtime/active-overlay-state.js';

export function wireControls(deps) {
  const {
    selectSeries,
    autoWindowLevel,
    toggleHelp,
    hideHover,
    applyPreset,
    step,
    clientToCanvasPx,
  } = deps;

  initModals();

  const scrub = $('scrub');
  let _scrubRAF = 0;
  let _pendingSliceIdx = state.sliceIdx;
  scrub.addEventListener('input', () => {
    _pendingSliceIdx = +scrub.value;
    stopCine();
    if (_scrubRAF) return;           // coalesce: one redraw per frame
    _scrubRAF = requestAnimationFrame(() => {
      _scrubRAF = 0;
      setSliceIndex(_pendingSliceIdx);
    });
  });

  const zScrub = $('s-zscrub');
  if (zScrub) {
    let _zScrubRAF = 0;
    let _pendingZIdx = state.sliceIdx;
    zScrub.addEventListener('input', () => {
      _pendingZIdx = +zScrub.value;
      stopCine();
      if (_zScrubRAF) return;
      _zScrubRAF = requestAnimationFrame(() => {
        _zScrubRAF = 0;
        setSliceIndex(_pendingZIdx);
      });
    });
  }

  $('sparkline').addEventListener('click', (e) => {
    if (!state.stats || !state.stats.symmetryScores) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    const n = state.stats.symmetryScores.length;
    setSliceIndex(Math.max(0, Math.min(n - 1, Math.floor(frac * n))));
  });

  $('btn-play').onclick = toggleCine;
  $('fps').addEventListener('input', (e) => {
    setCineFps(e.target.value);
    $('fps-val').textContent = state.cineFps;
    if (state.cineTimer) { stopCine(); startCine(); }
  });

  $('btn-upload').onclick = () => showStudyUploadModal(selectSeries);

  $('btn-auto').onclick = autoWindowLevel;
  $('btn-invert').onclick = toggleInvert;

  const cmapTrigger = $('cmap-trigger');
  const cmapMenu = $('cmap-menu');
  const cmapDropdown = $('cmap-dropdown');
  for (const [name, cm] of Object.entries(COLORMAPS)) {
    const item = document.createElement('div');
    item.className = 'dd-item' + (name === 'grayscale' ? ' active' : '');
    item.dataset.value = name;
    item.textContent = cm.label;
    item.addEventListener('click', () => {
      setColormap(name);
      $('cmap-label').textContent = cm.label;
      cmapMenu.querySelectorAll('.dd-item').forEach((el) => el.classList.toggle('active', el.dataset.value === name));
      cmapDropdown.classList.remove('open');
      syncOverlays();
    });
    cmapMenu.appendChild(item);
  }
  const closePopups = () => {
    document.querySelectorAll('.custom-dropdown.open, .toolbox.open')
      .forEach((el) => el.classList.remove('open'));
    cmapTrigger.setAttribute('aria-expanded', 'false');
  };

  cmapTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = cmapDropdown.classList.contains('open');
    closePopups();
    if (!wasOpen) {
      cmapDropdown.classList.add('open');
      cmapTrigger.setAttribute('aria-expanded', 'true');
    }
  });
  document.addEventListener('click', closePopups);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopups();
  });

  // Toolbox triggers — click to toggle floating panel
  document.querySelectorAll('.toolbox-trigger').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const box = trigger.closest('.toolbox');
      const wasOpen = box.classList.contains('open');
      closePopups();
      if (!wasOpen) box.classList.add('open');
    });
  });
  // Clicks inside a toolbox panel should not close it
  document.querySelectorAll('.toolbox-panel').forEach((panel) => {
    panel.addEventListener('click', (e) => e.stopPropagation());
  });

  // Keep toolbox trigger dot badges in sync when panel tools gain/lose .active.
  // Only .toolbox-panel .icon-btn count — avoids stray .icon-btn nodes and matches
  // the “something in this flyout is on” intent. Skips mutations on triggers only
  // (has-active toggles) to limit feedback loops.
  const syncToolboxBadges = () => {
    document.querySelectorAll('.toolbox').forEach((box) => {
      const trigger = box.querySelector('.toolbox-trigger');
      const panel = box.querySelector('.toolbox-panel');
      if (!trigger || !panel) return;
      const anyActive = [...panel.querySelectorAll('.icon-btn')].some((b) =>
        b.classList.contains('active') && !b.classList.contains('hidden'));
      trigger.classList.toggle('has-active', anyActive);
    });
  };
  let _badgeRaf = 0;
  new MutationObserver((mutations) => {
    if (mutations.every((m) => m.target.closest?.('.toolbox-trigger'))) return;
    if (_badgeRaf) return;
    _badgeRaf = requestAnimationFrame(() => { _badgeRaf = 0; syncToolboxBadges(); });
  }).observe(
    document.querySelector('.controls'),
    { subtree: true, attributes: true, attributeFilter: ['class'] },
  );
  syncToolboxBadges();
  requestAnimationFrame(() => syncToolboxBadges());

  $('overlay-opacity').addEventListener('input', (e) => {
    setOverlayOpacity(e.target.value);
  });

  document.querySelectorAll('#mr-presets [data-mrpreset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyMRPreset(btn.dataset.mrpreset);
      document.querySelectorAll('#mr-presets [data-mrpreset]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  $('btn-zoomfit').onclick = zoomToFit;
  $('btn-clear').onclick = clearCurrentSliceDrawings;
  $('btn-angle').onclick = () => {
    deactivateOthers('angle');
    toggleAngle();
  };
  $('btn-shot').onclick = takeScreenshot;
  $('btn-consult').onclick = () => runConsult(false);
  $('btn-sr').onclick = async () => {
    try {
      const { count, filename } = await exportDicomSR(state);
      showDialog('DICOM SR exported', `
        <div class="dlg-body">Saved ${count} measurement${count > 1 ? 's' : ''} as <code>${escapeHtml(filename)}</code>.</div>
        <div class="dlg-sub">TID 1500-style research export for downstream inspection. Validate semantics in your target viewer before relying on round-trip interoperability.</div>
      `);
    } catch (err) {
      showDialog('Export failed', `
        <div class="dlg-body-err">${escapeHtml(err.message)}</div>
      `);
    }
  };

  // Init SlimSAM tool
  initSlimSAMTool({ drawSlice });
  const slimsamBtn = $('btn-slimsam');
  if (slimsamBtn) {
    slimsamBtn.onclick = () => {
      deactivateOthers('slimsam');
      toggleSlimSAM();
    };
  }

  const deactivateOthers = (except) => {
    if (except !== 'measure' && state.measureMode) toggleMeasure();
    if (except !== 'angle' && isAngleMode()) toggleAngle();
    if (except !== 'slimsam' && isSlimSAMMode()) toggleSlimSAM();
    if (except !== 'annotate' && state.annotateMode) toggleAnnotate();
    if (except !== 'ask' && state.askMode) toggleAskMode();
    if (except !== 'roi' && isROIMode()) { cancelROI(); toggleROI(currentROIMode()); }
  };
  $('btn-measure').onclick = () => {
    deactivateOthers('measure');
    toggleMeasure();
  };
  $('btn-annot').onclick = () => {
    deactivateOthers('annotate');
    toggleAnnotate();
    renderAnnotationList();
  };
  $('btn-ask').onclick = () => {
    deactivateOthers('ask');
    toggleAskMode();
  };
  $('btn-roi-ell').onclick = () => {
    deactivateOthers('roi');
    toggleROI('ellipse');
    $('btn-roi-ell').classList.toggle('active', currentROIMode() === 'ellipse');
    $('btn-roi-poly').classList.toggle('active', false);
    $('view-xform').classList.toggle('roi-mode', isROIMode());
  };
  $('btn-roi-poly').onclick = () => {
    deactivateOthers('roi');
    toggleROI('polygon');
    $('btn-roi-poly').classList.toggle('active', currentROIMode() === 'polygon');
    $('btn-roi-ell').classList.toggle('active', false);
    $('view-xform').classList.toggle('roi-mode', isROIMode());
  };

  $('btn-help').onclick = toggleHelp;

  // Seg and regions are mutually exclusive; sym is independent.
  // Shared toggle: flip state, deactivate the rival if exclusive, load stack, redraw.
  const toggleLabelOverlay = (type, stateKey, hasKey, exclusive) => {
    const s = state.manifest.series[state.seriesIdx];
    const overlays = activeOverlayStateForSeries(s);
    const kind = {
      hasSeg: 'tissue',
      hasRegions: 'labels',
      hasSym: 'heatmap',
    }[hasKey];
    if (!kind || !overlays[kind]?.available) return;
    const next = !state[stateKey];
    setOverlayEnabled(stateKey, next, exclusive);
    if (next) {
      beginPerfTrace('overlay-toggle-paint', {
        slug: s?.slug || '',
        overlay: type,
      });
    }
    // Track preferred overlays per modality for prefetch on later series opens.
    if (next) {
      rememberPreferredOverlay(s.modality, type);
    } else {
      forgetPreferredOverlay(s.modality, type);
    }
    syncOverlays();
    if (next) {
      ensureOverlayStack(type)?.then(() => {
        if (state[stateKey]) syncOverlays();
      });
    }
    const nextOverlays = activeOverlayStateForSeries(s);
    $('btn-seg')?.classList.toggle('active', nextOverlays.tissue.enabled);
    $('btn-regions')?.classList.toggle('active', nextOverlays.labels.enabled);
    $('btn-sym')?.classList.toggle('active', nextOverlays.heatmap.enabled);
    if (is3dActive()) { invalidateVoxelCache(); if (ensureVoxels()) updateLabelTexture(); }
    if (state.mode === 'cmp') {
      loadComparePeers().then(() => drawCompare());
    }
  };
  $('btn-regions').onclick = () => toggleLabelOverlay('regions', 'useRegions', 'hasRegions', ['useSeg']);
  $('btn-seg').onclick     = () => toggleLabelOverlay('seg',     'useSeg',     'hasSeg',     ['useRegions']);
  $('btn-sym').onclick     = () => toggleLabelOverlay('sym',     'useSym',     'hasSym');

  $('fusion-select').addEventListener('change', (e) => loadFusion(e.target.value || null));
  $('fusion-opacity').addEventListener('input', (e) => {
    setFusionOpacity(e.target.value);
    $('fusion-opacity-val').textContent = Math.round(state.fusionOpacity * 100) + '%';
  });

  document.querySelectorAll('#render-mode .pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#render-mode .pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      setRenderMode(pill.dataset.mode);
    });
  });

  document.querySelectorAll('#ct-window .pill').forEach((pill) => {
    pill.addEventListener('click', () => setCTWindow(pill.dataset.window));
  });

  document.querySelectorAll('.preset-btn[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => setThreeDView(btn.dataset.view));
  });

  $('btn-3d').onclick = toggle3D;
  $('btn-mpr').onclick = toggleMPR;
  // Compare: left-click toggles mode if peers exist, opens picker otherwise.
  // Right-click always opens the series picker menu.
  const cmpDropdown = $('cmp-dropdown');
  const cmpMenu = $('cmp-menu');
  $('btn-compare').addEventListener('click', (e) => {
    e.stopPropagation();
    const peers = getGroupPeers();
    if (peers.length >= 2) {
      cmpDropdown.classList.remove('open');
      toggleCompare();
    } else if (state.manifest.series.length >= 2) {
      // No auto-peers — open picker so the user can choose
      buildCompareMenu(cmpMenu);
      const wasOpen = cmpDropdown.classList.contains('open');
      closePopups();
      if (!wasOpen) cmpDropdown.classList.add('open');
    }
  });
  $('btn-compare').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.manifest.series.length < 2) return;
    buildCompareMenu(cmpMenu);
    const wasOpen = cmpDropdown.classList.contains('open');
    closePopups();
    if (!wasOpen) cmpDropdown.classList.add('open');
  });
  $('btn-brain').onclick = async () => {
    const s = state.manifest.series[state.seriesIdx];
    if (!s.hasBrain) return;
    const nextUseBrain = !state.useBrain;
    const variant = nextUseBrain ? `${s.slug}_brain` : s.slug;
    const { imgs, loaders } = loadImageStack(variant, s.slices, state.imgs, s);
    setBrainStack({ nextUseBrain, imgs });
    $('btn-brain').classList.toggle('active', state.useBrain);

    if (loaders.length) await loaders[Math.min(state.sliceIdx, loaders.length - 1)];
    setLoaded(true);
    syncToolbarReadyState();

    Promise.all(loaders).then(() => {
      if (is3dActive()) {
        if (ensureVoxels()) buildVolume();
        updateUniforms();
      }
      if (state.mode === 'cmp') {
        loadComparePeers().then(() => drawCompare());
      }
      ensureHRVoxels();
    });
  };
  wireMprPanel({ hideHover });

  const bind = (id, apply) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      apply(+el.value);
    });
  };
  bind('s-low', (v) => { setVolumeTransfer({ lowT: v }); });
  bind('s-high', (v) => { setVolumeTransfer({ highT: v }); });
  bind('s-gain', (v) => { setVolumeTransfer({ intensity: v }); });
  bind('s-xmin', (v) => { setClipAxis('min', 0, v); });
  bind('s-xmax', (v) => { setClipAxis('max', 0, v); });
  bind('s-ymin', (v) => { setClipAxis('min', 1, v); });
  bind('s-ymax', (v) => { setClipAxis('max', 1, v); });

  $('preset-full').onclick = () => applyPreset({ lowT: 0.08, highT: 1.0, clipMin: [0, 0, 0], clipMax: [1, 1, 1] });
  $('preset-surface').onclick = () => applyPreset({ lowT: 0.25, highT: 1.0, clipMin: [0, 0, 0], clipMax: [1, 1, 1] });
  $('preset-inside').onclick = () => applyPreset({ lowT: 0.08, highT: 0.6, clipMin: [0, 0, 0], clipMax: [1, 1, 1] });
  $('preset-halfx').onclick = () => applyPreset({ lowT: state.lowT, highT: state.highT, clipMin: [0, 0, 0], clipMax: [0.5, 1, 1] });
  $('preset-halfy').onclick = () => applyPreset({ lowT: state.lowT, highT: state.highT, clipMin: [0, 0, 0], clipMax: [1, 0.5, 1] });
  $('preset-reset').onclick = () => applyPreset({ lowT: 0.08, highT: 1.0, intensity: 1.6, clipMin: [0, 0, 0], clipMax: [1, 1, 1] });

  wireViewCanvas({ clientToCanvasPx, step, hideHover });

  wireKeyboardShortcuts({
    scrub,
    step,
    selectSeries,
    toggleHelp,
    autoWindowLevel,
  });
}
