import * as THREE from './vendor-three.js';

import { REGION_OPACITY, TISSUE_OPACITY } from './constants.js';
import { $, escapeHtml, colorSwatchSvg } from './dom.js';
import { state } from './state.js';
import { setHiddenLabels } from './state/viewer-tool-commands.js';
import { getThreeRuntime } from './runtime/viewer-runtime.js';
import { activeThreeLabelOverlay } from './runtime/active-overlay-state.js';

// Swap the label texture + color LUT based on the currently-active overlay
// toggles. Called whenever the user flips Tissue or Anatomy while 3D mode
// is live, and from buildVolume() after the main texture is uploaded.
export function updateLabelTexture() {
  if (!state.threeRuntime.mesh) return;
  const u = state.threeRuntime.mesh.material.uniforms;
  const series = state.manifest.series[state.seriesIdx];
  const selected = activeThreeLabelOverlay(series);
  let { mode, source, colors } = selected;
  let opacities = null;
  if (mode === 2) opacities = REGION_OPACITY;
  if (mode === 1) opacities = TISSUE_OPACITY;

  const lut = u.uLabelLUT.value.image.data;
  for (let i = 0; i < lut.length; i += 4) {
    lut[i] = 0; lut[i + 1] = 0; lut[i + 2] = 0; lut[i + 3] = 255;
  }

  if (mode === 0 || !source) {
    u.uLabelMode.value = 0;
    u.uLabelLUT.value.needsUpdate = true;
    getThreeRuntime().requestRender?.('label-off', 120);
    return;
  }

  const W = series.width, H = series.height, D = series.slices;
  if (source.length !== W * H * D) {
    u.uLabelMode.value = 0;
    u.uLabelLUT.value.needsUpdate = true;
    getThreeRuntime().requestRender?.('label-mismatch', 120);
    return;
  }

  if (u.uLabel.value) u.uLabel.value.dispose();
  const lt = new THREE.Data3DTexture(source, W, H, D);
  lt.format = THREE.RedFormat;
  lt.type = THREE.UnsignedByteType;
  lt.minFilter = THREE.NearestFilter;
  lt.magFilter = THREE.NearestFilter;
  lt.unpackAlignment = 1;
  lt.needsUpdate = true;
  u.uLabel.value = lt;
  u.uLabelMode.value = mode;

  if (colors) {
    for (const k in colors) {
      const idx = +k;
      if (!Number.isFinite(idx) || idx < 0 || idx > 255) continue;
      const c = colors[k];
      if (!c) continue;
      const base = idx * 4;
      lut[base]     = c[0];
      lut[base + 1] = c[1];
      lut[base + 2] = c[2];
      lut[base + 3] = 255;
    }
  }
  if (opacities) {
    for (const k in opacities) {
      const idx = +k;
      if (!Number.isFinite(idx) || idx < 0 || idx > 255) continue;
      lut[idx * 4 + 3] = Math.round(opacities[k] * 255);
    }
  }
  for (const idx of state.hiddenLabels || []) {
    if (idx >= 0 && idx < 256) lut[idx * 4 + 3] = 0;
  }
  u.uLabelLUT.value.needsUpdate = true;
  updateLabelList(mode, colors);
  getThreeRuntime().requestRender?.('label-texture', 160);
}

function updateLabelList(mode, colors) {
  const wrap = $('label-list-wrap');
  const host = $('label-list');
  if (!wrap || !host) return;

  if (mode !== 2 || !state.regionMeta || !state.regionMeta.regions) {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  const regions = state.regionMeta.regions;
  const entries = Object.entries(regions)
    .map(([k, r]) => ({ id: +k, ...r }))
    .sort((a, b) => (b.mL || 0) - (a.mL || 0));

  host.innerHTML = entries.map(e => {
    const c = colors && colors[e.id];
    const checked = !state.hiddenLabels.has(e.id);
    return `
      <label class="ui-checkbox ${checked ? '' : 'off'}" data-lid="${e.id}">
        ${colorSwatchSvg('ll-swatch', c || [85, 85, 85])}
        <span class="label-list-text"><span class="label-list-name">${escapeHtml(e.name || '')}</span>${e.mL != null && e.mL !== '' ? `<span class="label-list-meta"> · ${escapeHtml(String(e.mL))} mL</span>` : ''}</span>
        <span class="ui-checkbox-toggle">
          <input type="checkbox" class="ui-checkbox-input" ${checked ? 'checked' : ''} />
          <span class="ui-checkbox-box" aria-hidden="true"></span>
        </span>
      </label>`;
  }).join('');

  host.querySelectorAll('label').forEach(el => {
      const cb = el.querySelector('input');
      cb.addEventListener('change', () => {
        const lid = +el.dataset.lid;
        const hidden = new Set(state.hiddenLabels || []);
        if (cb.checked) {
          hidden.delete(lid);
          el.classList.remove('off');
        } else {
          hidden.add(lid);
          el.classList.add('off');
        }
        setHiddenLabels(hidden);
        if (state.threeRuntime.mesh) {
          const u = state.threeRuntime.mesh.material.uniforms;
          const lut = u.uLabelLUT.value.image.data;
        if (cb.checked) {
          const c = colors && colors[lid];
          if (c) {
            lut[lid * 4 + 3] = 255;
          }
        } else {
          lut[lid * 4 + 3] = 0;
        }
        u.uLabelLUT.value.needsUpdate = true;
        getThreeRuntime().requestRender?.('label-visibility', 120);
      }
    });
  });
}
