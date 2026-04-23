// Segmentation colours, 3D transfer presets, CT W/L (normalized 0–1, matching
// uint16 HU mapping from convert_ct.py / CT stack).

export const CT_HU_LO = -1024;
export const CT_HU_HI = 2048;
export const CT_HU_RANGE = CT_HU_HI - CT_HU_LO; // 3072

/** @typedef {{ lowT: number; highT: number; intensity: number }} CTWindowDef */

/** CT window pills — values align with index.html HU tooltips after HU→normalized map. */
export const CT_WINDOWS = /** @type {Record<string, CTWindowDef>} */ ({
  full: { lowT: 124 / 3072, highT: 2524 / 3072, intensity: 1.4 },
  soft: { lowT: 864 / 3072, highT: 1264 / 3072, intensity: 1.5 },
  lung: { lowT: 0 / 3072, highT: 1274 / 3072, intensity: 1.3 },
  bone: { lowT: 574 / 3072, highT: 2074 / 3072, intensity: 1.2 },
});

/** Per-series defaults when entering 3D. `mode`: alpha | mip | minip */
export const THREE_D_PRESETS = {
  t2_tse: { lowT: 0.08, highT: 0.95, intensity: 1.5, mode: 'alpha' },
  t1_se: { lowT: 0.06, highT: 0.92, intensity: 1.55, mode: 'alpha' },
  flair: { lowT: 0.05, highT: 0.9, intensity: 1.65, mode: 'alpha' },
  dwi_adc: { lowT: 0.02, highT: 0.85, intensity: 1.7, mode: 'alpha' },
  swi_3d: { lowT: 0.04, highT: 0.9, intensity: 1.8, mode: 'alpha' },
  ct_chest_1: { lowT: CT_WINDOWS.full.lowT, highT: CT_WINDOWS.full.highT, intensity: 1.4, mode: 'alpha' },
  ct_chest_2: { lowT: CT_WINDOWS.full.lowT, highT: CT_WINDOWS.full.highT, intensity: 1.4, mode: 'alpha' },
  ct_chest_3: { lowT: CT_WINDOWS.full.lowT, highT: CT_WINDOWS.full.highT, intensity: 1.4, mode: 'alpha' },
  ct_chest_4: { lowT: CT_WINDOWS.full.lowT, highT: CT_WINDOWS.full.highT, intensity: 1.4, mode: 'alpha' },
  ct_chest_5: { lowT: CT_WINDOWS.full.lowT, highT: CT_WINDOWS.full.highT, intensity: 1.4, mode: 'alpha' },
  ct_chest_6: { lowT: CT_WINDOWS.full.lowT, highT: CT_WINDOWS.full.highT, intensity: 1.4, mode: 'alpha' },
  ct_chest_7: { lowT: CT_WINDOWS.full.lowT, highT: CT_WINDOWS.full.highT, intensity: 1.4, mode: 'alpha' },
};

export const TISSUE_NAMES = ['—', 'CSF', 'Gray matter', 'White matter'];

/** Label → [R,G,B,A] for 2D overlay compositing (A 0–255). */
export const SEG_PALETTE = {
  0: [0, 0, 0, 0],
  1: [125, 211, 252, 200],
  2: [134, 239, 172, 200],
  3: [251, 191, 36, 200],
};

// Shape: 4 -> background label 0 plus tissue labels 1..3.
export const TISSUE_LABEL_COUNT = Math.max(...Object.keys(SEG_PALETTE).map(Number)) + 1;

/** Per tissue-class opacity multiplier 0–1 for 3D label LUT alpha. */
export const TISSUE_OPACITY = {
  1: 0.55,
  2: 0.55,
  3: 0.65,
};

const _regionOp = {};
for (let i = 1; i < 256; i++) _regionOp[i] = 0.32;
export const REGION_OPACITY = _regionOp;

// Image-stack prefetch tuning (shared by select-series.js, overlay-stack.js, series-image-stack.js).
export const BASE_PREFETCH_CONCURRENCY = 4;
export const OVERLAY_PREFETCH_CONCURRENCY = 2;
export const REMOTE_BASE_PREFETCH_CONCURRENCY = 8;
export const REMOTE_OVERLAY_PREFETCH_CONCURRENCY = 3;
/** Default max slices queued ahead in loadImageStack.prefetchRemaining (local / non-remote). */
export const DEFAULT_PREFETCH_LIMIT = 24;
