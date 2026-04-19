// Computed metadata derived from DICOM tags and pipeline outputs.
// Everything here is general-purpose — no hardcoded body parts,
// modality assumptions, or series-specific logic. All values are
// derived from what exists in the manifest and data files.

import { $, colorSwatchSvg } from './dom.js';
import { state } from './state.js';
import { effectiveSliceSpacing } from './mpr-geometry.js';
import { signalPanelReady } from './collapsible-sidebar.js';

// registration.json: alignment metrics → compare-mode quality dots.
let _regData = null;

export async function loadRegistrationData() {
  try {
    const r = await fetch('./data/registration.json');
    if (r.ok) _regData = await r.json();
  } catch {}
}

export function getRegistrationQuality(slug) {
  if (!_regData) return null;
  const entry = _regData[slug];
  if (!entry) return null;
  const mm = entry.mean_displacement_mm ?? entry.meanDisp;
  if (mm == null) return null;
  // Green < 1mm, yellow 1-3mm, red > 3mm
  const grade = mm < 1 ? 'good' : mm < 3 ? 'fair' : 'poor';
  return { mm: +mm.toFixed(2), grade, dice: entry.dice };
}

// Rough SNR: mean(foreground)/std(background) after Otsu split on normalized voxels.
export function estimateSNR() {
  const series = state.manifest?.series[state.seriesIdx];
  if (!series) return null;
  const vox = state.voxels;
  if (!vox || vox.length === 0) return null;

  // Simple Otsu: split at the valley between background and tissue
  const hist = new Uint32Array(256);
  for (let i = 0; i < vox.length; i++) hist[vox[i]]++;
  const total = vox.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = 0, threshold = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; threshold = i; }
  }

  // Compute mean(foreground) and std(background)
  let fgSum = 0, fgN = 0, bgSum = 0, bgN = 0;
  for (let i = 0; i < vox.length; i++) {
    if (vox[i] > threshold) { fgSum += vox[i]; fgN++; }
    else if (vox[i] > 2) { bgSum += vox[i]; bgN++; } // skip dead zeros
  }
  if (fgN < 100 || bgN < 100) return null;
  const fgMean = fgSum / fgN;
  const bgMean = bgSum / bgN;
  let bgVar = 0;
  for (let i = 0; i < vox.length; i++) {
    if (vox[i] > 2 && vox[i] <= threshold) {
      bgVar += (vox[i] - bgMean) ** 2;
    }
  }
  const bgStd = Math.sqrt(bgVar / bgN);
  if (bgStd < 0.01) return null;
  return Math.round(fgMean / bgStd);
}

export function sliceCoverage() {
  const series = state.manifest?.series[state.seriesIdx];
  if (!series || !series.firstIPP || !series.lastIPP) return null;
  const [fx, fy, fz] = series.firstIPP;
  const [lx, ly, lz] = series.lastIPP;
  const span = Math.sqrt((lx - fx) ** 2 + (ly - fy) ** 2 + (lz - fz) ** 2);
  const nGaps = Math.max(0, series.slices - 1);
  const interSlice = nGaps > 0 ? effectiveSliceSpacing(series) : 0;
  const thickness = series.sliceThickness || interSlice;
  const gap = interSlice - thickness;
  return {
    spanMm: Math.round(span),
    interSliceMm: +interSlice.toFixed(2),
    thicknessMm: thickness,
    gapMm: +Math.max(0, gap).toFixed(2),
    hasGap: gap > 0.5,
  };
}

function regionalVolumesEmptyLine(reason) {
  const hint = reason === 'zeroVolume'
    ? 'Labels did not yield any volume above the reporting threshold.'
    : 'No segmentation sidecar for this series.';
  return `<p class="rp-empty-minimal" role="status">${hint}</p>`;
}

// Persists across re-renders (reactive-sync fires renderVolumeTable on voxel/overlay changes).
// Shape: false (collapsed, default) | true (expanded, user clicked "show all").
let volumeTableExpanded = false;
const VOLUME_TABLE_INITIAL = 20;

export function renderVolumeTable() {
  const host = $('volume-table');
  const volLine = $('volumes-info-line');
  if (!host) return;
  if (!state.regionMeta || !state.regionMeta.regions) {
    if (volLine) volLine.hidden = true;
    host.innerHTML = regionalVolumesEmptyLine('noSidecar');
    return;
  }
  const regions = state.regionMeta.regions;
  const colors = state.regionMeta.colors || {};
  const entries = Object.entries(regions)
    .map(([k, r]) => ({ id: +k, ...r }))
    .filter(e => e.mL > 0)
    .sort((a, b) => b.mL - a.mL);

  if (!entries.length) {
    if (volLine) volLine.hidden = true;
    host.innerHTML = regionalVolumesEmptyLine('zeroVolume');
    return;
  }

  if (volLine) volLine.hidden = false;
  signalPanelReady('region-volumes');
  const totalMl = entries.reduce((s, e) => s + e.mL, 0);
  const hasOverflow = entries.length > VOLUME_TABLE_INITIAL;
  const showAll = hasOverflow && volumeTableExpanded;
  const visible = showAll ? entries : entries.slice(0, VOLUME_TABLE_INITIAL);
  const rowsHtml = visible.map(e => {
    const c = colors[e.id];
    const rgb = c ? `${c[0]},${c[1]},${c[2]}` : '85,85,85';
    const pct = ((e.mL / totalMl) * 100).toFixed(1);
    return `<div class="vol-row">
      ${colorSwatchSvg('vol-swatch', rgb.split(',').map(Number), 8)}
      <span class="vol-name">${e.name}</span>
      <span class="vol-val">${e.mL} mL</span>
      <span class="vol-pct">${pct}%</span>
    </div>`;
  }).join('');
  // Toggle chip lives inline at the end of the list so users can collapse from either end.
  const toggleHtml = hasOverflow
    ? `<button type="button" class="vol-row vol-more" data-vol-toggle>${showAll
      ? 'Show less'
      : `Show all ${entries.length} (${entries.length - VOLUME_TABLE_INITIAL} more)`}</button>`
    : '';
  host.innerHTML = rowsHtml + toggleHtml;

  const toggle = host.querySelector('[data-vol-toggle]');
  if (toggle) {
    toggle.addEventListener('click', () => {
      volumeTableExpanded = !volumeTableExpanded;
      renderVolumeTable();
    });
  }
}

export function metadataSummaryLine() {
  const series = state.manifest?.series[state.seriesIdx];
  if (!series) return '';
  const parts = [];
  if (series.modality) parts.push(series.modality);
  parts.push(`${series.width}×${series.height}×${series.slices}`);
  const cov = sliceCoverage();
  if (cov) {
    parts.push(`${cov.spanMm} mm coverage`);
    if (cov.hasGap) parts.push(`${cov.gapMm} mm gap`);
  }
  const snr = estimateSNR();
  if (snr) parts.push(`SNR ~${snr}`);
  return parts.join(' · ');
}
