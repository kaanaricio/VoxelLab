// Tissue volume stats panel + scrubber jumps from stats links.
import { state } from './state.js';
import { $ } from './dom.js';
import { effectiveSliceSpacing } from './mpr-geometry.js';
import { ensureOverlayStack } from './overlay-stack.js';
import { activeOverlayStateForSeries } from './runtime/active-overlay-state.js';
import { setOverlayEnabled, setSliceIndex } from './state/viewer-commands.js';

export function renderVolumes() {
  const panel = $('volumes-panel');
  const host = $('volumes');
  const series = state.manifest.series[state.seriesIdx];
  const overlays = activeOverlayStateForSeries(series);
  if (!overlays.tissue.available || !state.segVoxels) {
    panel.hidden = true;
    return;
  }
  const voxelMl = (series.pixelSpacing[0] * series.pixelSpacing[1] * effectiveSliceSpacing(series)) / 1000;
  const counts = [0, 0, 0, 0];
  const sv = state.segVoxels;
  for (let i = 0; i < sv.length; i++) counts[sv[i]]++;
  const csfMl = counts[1] * voxelMl;
  const gmMl = counts[2] * voxelMl;
  const wmMl = counts[3] * voxelMl;
  const total = csfMl + gmMl + wmMl;
  if (total === 0) {
    panel.hidden = true;
    return;
  }

  const fmt = (v) => v.toFixed(1);
  const pct = (v) => ((v / total) * 100).toFixed(1);

  let extra = '';
  if (state.stats) {
    if (state.stats.ventricleEstimateMl !== undefined) {
      extra += `<div class="vol-row vol-row-spaced"><span class="vk">Ventricle est.</span><span class="vv">${state.stats.ventricleEstimateMl} mL</span></div>`;
    }
    if (state.stats.wmh && typeof state.stats.wmh.volume_ml === 'number') {
      extra += `<div class="vol-row"><span class="vk">WMH burden</span><span class="vv">${state.stats.wmh.volume_ml.toFixed(1)} mL</span></div>`;
    }
    if (state.stats.microbleeds && typeof state.stats.microbleeds.count === 'number') {
      const mb = state.stats.microbleeds;
      extra += `<div class="vol-row"><span class="vk">Microbleed candidates</span><span class="vv vv-link" id="jump-mb">${mb.count}</span></div>`;
    }
    if (state.stats.symmetryScores && state.stats.symmetryScores.length) {
      const scores = state.stats.symmetryScores;
      let peakZ = 0;
      let peakV = -Infinity;
      for (let z = 0; z < scores.length; z++) {
        if (scores[z] > peakV) {
          peakV = scores[z];
          peakZ = z;
        }
      }
      extra += `<div class="vol-row"><span class="vk">Most asymmetric slice</span><span class="vv vv-link" id="jump-sym">#${peakZ + 1}</span></div>`;
    }
  }

  host.innerHTML = `
    <div class="vol-row"><span class="vk">CSF</span><span class="vv">${fmt(csfMl)} mL · ${pct(csfMl)}%</span></div>
    <div class="vol-row"><span class="vk">Gray matter</span><span class="vv">${fmt(gmMl)} mL · ${pct(gmMl)}%</span></div>
    <div class="vol-row"><span class="vk">White matter</span><span class="vv">${fmt(wmMl)} mL · ${pct(wmMl)}%</span></div>
    <svg class="vol-bar" viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="${pct(csfMl)}" height="2" rx="0.5" fill="rgb(120,144,165)"></rect>
      <rect x="${pct(csfMl)}" y="0" width="${pct(gmMl)}" height="2" rx="0.5" fill="rgb(140,161,140)"></rect>
      <rect x="${(+pct(csfMl) + +pct(gmMl)).toFixed(1)}" y="0" width="${pct(wmMl)}" height="2" rx="0.5" fill="rgb(178,163,124)"></rect>
    </svg>
    <div class="vol-row vol-row-spaced"><span class="vk">Total brain</span><span class="vv">${fmt(total)} mL</span></div>
    ${extra}
    <div class="info-line">
      GMM 3-class segmentation. Approximate, not diagnostic.
    </div>
  `;
  panel.classList.remove('panel-init-hidden');
  panel.hidden = false;

  const jump = $('jump-sym');
  if (jump && state.stats && state.stats.symmetryScores) {
    jump.onclick = () => {
      const scores = state.stats.symmetryScores;
      let peakZ = 0;
      let peakV = -Infinity;
      for (let z = 0; z < scores.length; z++) {
        if (scores[z] > peakV) {
          peakV = scores[z];
          peakZ = z;
        }
      }
      jumpToSlice(peakZ);
      if (!state.useSym && activeOverlayStateForSeries(series).heatmap.available) {
        setOverlayEnabled('useSym', true);
        ensureOverlayStack('sym');
        $('btn-sym').classList.add('active');
      }
    };
  }
  const jumpMb = $('jump-mb');
  if (jumpMb && state.stats && state.stats.microbleeds && state.stats.microbleeds.per_slice) {
    jumpMb.onclick = () => {
      const per = state.stats.microbleeds.per_slice;
      let peakZ = 0;
      let peakV = -1;
      for (let z = 0; z < per.length; z++) {
        if (per[z] > peakV) {
          peakV = per[z];
          peakZ = z;
        }
      }
      jumpToSlice(peakZ);
    };
  }
}

export function jumpToSlice(z) {
  const series = state.manifest.series[state.seriesIdx];
  setSliceIndex(z, series);
}
