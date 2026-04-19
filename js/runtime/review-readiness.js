import { state } from '../state.js';
import { activeOverlayStateForSeries } from './active-overlay-state.js';

function seriesVoxelCount(series) {
  return Number(series?.width || 0) * Number(series?.height || 0) * Number(series?.slices || 0);
}

// Shape: true when an image slot is fully decoded and paintable.
export function isRenderableImage(img) {
  return !!(img && img.complete && img.naturalWidth > 0);
}

export function hasBaseVolume(series = state.manifest?.series?.[state.seriesIdx]) {
  const voxelCount = seriesVoxelCount(series);
  return !!(
    voxelCount
    && ((state.hrVoxels && state.hrVoxels.length === voxelCount)
      || (state.voxels && state.voxels.length === voxelCount))
  );
}

export function hasHrVolume(series = state.manifest?.series?.[state.seriesIdx]) {
  const voxelCount = seriesVoxelCount(series);
  return !!(voxelCount && state.hrVoxels && state.hrVoxels.length === voxelCount);
}

function stackSliceReady(stack, sliceIdx) {
  const index = Math.max(0, Number(sliceIdx || 0));
  return isRenderableImage(stack?.[index]);
}

function statusForOverlay(kind, overlay, { sliceIdx, stacks = {} }) {
  const stack = stacks[kind] || null;
  const hasMeta = kind !== 'labels' || !!overlay.meta;
  const currentSliceReady = !overlay.enabled || stackSliceReady(stack || overlay.imgs, sliceIdx);
  const volumeReady = !overlay.enabled || !!overlay.ready;
  const metaReady = !overlay.enabled || hasMeta;
  let blockingReason = '';
  if (overlay.enabled && !currentSliceReady) blockingReason = `${kind}-slice`;
  else if (overlay.enabled && !volumeReady) blockingReason = `${kind}-volume`;
  else if (overlay.enabled && !metaReady) blockingReason = `${kind}-meta`;
  return {
    available: !!overlay.available,
    enabled: !!overlay.enabled,
    currentSliceReady,
    volumeReady,
    metaReady,
    blockingReason,
    sourceType: kind === 'tissue' ? 'seg' : kind === 'labels' ? 'regions' : kind === 'heatmap' ? 'sym' : 'fusion',
  };
}

// Shape: { tissue: { currentSliceReady: true, volumeReady: false }, ... }.
export function overlaySessionForSeries(
  series = state.manifest?.series?.[state.seriesIdx],
  {
    sliceIdx = state.sliceIdx,
    overlays = activeOverlayStateForSeries(series),
    stacks = {
      tissue: state.segImgs,
      labels: state.regionImgs,
      heatmap: state.symImgs,
      fusion: state.fusionImgs,
    },
  } = {},
) {
  return {
    tissue: statusForOverlay('tissue', overlays.tissue, { sliceIdx, stacks }),
    labels: statusForOverlay('labels', overlays.labels, { sliceIdx, stacks }),
    heatmap: statusForOverlay('heatmap', overlays.heatmap, { sliceIdx, stacks }),
    fusion: statusForOverlay('fusion', overlays.fusion, { sliceIdx, stacks }),
  };
}

function allEnabled(session, key) {
  return Object.values(session).every((item) => !item.enabled || !!item[key]);
}

export function reviewReadinessForSeries(
  series = state.manifest?.series?.[state.seriesIdx],
  {
    sliceIdx = state.sliceIdx,
    baseSlice = state.imgs,
    overlaySession = overlaySessionForSeries(series, { sliceIdx }),
    threeReady = state.threeRuntime.seriesIdx === state.seriesIdx && !!state.threeRuntime.mesh,
  } = {},
) {
  const firstSlice = stackSliceReady(baseSlice, sliceIdx);
  const baseVolume = hasBaseVolume(series);
  const qualityReady = baseVolume && (!series?.hasRaw || hasHrVolume(series));
  const sliceReady = firstSlice && allEnabled(overlaySession, 'currentSliceReady') && allEnabled(overlaySession, 'metaReady');
  const mprReady = baseVolume && allEnabled(overlaySession, 'volumeReady') && allEnabled(overlaySession, 'metaReady');
  const stage = (threeReady && mprReady)
    ? '3d-ready'
    : qualityReady
      ? 'quality-ready'
      : mprReady
        ? 'overlay-ready'
        : baseVolume
          ? 'orthogonal-ready'
          : firstSlice
            ? 'first-slice'
            : 'idle';
  return {
    stage,
    firstSlice,
    baseVolume,
    orthogonalReady: baseVolume,
    overlayReady: mprReady,
    qualityReady,
    threeReady,
    sliceReady,
    mprReady,
    twoDReady: sliceReady,
    compareReady: sliceReady,
  };
}
