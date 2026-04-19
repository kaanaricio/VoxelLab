// Global keyboard shortcuts for the viewer (wired from wire-controls.js).

import { $, closeTopModal } from './dom.js';
import { cancelAskQuestionIfOpen } from './consult-ask.js';
import { state } from './state.js';
import { toggleAskMode } from './consult-ask.js';
import { toggle3D, toggleMPR, toggleCompare } from './view-modes.js';
import { drawMeasurements, toggleMeasure } from './measure.js';
import { toggleInvert, zoomToFit } from './viewport.js';
import { toggleCine } from './cine.js';
import {
  cancelROI,
  currentROIMode,
  finalizePolygonROI,
  isROIMode,
  toggleROI,
} from './roi.js';
import { toggleAnnotate } from './annotation.js';
import { takeScreenshot } from './screenshot.js';
import { setSliceIndex } from './state/viewer-commands.js';
import { setMeasurePending } from './state/viewer-tool-commands.js';

/**
 * @param {object} deps
 * @param {HTMLInputElement} deps.scrub
 * @param {(d: number) => void} deps.step
 * @param {(i: number) => void} deps.selectSeries
 * @param {() => void} deps.toggleHelp
 * @param {() => void} deps.autoWindowLevel
 */
export function wireKeyboardShortcuts(deps) {
  const { scrub, step, selectSeries, toggleHelp, autoWindowLevel } = deps;

  window.addEventListener('keydown', (e) => {
    if (e.target.isContentEditable) return;
    if (e.target.tagName === 'TEXTAREA') return;
    if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;

    if (e.key === 'Escape') {
      if (cancelAskQuestionIfOpen()) return;
      if (closeTopModal()) return;
      if (state.measurePending) { setMeasurePending(null); drawMeasurements(); return; }
      if (state.measureMode) { toggleMeasure(); return; }
      if (state.annotateMode) { toggleAnnotate(); return; }
      if (state.askMode) { toggleAskMode(); return; }
      if (isROIMode()) {
        cancelROI(); toggleROI(currentROIMode()); $('view-xform').classList.remove('roi-mode'); return;
      }
    }
    if (e.key === 'Enter' && isROIMode() && currentROIMode() === 'polygon') {
      finalizePolygonROI();
      return;
    }
    if (e.key === '?' || (e.shiftKey && e.key === '/')) { toggleHelp(); return; }

    if (e.key === 'ArrowUp') { step(-1); e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { step(1); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft') { selectSeries((state.seriesIdx - 1 + state.manifest.series.length) % state.manifest.series.length); return; }
    if (e.key === 'ArrowRight') { selectSeries((state.seriesIdx + 1) % state.manifest.series.length); return; }
    if (e.key === 'Home') { setSliceIndex(0); $('scrub').value = 0; scrub.dispatchEvent(new Event('input')); return; }
    if (e.key === 'End') {
      const max0 = state.manifest.series[state.seriesIdx].slices - 1;
      setSliceIndex(max0); $('scrub').value = max0; scrub.dispatchEvent(new Event('input'));
      return;
    }
    if (e.key === ' ') { toggleCine(); e.preventDefault(); return; }
    if (e.key === 'a') { autoWindowLevel(); return; }
    if (e.key === 'i') { toggleInvert(); return; }
    if (e.key === 'f') { zoomToFit(); return; }
    if (e.key === 'r') { $('btn-measure').click(); return; }
    if (e.key === 'g') { $('btn-angle').click(); return; }
    if (e.key === 'n' || e.key === 'N') { $('btn-annot').click(); return; }
    if (e.key === 'k' || e.key === 'K') { $('btn-ask').click(); return; }
    if (e.key === 'e' || e.key === 'E') { $('btn-roi-ell').click(); return; }
    if (e.key === 'p' || e.key === 'P') { $('btn-roi-poly').click(); return; }
    if (e.key === 's') { takeScreenshot(); return; }
    if (e.key === '3') { toggle3D(); return; }
    if (e.key === 'm' || e.key === 'M') { toggleMPR(); return; }
    if (e.key === 'c' || e.key === 'C') { toggleCompare(); return; }
    if (e.key === 'B') { $('btn-brain').click(); return; }
    if (e.key === 'T') { $('btn-seg').click(); return; }
    if (e.key === 'Y') { $('btn-sym').click(); return; }
  });
}
