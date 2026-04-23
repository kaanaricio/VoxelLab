import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const { state } = await import('../js/state.js');
const { renderInspectionReadout, resolveVoxelInspection } = await import('../js/inspection-readout.js');

test('resolveVoxelInspection returns consistent tissue and region answers for one voxel', () => {
  state.manifest = {
    series: [{
      slug: 'inspect_case',
      width: 2,
      height: 2,
      slices: 2,
      hasSeg: true,
      hasRegions: true,
      firstIPP: [0, 0, 0],
      lastIPP: [0, 0, 1],
      orientation: [1, 0, 0, 0, 1, 0],
      pixelSpacing: [1, 1],
    }],
  };
  state.seriesIdx = 0;
  state.useSeg = true;
  state.useRegions = true;
  state.segVoxels = Uint8Array.from([0, 1, 2, 3, 0, 0, 0, 0]);
  state.regionVoxels = Uint8Array.from([0, 9, 0, 0, 0, 0, 0, 0]);
  state.regionMeta = { legend: { 9: 'Thalamus' }, regions: { 9: { name: 'Thalamus' } } };
  state.hrVoxels = Float32Array.from([0.1, 0.5, 0.2, 0.3, 0, 0, 0, 0]);
  state.stats = null;

  const info = resolveVoxelInspection(state.manifest.series[0], 1, 0, 0);

  assert.equal(info.intensity, 128);
  assert.equal(info.regionName, 'Thalamus');
  assert.equal(info.tissueName, 'CSF');
  assert.equal(info.lpsText, '1.0L 0.0P 0.0S');
});

test('renderInspectionReadout includes shared fields in stable order', () => {
  const html = renderInspectionReadout({
    intensity: 120,
    voxel: [1, 2, 3],
    lpsText: '10.0R 5.0A 3.0S',
    regionName: 'Insula',
    tissueName: 'Gray matter',
    ctHu: 42,
    adcDisplay: null,
  }, { coordLabel: 'vx', includeSlice: true });

  assert.match(html, /<span class="hv-label">i<\/span>120/);
  assert.match(html, /<span class="hv-label">HU<\/span>42/);
  assert.match(html, /Insula/);
  assert.match(html, /Gray matter/);
});

test('resolveVoxelInspection accepts explicit compare-style overlay labels', () => {
  state.manifest = {
    series: [{
      slug: 'inspect_compare',
      width: 2,
      height: 2,
      slices: 1,
      hasSeg: true,
      hasRegions: true,
      firstIPP: [0, 0, 0],
      lastIPP: [0, 0, 0],
      orientation: [1, 0, 0, 0, 1, 0],
      pixelSpacing: [1, 1],
    }],
  };
  state.seriesIdx = 0;
  state.useSeg = true;
  state.useRegions = true;
  state.segVoxels = null;
  state.regionVoxels = null;
  state.regionMeta = null;
  state.hrVoxels = null;
  state.voxels = Uint8Array.from([15, 25, 35, 45]);

  const info = resolveVoxelInspection(state.manifest.series[0], 1, 0, 0, {
    intensity: 25,
    tissueLabel: 2,
    regionLabel: 7,
    regionMeta: { legend: { 7: 'Insula' }, regions: { 7: { name: 'Insula' } } },
    useLiveOverlays: false,
  });

  assert.equal(info.intensity, 25);
  assert.equal(info.tissueName, 'Gray matter');
  assert.equal(info.regionName, 'Insula');
});

test('resolveVoxelInspection uses shared ADC display conversion', () => {
  state.manifest = {
    series: [{
      slug: 'dwi_adc',
      width: 1,
      height: 1,
      slices: 1,
      firstIPP: [0, 0, 0],
      lastIPP: [0, 0, 0],
      orientation: [1, 0, 0, 0, 1, 0],
      pixelSpacing: [1, 1],
    }],
  };
  state.seriesIdx = 0;
  state.hrVoxels = Float32Array.from([0.5]);
  state.stats = { adc: { hr_lo_raw: 100, hr_hi_raw: 300, rescale_slope: 2, rescale_intercept: 10, display_divisor: 1000 } };

  const info = resolveVoxelInspection(state.manifest.series[0], 0, 0, 0);

  assert.equal(info.adcDisplay, 0.41);
});
