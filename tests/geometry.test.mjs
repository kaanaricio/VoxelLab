import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'geometry', 'canonical-cases.json'), 'utf8'));

const {
  buildGeometryRecord,
  classifyGeometryKind,
  cross3,
  dot3,
  inPlaneDisplaySize,
  norm3,
  normalize3,
  projectionAlongNormal,
  seriesCompareGroup,
  sliceNormalFromIOP,
  sliceSpacingStatsFromPositions,
  sortDatasetsSpatially,
} = await import('../js/geometry.js');
const { geometryFromSeries } = await import('../js/geometry.js');
const { decodePixelData, transferSyntaxInfo, isDecodable } = await import('../js/dicom-codecs.js');

function approx(actual, expected, tol = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tol, `${actual} !== ${expected}`);
}

function approxList(actual, expected, tol = 1e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => approx(value, expected[index], tol));
}

function approxMatrix(actual, expected, tol = 1e-6) {
  for (let r = 0; r < expected.length; r++) {
    for (let c = 0; c < expected[r].length; c++) {
      approx(actual[r][c], expected[r][c], tol);
    }
  }
}

for (const caseData of FIXTURE.sharedContract.dot3) {
  test(`geometry contract: dot3/${caseData.id}`, () => {
    assert.equal(dot3(caseData.a, caseData.b), caseData.expected);
  });
}

for (const caseData of FIXTURE.sharedContract.cross3) {
  test(`geometry contract: cross3/${caseData.id}`, () => {
    assert.deepEqual(cross3(caseData.a, caseData.b), caseData.expected);
  });
}

for (const caseData of FIXTURE.sharedContract.norm3) {
  test(`geometry contract: norm3/${caseData.id}`, () => {
    approx(norm3(caseData.v), caseData.expected);
  });
}

for (const caseData of FIXTURE.sharedContract.normalize3) {
  test(`geometry contract: normalize3/${caseData.id}`, () => {
    approxList(normalize3(caseData.v), caseData.expected);
  });
}

for (const caseData of FIXTURE.sharedContract.sliceNormalFromIOP) {
  test(`geometry contract: sliceNormalFromIOP/${caseData.id}`, () => {
    approxList(sliceNormalFromIOP(caseData.iop), caseData.expected);
  });
}

for (const caseData of FIXTURE.sharedContract.projectionAlongNormal) {
  test(`geometry contract: projectionAlongNormal/${caseData.id}`, () => {
    approx(projectionAlongNormal(caseData.meta, caseData.normal), caseData.expected);
  });
}

for (const caseData of FIXTURE.sharedContract.sortDatasetsSpatially) {
  test(`geometry contract: sortDatasetsSpatially/${caseData.id}`, () => {
    const sorted = sortDatasetsSpatially(caseData.datasets);
    assert.deepEqual(sorted.map((item) => item.InstanceNumber), caseData.expectedInstanceOrder);
  });
}

for (const caseData of FIXTURE.sharedContract.sliceSpacingStatsFromPositions) {
  test(`geometry contract: sliceSpacingStatsFromPositions/${caseData.id}`, () => {
    assert.deepEqual(sliceSpacingStatsFromPositions(caseData.positions, caseData.normal), caseData.expected);
  });
}

for (const caseData of FIXTURE.sharedContract.classifyGeometryKind) {
  test(`geometry contract: classifyGeometryKind/${caseData.id}`, () => {
    assert.equal(classifyGeometryKind(caseData.spacingStats, caseData.sliceCount), caseData.expected);
  });
}

for (const caseData of FIXTURE.sharedContract.affineLpsFromSeries) {
  test(`geometry contract: affineLpsFromSeries/${caseData.id}`, () => {
    approxMatrix(geometryFromSeries(caseData.series).affineLps, caseData.expected);
  });
}

for (const caseData of FIXTURE.sharedContract.compareGroup) {
  test(`geometry contract: compareGroup/${caseData.id}`, () => {
    const result = seriesCompareGroup(caseData.series);
    if (caseData.expected) assert.equal(result, caseData.expected);
    if (caseData.expectedPrefix) assert.match(result, new RegExp(`^${caseData.expectedPrefix}`));
  });
}

for (const caseData of FIXTURE.sharedContract.buildGeometryRecord) {
  test(`geometry contract: buildGeometryRecord/${caseData.id}`, () => {
    const record = buildGeometryRecord(caseData.input.metas, {
      width: caseData.input.width,
      height: caseData.input.height,
      source: caseData.expected.source,
    });

    assert.equal(record.kind, caseData.expected.kind);
    assert.deepEqual(record.dimensions, caseData.expected.dimensions);
    assert.equal(record.spacingMm.row, caseData.expected.spacingMm.row);
    assert.equal(record.spacingMm.col, caseData.expected.spacingMm.col);
    approx(record.spacingMm.slice, caseData.expected.spacingMm.slice);
    assert.deepEqual(record.sliceSpacingStatsMm, caseData.expected.sliceSpacingStatsMm);
    assert.deepEqual(record.orientation, caseData.expected.orientation);
    assert.deepEqual(record.firstIPP, caseData.expected.firstIPP);
    assert.deepEqual(record.lastIPP, caseData.expected.lastIPP);
    approxMatrix(record.affineLps, caseData.expected.affineLps);
    assert.equal(record.frameOfReferenceUID, caseData.expected.frameOfReferenceUID);
    assert.equal(record.source, caseData.expected.source);
  });
}

test('decodePixelData fails closed for browser JPEG decode paths', async () => {
  const pixels = await decodePixelData(new ArrayBuffer(8), '1.2.840.10008.1.2.4.50', 1, 1, 8);

  assert.equal(pixels, null);
});

test('inPlaneDisplaySize preserves physical row and column spacing in 2d and compare views', () => {
  assert.deepEqual(
    inPlaneDisplaySize({ width: 100, height: 80, pixelSpacing: [0.5, 0.25] }),
    { width: 100, height: 160 },
  );
});

test('transferSyntaxInfo classifies known transfer syntaxes correctly', () => {
  assert.equal(transferSyntaxInfo('1.2.840.10008.1.2').category, 'uncompressed');
  assert.equal(transferSyntaxInfo('1.2.840.10008.1.2.1').category, 'uncompressed');
  assert.equal(transferSyntaxInfo('1.2.840.10008.1.2.4.90').category, 'lossless');
  assert.equal(transferSyntaxInfo('1.2.840.10008.1.2.4.91').category, 'lossy-quantitative');
  assert.equal(transferSyntaxInfo('1.2.840.10008.1.2.4.50').category, 'lossy-display');
  assert.equal(transferSyntaxInfo('1.2.840.10008.1.2.5').category, 'lossless');
  assert.equal(transferSyntaxInfo('1.2.840.10008.1.2.4.100').category, 'unsupported');
  assert.equal(transferSyntaxInfo('9.9.9.9').category, 'unsupported');
});

test('isDecodable returns true for lossless and uncompressed, false for lossy-display', () => {
  assert.equal(isDecodable('1.2.840.10008.1.2'), true);
  assert.equal(isDecodable('1.2.840.10008.1.2.4.90'), true);
  assert.equal(isDecodable('1.2.840.10008.1.2.4.50'), false);
  assert.equal(isDecodable('1.2.840.10008.1.2.4.100'), false);
});
