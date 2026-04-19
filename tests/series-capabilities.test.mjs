import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const {
  canUseMpr3D,
  capabilityBlockReason,
  capabilityLabel,
  geometryKindForSeries,
  reconstructionCapabilityForSeries,
} = await import('../js/series-capabilities.js');
const { overlayKindsForSeries, setSeriesOverlayHints } = await import('../js/runtime/overlay-kinds.js');

test('volume stacks remain MPR/3D-capable by default', () => {
  // Shape: manifest.series[*] from bundled CT/MR volume stacks.
  const series = {
    modality: 'MR',
    width: 768,
    height: 768,
    slices: 27,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
    sliceSpacing: 1,
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 26],
    orientation: [1, 0, 0, 0, 1, 0],
  };

  assert.equal(geometryKindForSeries(series), 'volumeStack');
  assert.equal(reconstructionCapabilityForSeries(series), 'display-volume');
  assert.equal(capabilityLabel(series), 'Display volume');
  assert.equal(canUseMpr3D(series), true);
});

test('projection modalities do not become MPR/3D just because multiple files exist', () => {
  // Shape: imported CR/DX/XA series with multiple projection images.
  const series = {
    modality: 'DX',
    width: 2048,
    height: 2048,
    slices: 2,
    pixelSpacing: [0.14, 0.14],
    sliceThickness: 1,
  };

  assert.equal(geometryKindForSeries(series), 'projectionSet');
  assert.equal(reconstructionCapabilityForSeries(series), 'requires-reconstruction');
  assert.equal(canUseMpr3D(series), false);
  assert.match(capabilityBlockReason(series), /reconstructed into a derived volume/);
});

test('single projection modalities are 2D only', () => {
  const series = {
    modality: 'CR',
    width: 2048,
    height: 2048,
    slices: 1,
    pixelSpacing: [0.14, 0.14],
    sliceThickness: 1,
  };

  assert.equal(geometryKindForSeries(series), 'singleProjection');
  assert.equal(reconstructionCapabilityForSeries(series), '2d-only');
  assert.equal(capabilityLabel(series), '2D projection');
  assert.equal(canUseMpr3D(series), false);
});

test('explicit image stacks without geometry stay 2D only', () => {
  const series = {
    geometryKind: 'imageStack',
    reconstructionCapability: '2d-only',
    width: 512,
    height: 512,
    slices: 8,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
  };

  assert.equal(capabilityLabel(series), 'Image stack · 2D only');
  assert.equal(canUseMpr3D(series), false);
  assert.match(capabilityBlockReason(series), /missing reliable patient-space slice geometry/);
});

test('implicit non-projection image stacks without geometry do not default to display volume', () => {
  const series = {
    modality: 'MR',
    width: 512,
    height: 512,
    slices: 8,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
    sliceSpacingRegular: false,
  };

  assert.equal(geometryKindForSeries(series), 'imageStack');
  assert.equal(reconstructionCapabilityForSeries(series), '2d-only');
  assert.equal(capabilityLabel(series), 'Image stack · 2D only');
  assert.equal(canUseMpr3D(series), false);
});

test('single non-projection images stay 2D only', () => {
  const series = {
    modality: 'MR',
    width: 512,
    height: 512,
    slices: 1,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
  };

  assert.equal(geometryKindForSeries(series), 'singleImage');
  assert.equal(reconstructionCapabilityForSeries(series), '2d-only');
  assert.equal(capabilityLabel(series), 'Single image · 2D only');
  assert.equal(canUseMpr3D(series), false);
  assert.match(capabilityBlockReason(series), /enough depth/i);
});

test('irregular slice spacing blocks MPR/3D even when a stack looks volumetric', () => {
  const series = {
    geometryKind: 'volumeStack',
    reconstructionCapability: 'display-volume',
    width: 512,
    height: 512,
    slices: 3,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
    sliceSpacingRegular: false,
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 3],
    orientation: [1, 0, 0, 0, 1, 0],
  };

  assert.equal(canUseMpr3D(series), false);
  assert.match(capabilityBlockReason(series), /irregular slice spacing/i);
});

test('derived volumes regain MPR/3D only with complete voxel geometry', () => {
  const series = {
    geometryKind: 'derivedVolume',
    reconstructionCapability: 'display-volume',
    sourceProjectionSetId: 'projection_set_1',
    width: 512,
    height: 512,
    slices: 128,
    pixelSpacing: [0.5, 0.5],
    sliceThickness: 0.5,
    sliceSpacing: 0.5,
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 63.5],
    orientation: [1, 0, 0, 0, 1, 0],
  };

  assert.equal(capabilityLabel(series), 'Derived volume');
  assert.equal(canUseMpr3D(series), true);
});

test('calibrated ultrasound sources report reconstruction required without claiming volume display', () => {
  const series = {
    modality: 'US',
    width: 128,
    height: 128,
    slices: 24,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
    ultrasoundCalibration: {
      status: 'calibrated',
      mode: 'stacked-sector',
      probeGeometry: 'sector',
      source: 'external-json',
    },
  };

  assert.equal(geometryKindForSeries(series), 'ultrasoundSource');
  assert.equal(reconstructionCapabilityForSeries(series), 'requires-reconstruction');
  assert.equal(capabilityLabel(series), 'Ultrasound source · reconstruction required');
  assert.equal(canUseMpr3D(series), false);
  assert.match(capabilityBlockReason(series), /scan-converted/i);
});

test('overlay capability consumer normalizes legacy flags into canonical overlay kinds', () => {
  // Shape: viewer series entry with today’s manifest booleans.
  const series = {
    hasSeg: true,
    hasRegions: true,
    hasSym: true,
  };

  const overlays = overlayKindsForSeries(series);

  assert.deepEqual(overlays.availableKinds, ['tissue', 'labels', 'heatmap']);
  assert.equal(overlays.byKind.tissue.manifestFlag, 'hasSeg');
  assert.equal(overlays.byKind.labels.manifestFlag, 'hasRegions');
  assert.equal(overlays.byKind.heatmap.manifestFlag, 'hasSym');
  assert.equal(overlays.byKind.fusion.available, false);
});

test('overlay capability consumer preserves canonical local SEG hints behind the labels slot', () => {
  const series = { hasRegions: true };
  setSeriesOverlayHints(series, {
    labels: { source: 'dicom-seg', legacyKinds: ['seg'] },
  });

  const overlays = overlayKindsForSeries(series);

  assert.equal(overlays.byKind.labels.source, 'dicom-seg');
  assert.deepEqual(overlays.byKind.labels.legacyKinds, ['regions', 'seg']);
  assert.deepEqual(overlays.availableKinds, ['labels']);
});
