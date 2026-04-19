import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  classifyUltrasoundSource,
  canScanConvert,
  scanConvertToVolume,
} = await import('../js/ultrasound.js');

test('classifyUltrasoundSource identifies US cine data and blocks volumetric use', () => {
  const result = classifyUltrasoundSource({
    Modality: 'US',
    NumberOfFrames: 32,
  });

  assert.equal(result.modality, 'US');
  assert.equal(result.dataType, 'cine');
  assert.equal(result.volumetricEligible, false);
  assert.equal(result.scanConversionAvailable, false);
  assert.match(result.reason, /cine/i);
});

test('classifyUltrasoundSource identifies still ultrasound image', () => {
  const result = classifyUltrasoundSource({
    Modality: 'US',
    NumberOfFrames: 1,
  });

  assert.equal(result.dataType, 'still');
  assert.equal(result.volumetricEligible, false);
});

test('classifyUltrasoundSource returns null for non-US modalities', () => {
  assert.equal(classifyUltrasoundSource({ Modality: 'CT' }), null);
  assert.equal(classifyUltrasoundSource({ Modality: 'MR' }), null);
});

test('classifyUltrasoundSource detects 3D volume from ImageType', () => {
  const result = classifyUltrasoundSource({
    Modality: 'US',
    NumberOfFrames: 100,
    ImageType: ['ORIGINAL', 'PRIMARY', 'VOLUME'],
  });

  assert.equal(result.dataType, '3d-volume');
  assert.equal(result.volumetricEligible, false);
  assert.match(result.reason, /scan/i);
});

test('classifyUltrasoundSource detects Doppler data type', () => {
  const result = classifyUltrasoundSource({
    Modality: 'US',
    ImageType: ['DERIVED', 'SECONDARY', 'DOPPLER'],
  });

  assert.equal(result.dataType, 'doppler');
  assert.match(result.reason, /not spatial/i);
});

test('calibrated ultrasound source becomes reconstruction-eligible without claiming display volume', () => {
  const result = classifyUltrasoundSource(
    {
      Modality: 'US',
      NumberOfFrames: 24,
    },
    {
      status: 'calibrated',
      source: 'external-json',
      probeGeometry: 'sector',
      mode: 'stacked-sector',
    },
  );

  assert.equal(result.dataType, 'cine');
  assert.equal(result.reconstructionEligible, true);
  assert.equal(result.scanConversionAvailable, true);
  assert.equal(result.volumetricEligible, false);
  assert.equal(canScanConvert(result), true);
});

test('scanConvertToVolume throws until engine is implemented', () => {
  assert.throws(() => scanConvertToVolume(null, null), /not yet implemented/i);
});
