// Cine: advances state.sliceIdx at state.cineFps; redraws come from state subscribers.

import { $ } from './dom.js';
import { state } from './state.js';
import { stepSlice } from './state/viewer-commands.js';

export function initCine() {}

// Update the filled portion of the custom slider track via CSS var.
// Called anywhere state.sliceIdx changes.
export function updateScrubFill() {
  const scrub = $('scrub');
  if (!scrub) return;
  const max = +scrub.max || 0;
  const pct = max > 0 ? (state.sliceIdx / max) * 100 : 0;
  scrub.style.setProperty('--fill', pct + '%');
}

export function setPlayIcon(playing) {
  const use = document.querySelector('#btn-play use');
  if (use) use.setAttribute('href', playing ? 'icons.svg#i-pause' : 'icons.svg#i-play');
}

export function startCine() {
  if (state.cineTimer) return;
  setPlayIcon(true);
  $('btn-play').classList.add('active');
  let lastFrameTime = 0;
  const loop = (timestamp) => {
    if (!state.cineTimer) return;
    if (!lastFrameTime) lastFrameTime = timestamp;
    const elapsed = timestamp - lastFrameTime;
    const interval = 1000 / state.cineFps;
    if (elapsed >= interval) {
      lastFrameTime = timestamp - (elapsed % interval);
      const total = state.manifest.series[state.seriesIdx].slices;
      stepSlice((state.sliceIdx + 1) % total - state.sliceIdx);
    }
    state.cineTimer = requestAnimationFrame(loop);
  };
  state.cineTimer = requestAnimationFrame(loop);
}

export function stopCine() {
  if (state.cineTimer) {
    cancelAnimationFrame(state.cineTimer);
    state.cineTimer = null;
  }
  setPlayIcon(false);
  $('btn-play').classList.remove('active');
}

export function toggleCine() {
  if (state.cineTimer) stopCine();
  else startCine();
}
