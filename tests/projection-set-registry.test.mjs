import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const {
  injectLocalSeries,
} = await import('../js/dicom-import.js');
const {
  localDisplayEntryForImport,
  projectionSetRecordForEntry,
  registerProjectionSet,
} = await import('../js/series-contract.js');
const { state } = await import('../js/state.js');

test('projectionSetRecordForEntry preserves projection source as non-volume input', () => {
  const entry = {
    slug: 'local_projection',
    name: 'C-arm sweep',
    modality: 'XA',
    slices: 120,
    geometryKind: 'projectionSet',
    sourceSeriesUID: '1.2.3',
  };

  const record = projectionSetRecordForEntry(entry);

  assert.equal(record.id, 'local_projection_projection_set');
  assert.equal(record.sourceSeriesSlug, 'local_projection');
  assert.equal(record.projectionKind, 'xray');
  assert.equal(record.projectionCount, 120);
  assert.equal(record.reconstructionCapability, 'requires-reconstruction');
  assert.equal(record.reconstructionStatus, 'requires-calibration');
  assert.equal(record.renderability, '2d');
  assert.deepEqual(record.missingGeometry, [
    'projectionMatrices',
    'sourceDetectorGeometry',
    'isocenter',
    'calibrationStatus',
  ]);
});

test('registerProjectionSet upserts runtime and manifest projection set records', () => {
  const manifest = { series: [], projectionSets: [] };
  const entry = {
    slug: 'local_dx',
    name: 'DX pair',
    modality: 'DX',
    slices: 2,
    isProjectionSet: true,
  };

  const first = registerProjectionSet(manifest, entry);
  const second = registerProjectionSet(manifest, { ...entry, slices: 3 });

  assert.equal(first.id, 'local_dx_projection_set');
  assert.equal(second.projectionCount, 3);
  assert.equal(manifest.projectionSets.length, 1);
  assert.equal(manifest.projectionSets[0].projectionCount, 3);
  assert.equal(state.projectionSets, undefined);
});

test('localDisplayEntryForImport keeps projection-set sources 2D in manifest series', () => {
  const entry = {
    slug: 'local_dx',
    name: 'DX pair',
    modality: 'DX',
    slices: 2,
    geometryKind: 'projectionSet',
    reconstructionCapability: 'requires-reconstruction',
    renderability: '2d',
    isProjectionSet: true,
  };
  const record = projectionSetRecordForEntry(entry);

  const displayEntry = localDisplayEntryForImport(entry, record);

  assert.equal(displayEntry.slug, 'local_dx');
  assert.equal(displayEntry.geometryKind, 'imageStack');
  assert.equal(displayEntry.reconstructionCapability, '2d-only');
  assert.equal(displayEntry.renderability, '2d');
  assert.equal(displayEntry.isProjectionSet, false);
  assert.equal(displayEntry.sourceProjectionSetId, 'local_dx_projection_set');
});

test('injectLocalSeries retains local raw volumes for revisit paths', () => {
  const manifest = { series: [] };
  const entry = {
    slug: 'local_ct',
    name: 'Local CT',
    geometryKind: 'imageStack',
    reconstructionCapability: '2d-only',
    renderability: '2d',
  };
  const sliceCanvases = [{ toDataURL: () => 'data:image/png;base64,AA==' }];
  const rawVolume = new Float32Array([0.1, 0.2, 0.3]);
  const PrevImage = globalThis.Image;
  globalThis.Image = class {
    constructor() {
      this.src = '';
    }
  };
  state._localStacks = {};
  state._localRawVolumes = {};

  try {
    injectLocalSeries(manifest, entry, sliceCanvases, rawVolume);
  } finally {
    globalThis.Image = PrevImage;
  }

  assert.equal(state._localStacks.local_ct.length, 1);
  assert.equal(state._localRawVolumes.local_ct, rawVolume);
});
