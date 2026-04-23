// Legacy flat keys (e.g. state.lowT) resolve via APP_ALIASES into grouped state.
export const APP_ALIASES = {
  mprX: 'mpr.x',
  mprY: 'mpr.y',
  mprZ: 'mpr.z',
  mprQuality: 'mpr.quality',
  mprGpuEnabled: 'mpr.gpuEnabled',
  mprProjectionMode: 'mpr.projectionMode',
  mprSlabThicknessMm: 'mpr.slabThicknessMm',
  obYaw: 'mpr.obYaw',
  obPitch: 'mpr.obPitch',

  lowT: 'three.lowT',
  highT: 'three.highT',
  intensity: 'three.intensity',
  clipMin: 'three.clipMin',
  clipMax: 'three.clipMax',
  renderMode: 'three.renderMode',
  threeSeriesIdx: 'threeRuntime.seriesIdx',
  threeVariant: 'threeRuntime.variant',

  useBrain: 'overlays.useBrain',
  useSeg: 'overlays.useSeg',
  useSym: 'overlays.useSym',
  useRegions: 'overlays.useRegions',
  regionMeta: 'overlays.regionMeta',
  stats: 'overlays.stats',
  analysis: 'overlays.analysis',
  analysisBusy: 'overlays.analysisBusy',
  fusionSlug: 'overlays.fusionSlug',
  fusionOpacity: 'overlays.fusionOpacity',
  overlayOpacity: 'overlays.overlayOpacity',
  cmpZoom: 'compare.viewport.zoom',
  cmpTx: 'compare.viewport.tx',
  cmpTy: 'compare.viewport.ty',
};

// Durable / serializable app roots.
export const APP_ROOT_KEYS = new Set([
  'manifest',
  'seriesIdx',
  'sliceIdx',
  'loaded',
  'window',
  'level',
  'mode',
  'mpr',
  'three',
  'overlays',
  'annotateMode',
  'annotationEdit',
  'askMode',
  'askMarquee',
  'askBusy',
  'askHistory',
  'selectRequestId',
  'zoom',
  'tx',
  'ty',
  'cineTimer',
  'cineFps',
  'compare',
  'measureMode',
  'measurePending',
  'measurements',
  'angleMode',
  'anglePending',
  'angleMeasurements',
  'hiddenLabels',
  'colormap',
  'cmpManualSlugs',
]);

export function createInitialAppModel() {
  return {
    manifest: null,
    seriesIdx: 0,
    sliceIdx: 0,
    loaded: false,
    window: 255,
    level: 128,
    mode: '2d',

    // Shape: { x: 0, y: 0, z: 0, projectionMode: "thin", slabThicknessMm: 0, viewports: { ax: { zoom: 1, tx: 0, ty: 0 } } }.
    mpr: {
      x: 0,
      y: 0,
      z: 0,
      quality: 'quality',
      gpuEnabled: true,
      projectionMode: 'thin',
      slabThicknessMm: 0,
      obYaw: 0,
      obPitch: 30,
      viewports: {
        ax: { zoom: 1, tx: 0, ty: 0 },
        co: { zoom: 1, tx: 0, ty: 0 },
        sa: { zoom: 1, tx: 0, ty: 0 },
        ob: { zoom: 1, tx: 0, ty: 0 },
      },
    },

    three: {
      lowT: 0.08,
      highT: 1.0,
      intensity: 1.6,
      clipMin: [0, 0, 0],
      clipMax: [1, 1, 1],
      renderMode: 'alpha',
    },

    overlays: {
      useBrain: false,
      useSeg: false,
      useSym: false,
      useRegions: false,
      regionMeta: null,
      stats: null,
      analysis: null,
      analysisBusy: false,
      fusionSlug: null,
      fusionOpacity: 0.5,
      overlayOpacity: 0.55,
    },

    // Shape: { viewport: { zoom: 1, tx: 0, ty: 0 } } for linked Compare panes.
    compare: {
      viewport: { zoom: 1, tx: 0, ty: 0 },
    },

    annotateMode: false,
    annotationEdit: null,
    askMode: false,
    askMarquee: null,
    askBusy: false,
    askHistory: [],

    selectRequestId: 0,

    zoom: 1,
    tx: 0,
    ty: 0,

    cineTimer: null,
    cineFps: 12,

    measureMode: false,
    measurePending: null,
    measurements: {},
    angleMode: false,
    anglePending: null,
    angleMeasurements: {},
    hiddenLabels: new Set(),

    colormap: 'grayscale',

    // null = auto-group by geometry; string[] = user-picked series slugs
    cmpManualSlugs: null,
  };
}
