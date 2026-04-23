export const RUNTIME_OVERLAY_KIND_BY_TYPE = {
  seg: 'tissue',
  regions: 'labels',
  sym: 'heatmap',
  fusion: 'fusion',
};

export const VIEWER_SESSION_STAGE_ORDER = [
  'idle',
  'first-slice',
  'base-volume',
  'orthogonal-ready',
  'overlay-ready',
  'quality-ready',
  '3d-ready',
];

// Shape: { available: true, enabled: false, ready: false, sourceType: "seg" }.
function createOverlayKindState(sourceType) {
  return {
    available: false,
    enabled: false,
    ready: false,
    sourceType,
  };
}

// Shape: { stage: "idle", firstSlice: false, baseVolume: false, overlayReady: false }.
function createReadinessState() {
  return {
    stage: 'idle',
    firstSlice: false,
    baseVolume: false,
    orthogonalReady: false,
    overlayReady: false,
    qualityReady: false,
    threeReady: false,
    sliceReady: false,
    mprReady: false,
    twoDReady: false,
    compareReady: false,
  };
}

// Shape: { enabled: true, currentSliceReady: false, volumeReady: true, metaReady: true }.
function createOverlaySessionKindState(sourceType) {
  return {
    available: false,
    enabled: false,
    currentSliceReady: false,
    volumeReady: false,
    metaReady: false,
    blockingReason: '',
    sourceType,
  };
}

// Shape: { slug: "brain_ax_t1", seriesIdx: 0, overlayKinds: { tissue: ... } }.
export function createViewerSessionState({
  slug = '',
  seriesIdx = -1,
  requestId = 0,
} = {}) {
  return {
    slug,
    seriesIdx,
    requestId,
    baseSource: '',
    firstSliceIdx: -1,
    overlayKinds: {
      tissue: createOverlayKindState('seg'),
      labels: createOverlayKindState('regions'),
      heatmap: createOverlayKindState('sym'),
      fusion: createOverlayKindState('fusion'),
    },
    overlaySession: {
      tissue: createOverlaySessionKindState('seg'),
      labels: createOverlaySessionKindState('regions'),
      heatmap: createOverlaySessionKindState('sym'),
      fusion: createOverlaySessionKindState('fusion'),
    },
    readiness: createReadinessState(),
  };
}
