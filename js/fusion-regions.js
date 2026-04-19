// Fusion overlay peer picker + anatomical region legend (right sidebar).
import { state } from './state.js';
import { $, escapeHtml, colorSwatchSvg } from './dom.js';
import { getGroupPeers } from './compare.js';
import { loadImageStack } from './series-image-stack.js';
import { syncOverlays } from './sync.js';
import { isMprActive } from './mode-flags.js';
import { clearFusionRuntime, setFusionRuntime } from './runtime/viewer-runtime.js';
import { setFusionSelection } from './state/viewer-commands.js';

export async function loadFusion(peerSlug) {
  if (!peerSlug) {
    setFusionSelection(null);
    clearFusionRuntime();
    return;
  }
  setFusionSelection(peerSlug);
  const peer = state.manifest.series.find((s) => s.slug === peerSlug);
  if (!peer) return;
  const currentIndex = Math.min(state.sliceIdx, peer.slices - 1);
  const { imgs, loaders } = loadImageStack(peer.slug, peer.slices, null, peer, {
    label: `${peer.slug} fusion stack`,
    windowRadius: 5,
    initialIndex: currentIndex,
  });
  setFusionRuntime({ slug: peerSlug, imgs, voxels: null });
  imgs.ensureIndex?.(currentIndex).then(() => {
    if (state.fusionImgs === imgs && state.fusionSlug === peerSlug && state.sliceIdx === currentIndex) {
      syncOverlays();
    }
  });
  Promise.all(loaders).then(() => {
    if (state.fusionImgs === imgs && state.fusionSlug === peerSlug) syncOverlays();
  });
  if (isMprActive()) {
    imgs.prefetchRemaining?.(currentIndex, 5).then(() => {
      setFusionRuntime({ slug: peerSlug, imgs, voxels: null });
      syncOverlays();
    });
  }
}

export function renderFusionPicker() {
  const panel = $('fusion-panel');
  const sel = $('fusion-select');
  if (!panel || !sel) return;
  const peers = getGroupPeers().filter(
    (p) => p.slug !== state.manifest.series[state.seriesIdx].slug,
  );
  if (peers.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  sel.innerHTML = `<option value="">None</option>`
    + peers.map((p) => `<option value="${p.slug}" ${p.slug === state.fusionSlug ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
}

export function renderRegionLegend() {
  const panel = $('regions-panel');
  const host = $('regions-legend');
  if (!panel || !host) return;
  if (!state.regionMeta || !state.regionMeta.regions) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const rs = state.regionMeta.regions;
  const rows = Object.entries(rs)
    .filter(([, r]) => r.mL >= 0.1)
    .sort((a, b) => (b[1].mL || 0) - (a[1].mL || 0))
    .map(([, r]) => {
      return `
        <div class="legend-row">
          ${colorSwatchSvg('swatch', r.color)}
          <span class="lk">${escapeHtml(r.name)}</span>
          <span class="lv">${r.mL.toFixed(1)} mL</span>
        </div>
      `;
    }).join('');
  const legendDisclaimer = `
    <div class="info-line">
      Approximate regions from brain mask + tissue classes + geometry.
      Not real anatomical segmentation. Use for orientation, not measurement.
    </div>
  `;
  if (!rows) {
    host.innerHTML = `
      <p class="rp-empty-minimal" role="status">No regions above the display threshold.</p>
      ${legendDisclaimer}`;
    return;
  }
  host.innerHTML = rows + legendDisclaimer;
}
