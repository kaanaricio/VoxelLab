import { TISSUE_NAMES, CT_HU_LO, CT_HU_RANGE } from './constants.js';
import { adcDisplayFromNorm } from './adc.js';
import { formatLPS, voxelToMM } from './coords.js';
import { escapeHtml } from './dom.js';
import { regionLabelName } from './region-meta.js';
import { state } from './state.js';
import { activeOverlayStateForSeries } from './runtime/active-overlay-state.js';

function voxelIndex(series, vx, vy, vz) {
  return vz * series.width * series.height + vy * series.width + vx;
}

function baseIntensityAt(series, vi) {
  if (state.hrVoxels?.length === series.width * series.height * series.slices) {
    return Math.round(state.hrVoxels[vi] * 255);
  }
  if (state.voxels?.length === series.width * series.height * series.slices) {
    return state.voxels[vi];
  }
  return 0;
}

// Shape: { intensity: 143, voxel: [12, 30, 8], lpsText: "12.0L 4.0P 30.0S", regionName: "Thalamus" }.
export function resolveVoxelInspection(
  series,
  vx,
  vy,
  vz,
  {
    intensity = null,
    tissueLabel = null,
    regionLabel = null,
    regionMeta = null,
    useLiveOverlays = true,
  } = {},
) {
  const vi = voxelIndex(series, vx, vy, vz);
  const overlays = activeOverlayStateForSeries(series);
  const mm = voxelToMM(series, vx, vy, vz);
  const effectiveRegionMeta = regionMeta || overlays.labels.meta;
  const effectiveRegionLabel = regionLabel != null
    ? regionLabel
    : (useLiveOverlays && overlays.labels.voxels ? (state.regionVoxels?.[vi] || 0) : 0);
  const regionName = effectiveRegionMeta?.legend
    ? regionLabelName(effectiveRegionMeta, effectiveRegionLabel)
    : '';
  const effectiveTissueLabel = tissueLabel != null
    ? tissueLabel
    : (useLiveOverlays && overlays.tissue.voxels ? (state.segVoxels?.[vi] || 0) : 0);
  const tissueName = effectiveTissueLabel > 0 && effectiveTissueLabel < 4 ? TISSUE_NAMES[effectiveTissueLabel] : '';
  let ctHu = null;
  if (series.modality === 'CT' && state.hrVoxels?.length === series.width * series.height * series.slices) {
    ctHu = Math.round(state.hrVoxels[vi] * CT_HU_RANGE + CT_HU_LO);
  }
  let adcDisplay = null;
  if (series.slug === 'dwi_adc' && state.stats?.adc && state.hrVoxels?.length === series.width * series.height * series.slices) {
    adcDisplay = adcDisplayFromNorm(state.stats.adc, state.hrVoxels[vi]);
  }
  return {
    intensity: intensity ?? baseIntensityAt(series, vi),
    voxel: [vx, vy, vz],
    mm,
    lpsText: mm ? formatLPS(mm) : '',
    regionName,
    tissueName,
    ctHu,
    adcDisplay,
  };
}

export function renderInspectionReadout(info, { coordLabel = 'px', includeSlice = false } = {}) {
  const [vx, vy, vz] = info.voxel;
  const coordText = includeSlice ? `${vx},${vy},${vz}` : `${vx},${vy}`;
  let html = `<div><span class="hv-label">i</span>${info.intensity}  <span class="hv-label">${coordLabel}</span>${coordText}</div>`;
  if (Number.isFinite(info.ctHu)) html += `<div><span class="hv-label">HU</span>${info.ctHu}</div>`;
  if (Number.isFinite(info.adcDisplay)) {
    html += `<div><span class="hv-label">ADC</span><span class="hv-tissue">${info.adcDisplay.toFixed(2)} ×10⁻³ mm²/s</span></div>`;
  }
  if (info.lpsText) html += `<div><span class="hv-label">mm</span>${info.lpsText}</div>`;
  if (info.regionName) {
    html += `<div><span class="hv-label">region</span><span class="hv-tissue">${escapeHtml(info.regionName)}</span></div>`;
  }
  if (info.tissueName) {
    html += `<div><span class="hv-label">tissue</span><span class="hv-tissue">${escapeHtml(info.tissueName)}</span></div>`;
  }
  return html;
}
