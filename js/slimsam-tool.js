// SlimSAM click-to-segment tool. When active, clicking on the 2D canvas
// runs the SlimSAM decoder on the clicked point and overlays the
// resulting segmentation mask.
//
// Requires precomputed embeddings (run slimsam_embed.py). If embeddings
// don't exist for the current series, the tool shows a helpful message
// instead of silently failing.

import { state } from './state.js';
import { $ } from './dom.js';
import { initSlimSAM, isSlimSAMAvailable, runSlimSAMClick, overlayMask } from './slimsam.js';
import { notify, dismissNotify } from './notify.js';

let _active = false;
let _drawSlice = () => {};
let _lastMask = null;

export function initSlimSAMTool({ drawSlice }) {
  _drawSlice = drawSlice;
  if (state.manifest) initSlimSAM(state.manifest);
}

export function isSlimSAMMode() { return _active; }

export function setSlimSAMMode(active) {
  _active = !!active;
  const btn = $('btn-slimsam');
  if (btn) btn.classList.toggle('active', _active);
  if (!_active) {
    _lastMask = null;
    _drawSlice(); // clear mask overlay
  }
  return _active;
}

export function toggleSlimSAM() {
  if (state.mode !== '2d' && !_active) return false;
  return setSlimSAMMode(!_active);
}

export async function onSlimSAMClick(ev, clientToCanvasPx) {
  if (!_active || state.mode !== '2d') return;

  const [px, py] = clientToCanvasPx(ev.clientX, ev.clientY);
  const series = state.manifest.series[state.seriesIdx];

  // Check if embeddings exist
  const available = await isSlimSAMAvailable(state.seriesIdx);
  if (!available) {
    notify('No SlimSAM embeddings for this series.', {
      command: `python3 slimsam_embed.py ${series.slug}`,
      duration: 8000,
    });
    return;
  }

  notify('SlimSAM segmenting...', { id: 'slimsam', progress: true });

  try {
    const result = await runSlimSAMClick(px, py, state.sliceIdx, state.seriesIdx);
    if (!result || !result.mask) {
      dismissNotify('slimsam');
      notify('No mask returned — try a different area', { duration: 3000 });
      return;
    }

    _lastMask = result;
    _drawSlice();
    drawSlimSAMMask();
    dismissNotify('slimsam');
    notify(`SlimSAM segmented (${result.width}×${result.height})`, { duration: 2000 });
  } catch (e) {
    dismissNotify('slimsam');
    notify('SlimSAM error: ' + e.message, { duration: 5000 });
  }
}

// Called after drawSlice to overlay the SlimSAM mask on the canvas
export function drawSlimSAMMask() {
  if (!_lastMask || !_active) return;
  const canvas = $('view');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  overlayMask(ctx, _lastMask, {
    color: [64, 180, 255], // cyan-blue
    opacity: 0.35,
  });
}

// Clear mask when slice changes
export function onSliceChange() {
  _lastMask = null;
}

// Old showSlimSAMStatus removed — replaced by notify() from js/notify.js
