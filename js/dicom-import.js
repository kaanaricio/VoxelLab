// Browser-side DICOM / NIfTI import: parsing lives in dicom-import-parse.js.
// This file wires parsed stacks into the manifest + sidebar.

import { state } from './state.js';
import { notifyProjectsChanged } from './projects.js';
import { fetchSeriesItems, resolveDicomwebImportSession } from './dicomweb/dicomweb-source.js';
import {
  localDisplayEntryForImport,
  mergeSeriesIntoManifest,
  registerProjectionSet,
} from './series-contract.js';

export { parseDICOMFiles, parseDICOMFileGroups, parseNIfTI } from './dicom-import-parse.js';
export { buildDICOMSeriesResult } from './dicom-import-parse.js';
export {
  fetchSeriesMetadata,
  fetchSeriesItems,
  discoverQidoStudies,
  discoverQidoSeries,
  getDicomwebSessionStats,
  resolveDicomwebImportSession,
} from './dicomweb/dicomweb-source.js';
import { buildDICOMSeriesResult } from './dicom-import-parse.js';

function localImportSlug(prefix = 'local') {
  return `${prefix}_${Date.now().toString(36)}`;
}

const MAX_LOCAL_RAW_VOLUME_BYTES = 512 * 1024 * 1024;

function ensureLocalRawVolumeOrder() {
  if (!Array.isArray(state._localRawVolumeOrder)) state._localRawVolumeOrder = [];
  return state._localRawVolumeOrder;
}

function totalLocalRawVolumeBytes() {
  return Object.values(state._localRawVolumes || {}).reduce(
    (sum, volume) => sum + (volume?.byteLength || 0),
    0,
  );
}

export function touchLocalRawVolume(slug = '') {
  const key = String(slug || '').trim();
  if (!key || !state._localRawVolumes?.[key]) return false;
  const next = ensureLocalRawVolumeOrder().filter((entry) => entry !== key);
  next.push(key);
  state._localRawVolumeOrder = next;
  return true;
}

export function cacheLocalRawVolume(slug, rawVolume, { maxBytes = MAX_LOCAL_RAW_VOLUME_BYTES } = {}) {
  const key = String(slug || '').trim();
  if (!key || !rawVolume) return false;
  state._localRawVolumes[key] = rawVolume;
  touchLocalRawVolume(key);
  const protectedSlugs = new Set([
    key,
    state.manifest?.series?.[state.seriesIdx]?.slug || '',
  ].filter(Boolean));
  while (totalLocalRawVolumeBytes() > maxBytes) {
    const victim = ensureLocalRawVolumeOrder().find((entry) => !protectedSlugs.has(entry));
    if (!victim) break;
    delete state._localRawVolumes[victim];
    state._localRawVolumeOrder = ensureLocalRawVolumeOrder().filter((entry) => entry !== victim);
  }
  return true;
}

function dicomwebHeaders({ bearerToken = '', headers = {} } = {}) {
  const next = { ...headers };
  if (bearerToken && !next.Authorization && !next.authorization) next.Authorization = `Bearer ${bearerToken}`;
  return next;
}

export function injectManifestSeries(manifest, entry) {
  const idx = mergeSeriesIntoManifest(manifest, entry);
  notifyProjectsChanged(idx);
  return idx;
}

export function injectLocalSeries(manifest, entry, sliceCanvases, rawVolume) {
  const projectionSetRecord = registerProjectionSet(manifest, entry);
  const displayEntry = localDisplayEntryForImport(entry, projectionSetRecord);
  const imgs = sliceCanvases.map(c => {
    const img = new Image();
    img.src = c.toDataURL('image/png');
    return img;
  });

  state._localStacks[displayEntry.slug] = imgs;
  if (rawVolume) {
    cacheLocalRawVolume(displayEntry.slug, rawVolume);
  }
  return injectManifestSeries(manifest, displayEntry);
}

export async function importDicomwebSeries({
  wadoBase,
  studyUID,
  seriesUID,
  bearerToken = '',
  headers = {},
  metadata,
  slug = localImportSlug('dicomweb'),
  onProgress = () => {},
  fetchImpl,
  signal,
  retries,
  retryStatuses,
  retryDelay,
  sessionId = '',
  cacheScopeKey = '',
  useCache = true,
}) {
  if (!String(wadoBase || '').trim() || !String(studyUID || '').trim() || !String(seriesUID || '').trim()) {
    throw new Error('DICOMweb import requires WADO-RS base URL, Study UID, and Series UID');
  }
  const requestHeaders = dicomwebHeaders({ bearerToken, headers });
  const session = resolveDicomwebImportSession({
    sessionId,
    wadoBase,
    headers: requestHeaders,
    fetchImpl,
    retries,
    retryStatuses,
    retryDelay,
    cacheScopeKey,
  });
  const items = await fetchSeriesItems({
    wadoBase,
    studyUID,
    seriesUID,
    sessionId: session.id,
    headers: requestHeaders,
    fetchImpl,
    metadata,
    signal,
    retries,
    retryStatuses,
    retryDelay,
    cacheScopeKey,
    useCache,
  });
  if (!items.length) throw new Error('DICOMweb series returned no frame items');
  return await buildDICOMSeriesResult(items, onProgress, slug, []);
}
