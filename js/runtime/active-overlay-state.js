import { COLORMAPS } from '../colormap.js';
import { SEG_PALETTE } from '../constants.js';
import { state } from '../state.js';
import { overlayKindsForSeries } from './overlay-kinds.js';

// Shape: { available: true, enabled: false, ready: false, voxels: Uint8Array(...) }.
function describeOverlayKind(kind, base = {}) {
  if (kind === 'tissue') {
    return {
      available: !!base.available,
      enabled: !!base.available && !!state.useSeg,
      ready: !!base.available && !!state.segVoxels,
      voxels: state.segVoxels,
      imgs: state.segImgs,
      meta: null,
    };
  }
  if (kind === 'labels') {
    return {
      available: !!base.available,
      enabled: !!base.available && !!state.useRegions,
      ready: !!base.available && !!state.regionVoxels && !!state.regionMeta,
      voxels: state.regionVoxels,
      imgs: state.regionImgs,
      meta: state.regionMeta,
    };
  }
  if (kind === 'heatmap') {
    return {
      available: !!base.available,
      enabled: !!base.available && !!state.useSym,
      ready: !!base.available && !!state.symVoxels,
      voxels: state.symVoxels,
      imgs: state.symImgs,
      meta: null,
    };
  }
  return {
    available: !!state.fusionSlug,
    enabled: !!state.fusionSlug,
    ready: !!state.fusionVoxels,
    voxels: state.fusionVoxels,
    imgs: state.fusionImgs,
    meta: null,
  };
}

function colorsFromLut(lut) {
  const colors = {};
  for (let i = 1; i < 256; i++) {
    const base = i * 4;
    colors[i] = [lut[base], lut[base + 1], lut[base + 2]];
  }
  return colors;
}

function opacityTable(alpha) {
  const value = Math.max(0, Math.min(1, Number(alpha) || 0));
  const opacities = {};
  for (let i = 1; i < 256; i++) opacities[i] = value;
  return opacities;
}

let tissueColors = null;
let hotLutColors = null;

function getTissueColors() {
  if (!tissueColors) tissueColors = Object.fromEntries(Object.entries(SEG_PALETTE).map(([key, value]) => [key, value.slice(0, 3)]));
  return tissueColors;
}

function getHotLutColors() {
  if (!hotLutColors) hotLutColors = colorsFromLut(COLORMAPS.hot.lut);
  return hotLutColors;
}


// Shape: { tissue: { available: true }, labels: { available: false } }.
export function activeOverlayStateForSeries(series = state.manifest?.series?.[state.seriesIdx]) {
  const described = overlayKindsForSeries(series).byKind;
  return {
    tissue: describeOverlayKind('tissue', described.tissue),
    labels: describeOverlayKind('labels', described.labels),
    heatmap: describeOverlayKind('heatmap', described.heatmap),
    fusion: describeOverlayKind('fusion', described.fusion),
  };
}

// Shape: { mode: 2, source: Uint8Array(...), colors: { 4: [255, 0, 0] } }.
export function activeThreeLabelOverlay(series = state.manifest?.series?.[state.seriesIdx]) {
  const overlays = activeOverlayStateForSeries(series);
  if (overlays.labels.enabled && overlays.labels.voxels && overlays.labels.meta) {
    return {
      mode: 2,
      source: overlays.labels.voxels,
      colors: overlays.labels.meta.colors || {},
      opacities: null,
      legend: overlays.labels.meta.regions || null,
    };
  }
  if (overlays.tissue.enabled && overlays.tissue.voxels) {
    return {
      mode: 1,
      source: overlays.tissue.voxels,
      colors: getTissueColors(),
      opacities: null,
      legend: null,
    };
  }
  if (overlays.fusion.enabled && overlays.fusion.voxels) {
    return {
      mode: 3,
      source: overlays.fusion.voxels,
      colors: getHotLutColors(),
      opacities: opacityTable(state.fusionOpacity),
      opacity: state.fusionOpacity,
      legend: null,
    };
  }
  if (overlays.heatmap.enabled && overlays.heatmap.voxels) {
    return {
      mode: 3,
      source: overlays.heatmap.voxels,
      colors: getHotLutColors(),
      opacities: opacityTable(state.overlayOpacity),
      opacity: state.overlayOpacity,
      legend: null,
    };
  }
  return { mode: 0, source: null, colors: null, opacities: null, legend: null };
}
