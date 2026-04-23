import assert from 'node:assert/strict';
import { test } from 'node:test';

const { normalizeRegionMeta, regionLabelName } = await import('../js/region-meta.js');

test('normalizeRegionMeta backfills legend entries from regions metadata', () => {
  const normalized = normalizeRegionMeta({
    colors: { 7: [1, 2, 3] },
    regions: { 7: { name: 'Thalamus' } },
  });

  assert.equal(normalized.legend[7], 'Thalamus');
});

test('regionLabelName resolves both legacy legend and modern regions shapes', () => {
  assert.equal(regionLabelName({ legend: { 4: 'Legacy name' } }, 4), 'Legacy name');
  assert.equal(regionLabelName({ regions: { 9: { name: 'Modern name' } } }, 9), 'Modern name');
});
