import { seriesCompareGroup } from './geometry.js';
import { overlayKindsForSeries, setSeriesOverlayHints } from './runtime/overlay-kinds.js';

// Shape: ['cbct', 'parallel-beam', 'tomosynthesis', 'xray', 'unknown'].
const PROJECTION_KINDS = new Set(['cbct', 'parallel-beam', 'tomosynthesis', 'unknown', 'xray']);
// Shape: ['requires-calibration', 'reconstructed', 'reconstruction-pending'].
const PROJECTION_STATUSES = new Set([
  'requires-calibration',
  'requires-reconstruction',
  'reconstruction-pending',
  'reconstruction-failed',
  'reconstructed',
]);
// Shape: ['projectionMatrices', 'sourceDetectorGeometry', 'isocenter', 'calibrationStatus'].
const PROJECTION_MISSING_GEOMETRY = [
  'projectionMatrices',
  'sourceDetectorGeometry',
  'isocenter',
  'calibrationStatus',
];
// Shape: ['sourceJobId', 'modalJobId', 'jobId', 'job_id'].
export const SERIES_JOB_ID_FIELDS = ['sourceJobId', 'modalJobId', 'jobId', 'job_id'];

const SAFE_ID_RE = /^[A-Za-z0-9_.-]+$/;

function projectionKindForModality(modality) {
  if (['CR', 'DX', 'MG', 'XA', 'RF'].includes(modality)) return 'xray';
  return 'unknown';
}

function ensureProjectionSets(manifest) {
  if (!Array.isArray(manifest.projectionSets)) manifest.projectionSets = [];
  return manifest.projectionSets;
}

function upsertById(list, record) {
  const idx = list.findIndex(item => item?.id === record.id);
  if (idx >= 0) list[idx] = record;
  else list.push(record);
}

function assertSafeProjectionSetId(id) {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..') || !SAFE_ID_RE.test(id)) {
    throw new Error(`Expected safe projection set id: ${id || 'missing'}`);
  }
}

// Shape: { tissue: { source: 'cloud-seg' }, labels: { source: 'cloud-regions' } }.
export function cloudOverlayHints(entry) {
  return {
    tissue: entry?.hasSeg ? { source: 'cloud-seg', legacyKinds: ['seg'] } : null,
    labels: entry?.hasRegions ? { source: 'cloud-regions', legacyKinds: ['regions'] } : null,
    heatmap: entry?.hasSym ? { source: 'cloud-sym', legacyKinds: ['sym'] } : null,
  };
}

export function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

export function applyPublicSeriesUrls(entry, publicBase) {
  const out = { ...entry };
  const slug = String(out.slug || '').trim();
  const base = String(publicBase || '').replace(/\/+$/, '');
  if (!base || !slug) return out;
  if (!out.sliceUrlBase) out.sliceUrlBase = `${base}/data/${slug}`;
  if (out.hasRaw && !out.rawUrl) out.rawUrl = `${base}/${slug}.raw.zst`;
  if (out.hasRegions && !out.regionUrlBase) out.regionUrlBase = `${base}/data/${slug}_regions`;
  if (out.hasRegions && !out.regionMetaUrl) out.regionMetaUrl = `${base}/data/${slug}_regions.json`;
  return out;
}

