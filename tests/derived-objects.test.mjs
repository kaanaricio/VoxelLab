import assert from 'node:assert/strict';
import { test } from 'node:test';

function memoryStorage() {
  const store = new Map();
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(String(key), String(value)); },
    removeItem(key) { store.delete(String(key)); },
    clear() { store.clear(); },
  };
}

globalThis.localStorage = memoryStorage();

const {
  validateDerivedObjectBinding,
  assessAffineCompatibility,
  buildDerivedObjectBinding,
  buildDerivedRegistryEntry,
  clearDerivedRegistry,
  getDerivedRegistryEntry,
  listDerivedRegistryEntriesForSeries,
  upsertDerivedRegistryEntry,
} = await import('../js/derived-objects.js');

test('validateDerivedObjectBinding accepts a valid binding', () => {
  const errors = validateDerivedObjectBinding({
    derivedKind: 'seg',
    frameOfReferenceUID: '1.2.3',
    sourceSeriesUID: '1.2.3.4',
    requiresRegistration: false,
    affineCompatibility: 'exact',
  });

  assert.deepEqual(errors, []);
});

test('validateDerivedObjectBinding accepts a slug fallback when no DICOM UID exists', () => {
  const errors = validateDerivedObjectBinding({
    derivedKind: 'seg',
    frameOfReferenceUID: '1.2.3',
    sourceSeriesSlug: 'local_seg_source',
    requiresRegistration: false,
    affineCompatibility: 'exact',
  });

  assert.deepEqual(errors, []);
});

test('validateDerivedObjectBinding rejects invalid derivedKind', () => {
  const errors = validateDerivedObjectBinding({
    derivedKind: 'magic',
    frameOfReferenceUID: '1.2.3',
    sourceSeriesUID: '1.2.3.4',
    requiresRegistration: false,
    affineCompatibility: 'exact',
  });

  assert.ok(errors.some(e => e.includes('derivedKind')));
});

test('validateDerivedObjectBinding accepts RT Dose as a first-class derived kind', () => {
  const errors = validateDerivedObjectBinding({
    derivedKind: 'rtdose',
    frameOfReferenceUID: '1.2.3',
    sourceSeriesUID: '1.2.3.4',
    requiresRegistration: true,
    affineCompatibility: 'requires-registration',
  });

  assert.deepEqual(errors, []);
});

test('validateDerivedObjectBinding rejects incompatible without requiresRegistration', () => {
  const errors = validateDerivedObjectBinding({
    derivedKind: 'seg',
    frameOfReferenceUID: '1.2.3',
    sourceSeriesUID: '1.2.3.4',
    requiresRegistration: false,
    affineCompatibility: 'incompatible',
  });

  assert.ok(errors.some(e => e.includes('requiresRegistration must be true')));
});

test('validateDerivedObjectBinding rejects requires-registration without requiresRegistration', () => {
  const errors = validateDerivedObjectBinding({
    derivedKind: 'seg',
    frameOfReferenceUID: '1.2.3',
    sourceSeriesUID: '1.2.3.4',
    requiresRegistration: false,
    affineCompatibility: 'requires-registration',
  });

  assert.ok(errors.some(e => e.includes('requiresRegistration must be true')));
});

test('assessAffineCompatibility returns exact for identical geometry', () => {
  const series = {
    pixelSpacing: [0.5, 0.5],
    sliceSpacing: 1.0,
    slices: 3,
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 2],
    orientation: [1, 0, 0, 0, 1, 0],
    frameOfReferenceUID: '1.2.3',
  };

  assert.equal(assessAffineCompatibility(series, series), 'exact');
});

test('assessAffineCompatibility returns incompatible for different FoR', () => {
  const source = {
    pixelSpacing: [0.5, 0.5], sliceSpacing: 1.0, slices: 3,
    firstIPP: [0, 0, 0], lastIPP: [0, 0, 2],
    orientation: [1, 0, 0, 0, 1, 0],
    frameOfReferenceUID: '1.2.3',
  };
  const derived = { ...source, frameOfReferenceUID: '9.9.9' };

  assert.equal(assessAffineCompatibility(source, derived), 'incompatible');
});

