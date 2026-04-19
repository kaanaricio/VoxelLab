import { createViewerSessionState } from '../runtime/viewer-session-shape.js';

// Ephemeral runtime/cache roots (not part of a serializable app snapshot).
export const RUNTIME_ROOT_KEYS = new Set([
  'imgs',
  'cmpStacks',
  'threeRuntime',
  'viewerSession',
  '_localStacks',
  '_localRawVolumes',
  '_localRawVolumeOrder',
  '_localRegionMetaBySlug',
  '_localRegionLabelSlicesBySlug',
  '_localDerivedObjects',
  '_localRtDoseBySlug',
  '_seriesVolumeCacheEntries',
  'segImgs',
  'segVoxels',
  'symImgs',
  'symVoxels',
  'regionImgs',
  'regionVoxels',
  'fusionImgs',
  'fusionVoxels',
  'voxels',
  'voxelsKey',
  'hrVoxels',
  'hrKey',
  'hrLoading',
  'hrLoadingKey',
  'hrAbortController',
]);

export function createInitialRuntimeState() {
  return {
    imgs: [],

    cmpStacks: {},

    // Shape: { slug: "", seriesIdx: -1, readiness: { stage: "idle" } }.
    viewerSession: createViewerSessionState(),

    threeRuntime: {
      renderer: null,
      scene: null,
      camera: null,
      controls: null,
      mesh: null,
      startLoop: null,
      stopLoop: null,
      requestRender: null,
      renderNow: null,
      seriesIdx: -1,
      variant: '',
      dataKey: '',
      previewShown: false,
    },

    _localStacks: {},
    _localRawVolumes: {},
    // Shape: ["local_ct_a", "local_ct_b"] ordered least -> most recently used.
    _localRawVolumeOrder: [],
    _localRegionMetaBySlug: {},
    _localRegionLabelSlicesBySlug: {},
    _localDerivedObjects: {},
    _localRtDoseBySlug: {},
    // Shape: [{ key: "t2_axial|base", slug: "t2_axial", variant: "base", voxels, hrVoxels, segVoxels, ... }].
    _seriesVolumeCacheEntries: [],

    segImgs: [],
    segVoxels: null,
    symImgs: [],
    symVoxels: null,
    regionImgs: [],
    regionVoxels: null,
    fusionImgs: null,
    fusionVoxels: null,

    voxels: null,
    voxelsKey: '',

    hrVoxels: null,
    hrKey: '',
    hrLoading: null,
    hrLoadingKey: '',
    hrAbortController: null,
  };
}
