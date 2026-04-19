// Toggles .controls--ready on the bottom toolbar when a series is interactive
// (hides MR window presets + overlay opacity until loading finishes).
import { state } from './state.js';

/** Mirrors CSS skeleton gate (#slice-tot:empty) for assistive tech. */
export function syncSliceCountAriaBusy() {
  if (typeof document === 'undefined') return;
  const ctr = document.querySelector('.ctr-count');
  const tot = document.getElementById('slice-tot');
  if (!ctr || !tot) return;
  const busy = tot.textContent === '';
  ctr.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/** MR W/L row + overlay opacity share .tool-group--wl (no .icon-btn); hide when both rows are hidden. */
export function syncWlToolGroupVisibility() {
  if (typeof document === 'undefined') return;
  const wl = document.querySelector('.tool-group--wl');
  if (!wl) return;
  const mr = document.getElementById('mr-presets');
  const op = document.getElementById('overlay-opacity-wrap');
  const mrHidden = !mr || mr.hidden;
  const opHidden = !op || op.hidden;
  wl.classList.toggle('hidden', mrHidden && opHidden);
}

export function syncToolbarReadyState() {
  if (typeof document === 'undefined') return;
  const controls = document.querySelector('.controls');
  if (!controls) return;
  const ready = !!state.loaded && (state.manifest?.series?.length ?? 0) > 0;
  controls.classList.toggle('controls--ready', ready);
  syncSliceCountAriaBusy();
  syncWlToolGroupVisibility();
}
