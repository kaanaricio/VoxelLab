// SEG / RTSTRUCT / SR / … overlay binding: FoR UID + affine checks. Use this module
// for validation instead of one-off checks.

import { geometryFromSeries } from './geometry.js';

const DERIVED_KINDS = new Set(['seg', 'rtstruct', 'sr', 'rtdose', 'registration', 'derived-volume']);

const AFFINE_COMPATIBILITY = new Set(['exact', 'within-tolerance', 'requires-registration', 'incompatible']);
const DERIVED_REGISTRY_KEY = 'mri-viewer/derived-objects/v1';
const DERIVED_REGISTRY_VERSION = 1;

// In-memory fallback when localStorage is unavailable (tests, workers).
const MEMORY_STORAGE = new Map();

function hasTrustworthyGeometry(series) {
  return Array.isArray(series?.orientation) && series.orientation.length >= 6
    && Array.isArray(series?.firstIPP) && series.firstIPP.length >= 3
    && Array.isArray(series?.lastIPP) && series.lastIPP.length >= 3
    && Number(series?.slices || 0) > 0
    && Number(series?.pixelSpacing?.[0] || 0) > 0
    && Number(series?.pixelSpacing?.[1] || 0) > 0
    && series?.sliceSpacingRegular !== false;
}

export function validateDerivedObjectBinding(binding) {
  const errors = [];

  if (!binding || typeof binding !== 'object') return ['binding: expected object'];

  if (!DERIVED_KINDS.has(binding.derivedKind)) {
    errors.push(`derivedKind: expected one of ${[...DERIVED_KINDS].sort().join(', ')}`);
  }
  if (typeof binding.frameOfReferenceUID !== 'string' || !binding.frameOfReferenceUID) {
    errors.push('frameOfReferenceUID: expected non-empty string');
  }
  const hasSourceUid = typeof binding.sourceSeriesUID === 'string' && !!binding.sourceSeriesUID;
  const hasSourceSlug = typeof binding.sourceSeriesSlug === 'string' && !!binding.sourceSeriesSlug;
  if (!hasSourceUid && !hasSourceSlug) {
    errors.push('sourceSeriesUID or sourceSeriesSlug: expected non-empty string');
  }
  if (typeof binding.requiresRegistration !== 'boolean') {
    errors.push('requiresRegistration: expected boolean');
  }
  if (!AFFINE_COMPATIBILITY.has(binding.affineCompatibility)) {
    errors.push(`affineCompatibility: expected one of ${[...AFFINE_COMPATIBILITY].sort().join(', ')}`);
  }

  if (['requires-registration', 'incompatible'].includes(binding.affineCompatibility) && !binding.requiresRegistration) {
    errors.push('requiresRegistration must be true when affineCompatibility requires registration');
  }

  return errors;
}

function readStorage(key) {
  if (typeof localStorage === 'undefined') return String(MEMORY_STORAGE.get(key) || '');
  try { return String(localStorage.getItem(key) || ''); }
  catch { return ''; }
}

function writeStorage(key, json) {
  if (typeof localStorage === 'undefined') {
    MEMORY_STORAGE.set(key, json);
    return true;
  }
  try {
    localStorage.setItem(key, json);
    return true;
  } catch {
    return false;
  }
}

export function storageJsonGet(key, fallback = {}) {
  const raw = readStorage(String(key || ''));
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function storageJsonSet(key, value) {
  return writeStorage(String(key || ''), JSON.stringify(value));
}

export function derivedSourceRefFromSeries(series) {
  const sourceSeriesUID = typeof series?.sourceSeriesUID === 'string' && series.sourceSeriesUID
    ? series.sourceSeriesUID
    : '';
  const sourceSeriesSlug = typeof series?.slug === 'string' && series.slug
    ? series.slug
    : '';
  const sourceKey = sourceSeriesUID ? `uid:${sourceSeriesUID}` : sourceSeriesSlug ? `slug:${sourceSeriesSlug}` : '';
  return { sourceSeriesUID, sourceSeriesSlug, sourceKey };
}

function registryId(binding, objectUID) {
  const sourceKey = binding?.sourceSeriesUID
    ? `uid:${binding.sourceSeriesUID}`
    : binding?.sourceSeriesSlug
      ? `slug:${binding.sourceSeriesSlug}`
      : '';
  if (!sourceKey || !objectUID) return '';
  return `${sourceKey}|obj:${objectUID}`;
}

function emptyRegistry() {
  return { version: DERIVED_REGISTRY_VERSION, entries: {} };
}

export function loadDerivedRegistry() {
  const raw = readStorage(DERIVED_REGISTRY_KEY);
  if (!raw) return emptyRegistry();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyRegistry();
    const entries = parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    return {
      version: DERIVED_REGISTRY_VERSION,
      entries,
    };
  } catch {
    return emptyRegistry();
  }
}

export function saveDerivedRegistry(registry) {
  const normalized = {
    version: DERIVED_REGISTRY_VERSION,
    entries: registry?.entries && typeof registry.entries === 'object' ? registry.entries : {},
  };
  const persisted = writeStorage(DERIVED_REGISTRY_KEY, JSON.stringify(normalized));
  return { registry: normalized, persisted };
}

export function clearDerivedRegistry() {
  saveDerivedRegistry(emptyRegistry());
}

