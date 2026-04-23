// Sidebar-readout text for 3D transfer + clip sliders.
import { state } from './state.js';
import { $ } from './dom.js';
import { syncPanelRangeFills } from './panel-range-fills.js';

export function updateClipReadouts() {
  const p = (v) => Math.round(v * 100);
  const rng = (a, b) => `${p(a)}–${p(b)}%`;
  $('readout-low').textContent = p(state.lowT) + '%';
  $('readout-high').textContent = p(state.highT) + '%';
  $('readout-gain').textContent = state.intensity.toFixed(2);
  // Sync slider positions with state (e.g. after preset changes)
  const sLow = $('s-low'); if (sLow) sLow.value = state.lowT;
  const sHigh = $('s-high'); if (sHigh) sHigh.value = state.highT;
  const sGain = $('s-gain'); if (sGain) sGain.value = state.intensity;
  syncPanelRangeFills();
  $('readout-clipx').textContent = rng(state.clipMin[0], state.clipMax[0]);
  $('readout-clipy').textContent = rng(state.clipMin[1], state.clipMax[1]);
  $('readout-clipz').textContent = rng(state.clipMin[2], state.clipMax[2]);
}
