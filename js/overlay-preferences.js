// Persisted preferred-overlay hints per modality (localStorage). Single-writer/single-reader;
// tiny entries. Read synchronously so selectSeries() can schedule overlay prefetch before any await.
//
// Policy:
// - One key per modality: voxellab.overlay.preferred.<MODALITY>
// - Value is a JSON array of overlay kinds: ['seg', 'regions', 'sym']
// - Empty array (or missing key) means "no preference" — selectSeries
//   should not pre-fetch anything beyond what state.use* already requests.
// - Eviction: none. Bounded by O(modalities) — typically ≤ 10 entries.

const VALID_KINDS = new Set(['seg', 'regions', 'sym']);

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function keyFor(modality) {
  const m = String(modality || '').toUpperCase().trim();
  return m ? `voxellab.overlay.preferred.${m}` : '';
}

/**
 * Return the user's preferred overlays for this modality. Empty array when
 * no preference has been recorded or storage is unavailable.
 *
 * @param {string} modality e.g. 'CT', 'MR'
 * @returns {Array<'seg' | 'regions' | 'sym'>}
 */
export function getPreferredOverlays(modality) {
  const store = storage();
  const key = keyFor(modality);
  if (!store || !key) return [];
  try {
    const raw = store.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((kind) => VALID_KINDS.has(kind));
  } catch {
    return [];
  }
}

/**
 * Persist the preferred overlay set for this modality. Filters to known
 * kinds; writing an empty set clears the entry.
 *
 * @param {string} modality
 * @param {Array<'seg' | 'regions' | 'sym'>} set
 */
export function setPreferredOverlays(modality, set) {
  const store = storage();
  const key = keyFor(modality);
  if (!store || !key) return;
  const filtered = (Array.isArray(set) ? set : []).filter((kind) => VALID_KINDS.has(kind));
  try {
    if (filtered.length === 0) {
      store.removeItem(key);
    } else {
      store.setItem(key, JSON.stringify(filtered));
    }
  } catch {
    // Best-effort persistence; ignore quota errors.
  }
}

/**
 * Add one overlay kind to the preferred set for this modality. No-op if
 * already present. Used by overlay toggle handlers when the user enables
 * a new overlay.
 *
 * @param {string} modality
 * @param {'seg' | 'regions' | 'sym'} kind
 */
export function rememberPreferredOverlay(modality, kind) {
  if (!VALID_KINDS.has(kind)) return;
  const current = getPreferredOverlays(modality);
  if (current.includes(kind)) return;
  setPreferredOverlays(modality, [...current, kind]);
}

/**
 * Remove one overlay kind from the preferred set. No-op if missing.
 *
 * @param {string} modality
 * @param {'seg' | 'regions' | 'sym'} kind
 */
export function forgetPreferredOverlay(modality, kind) {
  const current = getPreferredOverlays(modality);
  if (!current.includes(kind)) return;
  setPreferredOverlays(modality, current.filter((k) => k !== kind));
}