export function validateDerivedRegistryEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return ['entry: expected object'];
  if (typeof entry.id !== 'string' || !entry.id) errors.push('id: expected non-empty string');
  if (typeof entry.objectUID !== 'string' || !entry.objectUID) errors.push('objectUID: expected non-empty string');
  if (typeof entry.name !== 'string' || !entry.name) errors.push('name: expected non-empty string');
  if (typeof entry.modality !== 'string' || !entry.modality) errors.push('modality: expected non-empty string');
  if (!Number.isFinite(Number(entry.importedAt || 0))) errors.push('importedAt: expected finite number');
  const bindingErrors = validateDerivedObjectBinding(entry.binding);
  for (const bindingError of bindingErrors) errors.push(`binding.${bindingError}`);
  if (entry.id && entry.objectUID && entry.binding) {
    const expectedId = registryId(entry.binding, entry.objectUID);
    if (!expectedId) errors.push('binding source reference: expected sourceSeriesUID or sourceSeriesSlug');
    else if (expectedId !== entry.id) errors.push('id: does not match binding + objectUID');
  }
  return errors;
}

export function upsertDerivedRegistryEntry(entry) {
  const errors = validateDerivedRegistryEntry(entry);
  if (errors.length) throw new Error(`Invalid derived registry entry: ${errors.join('; ')}`);
  const registry = loadDerivedRegistry();
  registry.entries[entry.id] = entry;
  const { persisted } = saveDerivedRegistry(registry);
  return { entry, persisted };
}

export function getDerivedRegistryEntry(sourceSeries, objectUID) {
  const sourceRef = derivedSourceRefFromSeries(sourceSeries);
  const id = registryId({
    sourceSeriesUID: sourceRef.sourceSeriesUID || undefined,
    sourceSeriesSlug: sourceRef.sourceSeriesSlug || undefined,
  }, String(objectUID || ''));
  if (!id) return null;
  const registry = loadDerivedRegistry();
  return registry.entries[id] || null;
}

export function listDerivedRegistryEntriesForSeries(sourceSeries) {
  const { sourceSeriesUID, sourceSeriesSlug } = derivedSourceRefFromSeries(sourceSeries);
  const registry = loadDerivedRegistry();
  const entries = Object.values(registry.entries).filter((entry) => {
    const binding = entry?.binding || {};
    return (sourceSeriesUID && binding.sourceSeriesUID === sourceSeriesUID)
      || (sourceSeriesSlug && binding.sourceSeriesSlug === sourceSeriesSlug);
  });
  entries.sort((a, b) => Number(a.importedAt || 0) - Number(b.importedAt || 0));
  return entries;
}

export function assessAffineCompatibility(sourceSeries, derivedSeries, toleranceMm = 0.1) {
  const sourceGeo = geometryFromSeries(sourceSeries);
  const derivedGeo = geometryFromSeries(derivedSeries);

  const sourceFor = sourceGeo.frameOfReferenceUID;
  const derivedFor = derivedGeo.frameOfReferenceUID;
  if (!sourceFor || !derivedFor || sourceFor !== derivedFor) {
    return 'incompatible';
  }
  if (!hasTrustworthyGeometry(sourceSeries) || !hasTrustworthyGeometry(derivedSeries)) {
    return 'requires-registration';
  }

  const srcM = sourceGeo.affineLps;
  const derM = derivedGeo.affineLps;
  let maxLinearDiff = 0;
  let maxTranslationDiffMm = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      maxLinearDiff = Math.max(maxLinearDiff, Math.abs(srcM[r][c] - derM[r][c]));
    }
    maxTranslationDiffMm = Math.max(maxTranslationDiffMm, Math.abs(srcM[r][3] - derM[r][3]));
  }

  if (maxLinearDiff < 1e-6 && maxTranslationDiffMm < 1e-6) return 'exact';
  if (maxLinearDiff < 1e-4 && maxTranslationDiffMm < toleranceMm) return 'within-tolerance';
  return 'requires-registration';
}

export function buildDerivedObjectBinding(derivedKind, sourceSeries, derivedSeries) {
  const compatibility = assessAffineCompatibility(sourceSeries, derivedSeries);
  const binding = {
    derivedKind,
    frameOfReferenceUID: String(derivedSeries.frameOfReferenceUID || ''),
    requiresRegistration: compatibility === 'requires-registration' || compatibility === 'incompatible',
    affineCompatibility: compatibility,
  };
  if (sourceSeries.sourceSeriesUID) binding.sourceSeriesUID = String(sourceSeries.sourceSeriesUID);
  else if (sourceSeries.slug) binding.sourceSeriesSlug = String(sourceSeries.slug);
  return binding;
}

export function buildDerivedRegistryEntry({
  derivedKind,
  sourceSeries,
  derivedSeries,
  objectUID,
  name,
  modality,
  payload,
  importedAt = Date.now(),
}) {
  const binding = buildDerivedObjectBinding(derivedKind, sourceSeries, derivedSeries);
  const id = registryId(binding, String(objectUID || ''));
  return {
    id,
    objectUID: String(objectUID || ''),
    name: String(name || `${String(derivedKind || '').toUpperCase()} import`),
    modality: String(modality || String(derivedKind || '').toUpperCase()),
    importedAt: Number(importedAt || Date.now()),
    binding,
    payload: payload || null,
  };
}
