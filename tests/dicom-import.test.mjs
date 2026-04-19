import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const {
  cacheLocalRawVolume,
  injectManifestSeries,
  touchLocalRawVolume,
} = await import('../js/dicom-import.js');
const { state } = await import('../js/state.js');

function manifestWithSeries(series = []) {
  return { patient: 'anonymous', studyDate: '', series: [...series] };
}

test('injectManifestSeries inserts a new imported entry', () => {
  const manifest = manifestWithSeries();
  const idx = injectManifestSeries(manifest, { slug: 'cloud_job123', name: 'Cloud CT' });

  assert.equal(idx, 0);
  assert.equal(manifest.series.length, 1);
  assert.equal(manifest.series[0].slug, 'cloud_job123');
});

test('injectManifestSeries backfills a canonical compare group for new imports', () => {
  const manifest = manifestWithSeries();

  const idx = injectManifestSeries(manifest, {
    slug: 'cloud_job123',
    name: 'Cloud CT',
    frameOfReferenceUID: '1.2.840.same',
  });

  assert.equal(idx, 0);
  assert.equal(manifest.series[0].group, 'for:1.2.840.same');
});

test('injectManifestSeries updates an existing entry by slug instead of appending', () => {
  const manifest = manifestWithSeries([
    { slug: 'cloud_job123', name: 'Old Name', hasAnalysis: true },
  ]);

  const idx = injectManifestSeries(manifest, { slug: 'cloud_job123', name: 'New Name' });

  assert.equal(idx, 0);
  assert.equal(manifest.series.length, 1);
  assert.equal(manifest.series[0].name, 'New Name');
  assert.equal(manifest.series[0].hasAnalysis, true);
});

test('injectManifestSeries updates an existing entry by job identity alias', () => {
  const manifest = manifestWithSeries([
    { slug: 'cloud_old', sourceJobId: 'job_123', description: 'Old result' },
  ]);

  const idx = injectManifestSeries(manifest, { slug: 'cloud_new', job_id: 'job_123', description: 'New result' });

  assert.equal(idx, 0);
  assert.equal(manifest.series.length, 1);
  assert.equal(manifest.series[0].slug, 'cloud_new');
  assert.equal(manifest.series[0].sourceJobId, 'job_123');
  assert.equal(manifest.series[0].job_id, 'job_123');
  assert.equal(manifest.series[0].description, 'New result');
});

test('injectManifestSeries rejects ambiguous matches across slug and job identity', () => {
  const manifest = manifestWithSeries([
    { slug: 'cloud_slug_match', name: 'By slug' },
    { slug: 'cloud_job_match', sourceJobId: 'job_123', name: 'By job id' },
  ]);

  assert.throws(
    () => injectManifestSeries(manifest, { slug: 'cloud_slug_match', jobId: 'job_123', name: 'Ambiguous' }),
    /matches multiple existing entries/i,
  );
});

test('injectManifestSeries rejects derived entries that reference an unknown projection set', () => {
  const manifest = manifestWithSeries();

  assert.throws(
    () => injectManifestSeries(manifest, {
      slug: 'cloud_projection_job123',
      name: 'Derived volume',
      sourceProjectionSetId: 'projection_set_missing',
    }),
    /unknown projection set/i,
  );
});

test('injectManifestSeries appends derived projection reconstructions that share sourceSeriesUID', () => {
  const manifest = manifestWithSeries([
    {
      slug: 'local_projection',
      name: 'Projection source',
      sourceSeriesUID: '1.2.3',
      sourceProjectionSetId: 'projection_set_1',
    },
  ]);
  manifest.projectionSets = [
    {
      id: 'projection_set_1',
      name: 'Projection registry',
      modality: 'XA',
      projectionKind: 'cbct',
      projectionCount: 2,
      reconstructionCapability: 'requires-reconstruction',
      reconstructionStatus: 'reconstructed',
      renderability: '2d',
    },
  ];

  const idx = injectManifestSeries(manifest, {
    slug: 'cloud_projection_job123',
    name: 'Derived volume',
    sourceSeriesUID: '1.2.3',
    sourceProjectionSetId: 'projection_set_1',
  });

  assert.equal(idx, 1);
  assert.deepEqual(manifest.series.map((series) => series.slug), [
    'local_projection',
    'cloud_projection_job123',
  ]);
});

test('cacheLocalRawVolume evicts least-recently-used entries over budget', () => {
  state._localRawVolumes = {};
  state._localRawVolumeOrder = [];
  state.manifest = { series: [] };
  state.seriesIdx = 0;
  const volumeA = new Float32Array(32);
  const volumeB = new Float32Array(32);
  const volumeC = new Float32Array(32);
  const budget = volumeA.byteLength * 2;

  cacheLocalRawVolume('local_a', volumeA, { maxBytes: budget });
  cacheLocalRawVolume('local_b', volumeB, { maxBytes: budget });
  touchLocalRawVolume('local_a');
  cacheLocalRawVolume('local_c', volumeC, { maxBytes: budget });

  assert.deepEqual(Object.keys(state._localRawVolumes).sort(), ['local_a', 'local_c']);
  assert.deepEqual(state._localRawVolumeOrder, ['local_a', 'local_c']);
});