function assertTrustedPublicSeriesUrls(entry, publicBase) {
  const base = String(publicBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('Cloud result requires r2PublicUrl to trust asset locations');
  const trustedOrigin = normalizeOrigin(base);
  const sliceOrigin = normalizeOrigin(entry.sliceUrlBase || '');
  if (!sliceOrigin) throw new Error('Cloud result is missing a trusted sliceUrlBase');
  if (trustedOrigin && sliceOrigin !== trustedOrigin) {
    throw new Error(`Cloud result escaped the configured R2 origin: ${sliceOrigin}`);
  }
  if (entry.hasRaw) {
    const rawOrigin = normalizeOrigin(entry.rawUrl || '');
    if (!rawOrigin) throw new Error('Cloud result is missing a trusted rawUrl');
    if (trustedOrigin && rawOrigin !== trustedOrigin) {
      throw new Error('Cloud result escaped the configured raw-volume origin');
    }
  }
  const overlayKinds = overlayKindsForSeries(entry);
  if (overlayKinds.byKind.labels.available) {
    const regionOrigin = normalizeOrigin(entry.regionUrlBase || '');
    const regionMetaOrigin = normalizeOrigin(entry.regionMetaUrl || '');
    if (!regionOrigin || !regionMetaOrigin) {
      throw new Error('Cloud result is missing trusted region overlay URLs');
    }
    if (trustedOrigin && (regionOrigin !== trustedOrigin || regionMetaOrigin !== trustedOrigin)) {
      throw new Error('Cloud result escaped the configured region-overlay origin');
    }
  }
}

export function projectionSetRecordForEntry(entry) {
  if (!entry?.isProjectionSet && entry?.geometryKind !== 'projectionSet') return null;
  const modality = String(entry.modality || 'OT').toUpperCase();
  const id = String(entry.id || entry.projectionSetId || `${entry.slug}_projection_set`).trim();
  assertSafeProjectionSetId(id);
  // Shape: one manifest projectionSets[] record for a local or cloud source.
  const record = {
    id,
    name: entry.name || id,
    sourceSeriesSlug: entry.slug,
    modality,
    projectionKind: projectionKindForModality(modality),
    projectionCount: Number(entry.slices || 0),
    reconstructionCapability: 'requires-reconstruction',
    reconstructionStatus: entry.reconstructionStatus || 'requires-calibration',
    renderability: '2d',
    missingGeometry: entry.missingGeometry || PROJECTION_MISSING_GEOMETRY,
  };
  for (const key of [
    'sourceStudyUID',
    'sourceSeriesUID',
    'frameOfReferenceUID',
    'bodyPart',
    'calibrationStatus',
    'projectionMatrices',
    'detectorPixels',
    'detectorSpacingMm',
    'projectionCalibration',
  ]) {
    if (entry[key]) record[key] = entry[key];
  }
  return record;
}

export function registerProjectionSet(manifest, entry) {
  const record = projectionSetRecordForEntry(entry);
  if (!record) return null;
  upsertById(ensureProjectionSets(manifest), record);
  return record;
}

export function localDisplayEntryForImport(entry, projectionSetRecord) {
  if (!projectionSetRecord) return entry;
  return {
    ...entry,
    geometryKind: 'imageStack',
    reconstructionCapability: '2d-only',
    renderability: '2d',
    isProjectionSet: false,
    sourceProjectionSetId: projectionSetRecord.id,
  };
}

export function normalizeSeriesEntryForManifest(manifest, entry) {
  // Shape: one manifest series[] record merged from local, DICOMweb, or cloud flows.
  const next = { ...entry };
  if (next.group == null) next.group = seriesCompareGroup(next);
  if (next.sourceProjectionSetId) {
    const projectionId = String(next.sourceProjectionSetId);
    const projectionSets = Array.isArray(manifest?.projectionSets) ? manifest.projectionSets : [];
    if (!projectionSets.length) throw new Error('Imported series references unknown projection set: projectionSets registry is required');
    if (!projectionSets.some(item => item?.id === projectionId)) {
      throw new Error(`Imported series references unknown projection set: ${projectionId}`);
    }
  }
  return next;
}

export function findExistingSeriesIndex(manifest, entry) {
  const matches = new Map();
  const slug = entry?.slug;
  const jobIds = new Set(SERIES_JOB_ID_FIELDS.map(key => entry?.[key]).filter(Boolean));
  for (let index = 0; index < manifest.series.length; index++) {
    const series = manifest.series[index];
    if (!series) continue;
    if (slug && series.slug === slug) matches.set(index, 'slug');
    if (jobIds.size && SERIES_JOB_ID_FIELDS.some(key => jobIds.has(series?.[key]))) matches.set(index, 'jobId');
  }
  if (matches.size > 1) {
    throw new Error(`Imported series matches multiple existing entries: ${[...matches.keys()].join(', ')}`);
  }
  return matches.size ? [...matches.keys()][0] : -1;
}

export function mergeSeriesIntoManifest(manifest, entry) {
  const normalizedEntry = normalizeSeriesEntryForManifest(manifest, entry);
  const existingIdx = findExistingSeriesIndex(manifest, normalizedEntry);
  if (existingIdx >= 0) manifest.series[existingIdx] = { ...manifest.series[existingIdx], ...normalizedEntry };
  else manifest.series.push(normalizedEntry);
  return existingIdx >= 0 ? existingIdx : manifest.series.length - 1;
}

export function normalizeCloudProjectionSetEntry(entry, seriesEntry = null) {
  if (!entry || typeof entry !== 'object') throw new Error('Cloud result is missing a projection set entry');
  const normalized = { ...entry };
  normalized.id = String(normalized.id || normalized.projectionSetId || '').trim();
  assertSafeProjectionSetId(normalized.id);
  normalized.name = String(normalized.name || normalized.id).trim();
  if (!normalized.name) throw new Error('Cloud projection set is missing a name');
  normalized.modality = String(normalized.modality || '').trim();
  if (!normalized.modality) throw new Error('Cloud projection set is missing a modality');
  normalized.projectionKind = String(normalized.projectionKind || '').trim();
  if (!PROJECTION_KINDS.has(normalized.projectionKind)) {
    throw new Error(`Cloud projection set has invalid projectionKind: ${normalized.projectionKind || 'missing'}`);
  }
  normalized.reconstructionStatus = String(normalized.reconstructionStatus || '').trim();
  if (!PROJECTION_STATUSES.has(normalized.reconstructionStatus)) {
    throw new Error(`Cloud projection set has invalid reconstructionStatus: ${normalized.reconstructionStatus || 'missing'}`);
  }
  normalized.projectionCount = Number(normalized.projectionCount);
  if (!Number.isInteger(normalized.projectionCount) || normalized.projectionCount <= 0) {
    throw new Error('Cloud projection set has invalid projectionCount');
  }
  if ((normalized.reconstructionCapability || 'requires-reconstruction') !== 'requires-reconstruction') {
    throw new Error('Cloud projection set must require reconstruction');
  }
  normalized.reconstructionCapability = 'requires-reconstruction';
  if ((normalized.renderability || '2d') !== '2d') {
    throw new Error('Cloud projection set must remain 2d');
  }
  normalized.renderability = '2d';
  if (seriesEntry?.sourceProjectionSetId && normalized.id !== seriesEntry.sourceProjectionSetId) {
    throw new Error(`Cloud projection set id mismatch: ${normalized.id} vs ${seriesEntry.sourceProjectionSetId}`);
  }
  return normalized;
}

export function attachSeriesJobIdentity(entry, jobId) {
  if (!entry) return null;
  if (!jobId || SERIES_JOB_ID_FIELDS.some(key => entry[key])) return entry;
  return { ...entry, sourceJobId: jobId };
}

export function normalizeCloudSeriesEntry(entry, { publicBase = '' } = {}) {
  if (!entry || typeof entry !== 'object') throw new Error('Cloud result is missing a series entry');
  const normalized = applyPublicSeriesUrls({
    hasBrain: false,
    hasSeg: false,
    hasSym: false,
    hasRegions: false,
    hasStats: false,
    hasAnalysis: false,
    hasMaskRaw: false,
    hasRaw: false,
    ...entry,
  }, publicBase);
  if (!normalized.slug || !normalized.name || !normalized.description) {
    throw new Error('Cloud result is missing required series metadata');
  }
  for (const key of ['slices', 'width', 'height']) {
    if (!Number.isInteger(normalized[key]) || normalized[key] <= 0) {
      throw new Error(`Cloud result has an invalid ${key}`);
    }
  }
  if (!Array.isArray(normalized.pixelSpacing) || normalized.pixelSpacing.length !== 2
      || normalized.pixelSpacing.some(value => !(Number(value) > 0))) {
    throw new Error('Cloud result has invalid pixel spacing');
  }
  if (!(Number(normalized.sliceThickness) > 0)) {
    throw new Error('Cloud result has invalid slice thickness');
  }
  setSeriesOverlayHints(normalized, cloudOverlayHints(normalized));
  assertTrustedPublicSeriesUrls(normalized, publicBase);
  return normalized;
}

export function normalizeCompleteSlug(status = {}, seriesEntry = null) {
  const statusSlug = String(status.slug || '').trim();
  const entrySlug = String(seriesEntry?.slug || '').trim();
  if (statusSlug && entrySlug && statusSlug !== entrySlug) {
    throw new Error(`Cloud result slug mismatch: ${statusSlug} vs ${entrySlug}`);
  }
  const slug = statusSlug || entrySlug;
  if (!slug) throw new Error('Cloud result is missing a completed slug');
  return slug;
}

export function normalizeCloudUploadResult(status, { jobId = '', publicBase = '', fallbackSeriesEntry = null } = {}) {
  const seriesEntry = attachSeriesJobIdentity(
    status?.series_entry
      ? normalizeCloudSeriesEntry(status.series_entry, { publicBase })
      : fallbackSeriesEntry,
    jobId,
  );
  const projectionSetEntry = status?.projection_set_entry
    ? normalizeCloudProjectionSetEntry(status.projection_set_entry, seriesEntry)
    : null;
  if (seriesEntry?.sourceProjectionSetId && !projectionSetEntry) {
    throw new Error(`Cloud result is missing projection set ${seriesEntry.sourceProjectionSetId}`);
  }
  return {
    slug: normalizeCompleteSlug(status, seriesEntry),
    jobId,
    seriesEntry,
    projectionSetEntry,
  };
}
