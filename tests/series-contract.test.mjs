import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const {
  applyPublicSeriesUrls,
  mergeSeriesIntoManifest,
  normalizeCloudProjectionSetEntry,
  normalizeCloudUploadResult,
} = await import('../js/series-contract.js');

function validCloudSeries(overrides = {}) {
  return {
    slug: 'cloud_job123',
    name: 'Cloud CT',
    description: '2 slices',
    slices: 2,
    width: 4,
    height: 4,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
    hasRaw: true,
    ...overrides,
  };
}

test('applyPublicSeriesUrls backfills trusted cloud asset paths from slug', () => {
  const entry = applyPublicSeriesUrls(validCloudSeries({ hasRegions: true }), 'https://r2.example/');

  assert.equal(entry.sliceUrlBase, 'https://r2.example/data/cloud_job123');
  assert.equal(entry.rawUrl, 'https://r2.example/cloud_job123.raw.zst');
  assert.equal(entry.regionUrlBase, 'https://r2.example/data/cloud_job123_regions');
  assert.equal(entry.regionMetaUrl, 'https://r2.example/data/cloud_job123_regions.json');
});

test('mergeSeriesIntoManifest does not treat sourceSeriesUID as an identity key', () => {
  const manifest = {
    patient: 'anonymous',
    studyDate: '',
    series: [{ slug: 'cloud_old', sourceSeriesUID: '1.2.3', name: 'Old' }],
  };

  const idx = mergeSeriesIntoManifest(manifest, {
    slug: 'cloud_new',
    sourceSeriesUID: '1.2.3',
    name: 'New',
  });

  assert.equal(idx, 1);
  assert.equal(manifest.series.length, 2);
  assert.equal(manifest.series[0].slug, 'cloud_old');
  assert.equal(manifest.series[1].slug, 'cloud_new');
  assert.equal(manifest.series[1].name, 'New');
});

test('normalizeCloudProjectionSetEntry accepts canonical reconstruction statuses and safe ids only', () => {
  const projectionSet = normalizeCloudProjectionSetEntry({
    id: 'projection_set_1',
    name: 'Projection Source',
    modality: 'XA',
    projectionKind: 'cbct',
    projectionCount: 2,
    reconstructionStatus: 'reconstruction-pending',
  }, { sourceProjectionSetId: 'projection_set_1' });

  assert.equal(projectionSet.reconstructionStatus, 'reconstruction-pending');
  assert.throws(
    () => normalizeCloudProjectionSetEntry({
      id: '../bad',
      name: 'Projection Source',
      modality: 'XA',
      projectionKind: 'cbct',
      projectionCount: 2,
      reconstructionStatus: 'reconstructed',
    }),
    /safe projection set id/i,
  );
});

test('normalizeCloudUploadResult binds job identity and projection-set linkage', () => {
  const result = normalizeCloudUploadResult({
    slug: 'cloud_projection_job123',
    projection_set_entry: {
      id: 'projection_set_1',
      name: 'Projection Source',
      modality: 'XA',
      projectionKind: 'cbct',
      projectionCount: 2,
      reconstructionStatus: 'requires-calibration',
    },
    series_entry: validCloudSeries({
      slug: 'cloud_projection_job123',
      name: 'Projection Result',
      description: 'Derived volume',
      geometryKind: 'derivedVolume',
      sourceProjectionSetId: 'projection_set_1',
    }),
  }, {
    jobId: 'job_123',
    publicBase: 'https://r2.example/',
  });

  assert.equal(result.slug, 'cloud_projection_job123');
  assert.equal(result.seriesEntry.sourceJobId, 'job_123');
  assert.equal(result.seriesEntry.sliceUrlBase, 'https://r2.example/data/cloud_projection_job123');
  assert.equal(result.projectionSetEntry.id, 'projection_set_1');
});