test('assessAffineCompatibility does not treat rotation drift as millimeter tolerance', () => {
  const source = {
    pixelSpacing: [1, 1], sliceSpacing: 1, slices: 3,
    firstIPP: [0, 0, 0], lastIPP: [0, 0, 2],
    orientation: [1, 0, 0, 0, 1, 0],
    frameOfReferenceUID: '1.2.3',
  };
  const derived = {
    ...source,
    orientation: [0.999, 0.001, 0, -0.001, 0.999, 0],
  };

  assert.equal(assessAffineCompatibility(source, derived), 'requires-registration');
});

test('assessAffineCompatibility downgrades to requires-registration when geometry is incomplete', () => {
  const source = {
    pixelSpacing: [0.5, 0.5], sliceSpacing: 1.0, slices: 3,
    firstIPP: [0, 0, 0], lastIPP: [0, 0, 2],
    orientation: [1, 0, 0, 0, 1, 0],
    frameOfReferenceUID: '1.2.3',
  };
  const derived = {
    pixelSpacing: [0.5, 0.5], sliceSpacing: 1.0, slices: 3,
    frameOfReferenceUID: '1.2.3',
  };

  assert.equal(assessAffineCompatibility(source, derived), 'requires-registration');
});

test('buildDerivedObjectBinding creates a valid binding for co-registered data', () => {
  const source = {
    slug: 'ct_main',
    pixelSpacing: [0.5, 0.5], sliceSpacing: 1.0, slices: 3,
    firstIPP: [0, 0, 0], lastIPP: [0, 0, 2],
    orientation: [1, 0, 0, 0, 1, 0],
    frameOfReferenceUID: '1.2.3',
  };
  const derived = { ...source, slug: 'seg_result' };

  const binding = buildDerivedObjectBinding('seg', source, derived);
  const errors = validateDerivedObjectBinding(binding);

  assert.deepEqual(errors, []);
  assert.equal(binding.derivedKind, 'seg');
  assert.equal(binding.affineCompatibility, 'exact');
  assert.equal(binding.requiresRegistration, false);
  assert.equal(binding.sourceSeriesSlug, 'ct_main');
});

test('derived registry persists entries and looks them up by source binding', () => {
  clearDerivedRegistry();
  const source = {
    slug: 'ct_main',
    sourceSeriesUID: '1.2.840.1',
    pixelSpacing: [0.5, 0.5], sliceSpacing: 1.0, slices: 3,
    firstIPP: [0, 0, 0], lastIPP: [0, 0, 2],
    orientation: [1, 0, 0, 0, 1, 0],
    frameOfReferenceUID: '1.2.3',
  };
  const derived = { ...source, slug: 'seg_result' };
  const entry = buildDerivedRegistryEntry({
    derivedKind: 'seg',
    sourceSeries: source,
    derivedSeries: derived,
    objectUID: '9.8.7',
    name: 'SEG import',
    modality: 'SEG',
    payload: { format: 'seg-overlay-v1', sparseSlices: [], regionMeta: { regions: {}, colors: {} } },
    importedAt: 1712345678901,
  });
  const persisted = upsertDerivedRegistryEntry(entry);

  const listed = listDerivedRegistryEntriesForSeries(source);
  assert.equal(listed.length, 1);
  assert.equal(persisted.persisted, true);
  assert.equal(listed[0].id, entry.id);
  assert.equal(listed[0].binding.derivedKind, 'seg');
  assert.equal(listed[0].payload.format, 'seg-overlay-v1');

  const resolved = getDerivedRegistryEntry(source, '9.8.7');
  assert.equal(resolved?.name, 'SEG import');
  assert.equal(resolved?.modality, 'SEG');
});

test('derived registry reports when browser storage persistence fails', () => {
  clearDerivedRegistry();
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { return null; },
    setItem() { throw new Error('quota'); },
    removeItem() {},
    clear() {},
  };
  try {
    const source = {
      slug: 'ct_main',
      sourceSeriesUID: '1.2.840.1',
      pixelSpacing: [0.5, 0.5], sliceSpacing: 1.0, slices: 3,
      firstIPP: [0, 0, 0], lastIPP: [0, 0, 2],
      orientation: [1, 0, 0, 0, 1, 0],
      frameOfReferenceUID: '1.2.3',
    };
    const entry = buildDerivedRegistryEntry({
      derivedKind: 'seg',
      sourceSeries: source,
      derivedSeries: source,
      objectUID: '9.8.7.6',
      name: 'SEG import',
      modality: 'SEG',
    });
    const result = upsertDerivedRegistryEntry(entry);
    assert.equal(result.persisted, false);
  } finally {
    globalThis.localStorage = original;
  }
});
