import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');
globalThis.localStorage = (() => {
  const store = new Map();
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(String(key), String(value)); },
    removeItem(key) { store.delete(String(key)); },
    clear() { store.clear(); },
  };
})();
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
    return {
      width: 0,
      height: 0,
      getContext() {
        return {
          createImageData(width, height) {
            return { data: new Uint8ClampedArray(width * height * 4) };
          },
          putImageData() {},
        };
      },
      toDataURL() {
        return 'data:image/png;base64,test';
      },
    };
  },
};
globalThis.Image = class {
  constructor() {
    this.src = '';
  }
};

async function freshModule() {
  const url = new URL(`../js/dicom-derived-import.js?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

function sourceSeries() {
  return {
    slug: 'src',
    name: 'Source',
    sourceSeriesUID: '1.2.src',
    frameOfReferenceUID: '1.2.for',
    width: 2,
    height: 2,
    slices: 2,
    pixelSpacing: [1, 1],
    sliceSpacing: 1,
    sliceThickness: 1,
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 1],
    orientation: [1, 0, 0, 0, 1, 0],
  };
}

test('buildSegOverlayImport unpacks binary SEG frames onto the referenced source slices', async () => {
  const { buildSegOverlayImport } = await freshModule();
  const overlay = buildSegOverlayImport({
    meta: {
      Modality: 'SEG',
      Rows: 2,
      Columns: 2,
      BitsAllocated: 1,
      NumberOfFrames: 2,
      SegmentSequence: [
        { SegmentNumber: 1, SegmentLabel: 'Tumor' },
        { SegmentNumber: 2, SegmentLabel: 'Edema' },
      ],
      SharedFunctionalGroupsSequence: [{
        PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      }],
      PerFrameFunctionalGroupsSequence: [
        {
          PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
          SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
        },
        {
          PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }],
          SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 2 }],
        },
      ],
    },
    pixelData: {
      Value: [
        new Uint8Array([0b00001111]).buffer,
        new Uint8Array([0b00000010]).buffer,
      ],
    },
  }, sourceSeries());

  assert.equal(overlay.kind, 'seg');
  assert.equal(overlay.overlayKind, 'labels');
  assert.equal(overlay.legacySlot, 'regions');
  assert.deepEqual([...overlay.labelSlices[0]], [1, 1, 1, 1]);
  assert.deepEqual([...overlay.labelSlices[1]], [0, 2, 0, 0]);
  assert.equal(overlay.regionMeta.regions[1].name, 'Tumor');
  assert.equal(overlay.regionMeta.regions[2].name, 'Edema');
});

test('buildSegOverlayImport accepts already-unpacked one-byte DICOMweb SEG frames', async () => {
  const { buildSegOverlayImport } = await freshModule();
  const overlay = buildSegOverlayImport({
    meta: {
      Modality: 'SEG',
      Rows: 2,
      Columns: 2,
      BitsAllocated: 1,
      NumberOfFrames: 2,
      SegmentSequence: [
        { SegmentNumber: 1, SegmentLabel: 'Tumor' },
        { SegmentNumber: 2, SegmentLabel: 'Edema' },
      ],
      PerFrameFunctionalGroupsSequence: [
        {
          PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
          SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
        },
        {
          PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }],
          SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 2 }],
        },
      ],
    },
    pixelData: {
      Value: [
        new Uint8Array([1, 0, 1, 0]).buffer,
        new Uint8Array([0, 1, 0, 1]).buffer,
      ],
    },
  }, sourceSeries());

  assert.deepEqual([...overlay.labelSlices[0]], [1, 0, 1, 0]);
  assert.deepEqual([...overlay.labelSlices[1]], [0, 2, 0, 2]);
});

test('hydrateDerivedStateForSeries normalizes persisted SEG imports as canonical labels overlays', async () => {
  const { buildDerivedRegistryEntry, clearDerivedRegistry, upsertDerivedRegistryEntry } = await import('../js/derived-objects.js');
  const { overlayKindsForSeries } = await import('../js/runtime/overlay-kinds.js');
  const { state } = await import('../js/state.js');
  const { hydrateDerivedStateForSeries } = await freshModule();
  clearDerivedRegistry();

  const source = sourceSeries();
  const entry = buildDerivedRegistryEntry({
    derivedKind: 'seg',
    sourceSeries: source,
    derivedSeries: source,
    objectUID: '9.8.7.seg',
    name: 'Imported SEG',
    modality: 'SEG',
    payload: {
      format: 'seg-overlay-v1',
      sparseSlices: [[0, 1, 3, 1], [1, 2]],
      regionMeta: {
        regions: {
          1: { name: 'Tumor', mL: 0.004, source: 'dicom-seg' },
          2: { name: 'Edema', mL: 0.001, source: 'dicom-seg' },
        },
        colors: {
          1: [255, 0, 0],
          2: [0, 255, 0],
        },
      },
    },
  });
  upsertDerivedRegistryEntry(entry);

  state._localDerivedObjects[source.slug] = {};
  delete state._localRegionMetaBySlug[source.slug];
  delete state._localRegionLabelSlicesBySlug[source.slug];
  delete state._localStacks[`${source.slug}_regions`];

  const hydrated = hydrateDerivedStateForSeries(source);
  const overlays = overlayKindsForSeries(source);

  assert.equal(hydrated.length, 1);
  assert.equal(source.hasRegions, true);
  assert.deepEqual(overlays.availableKinds, ['labels']);
  assert.equal(overlays.byKind.labels.source, 'dicom-seg');
  assert.deepEqual(overlays.byKind.labels.legacyKinds, ['regions', 'seg']);
});

test('buildRTStructImport maps CLOSED_PLANAR contours into source-slice ROI polygons', async () => {
  const { buildRTStructImport } = await freshModule();
  const result = buildRTStructImport({
    Modality: 'RTSTRUCT',
    StructureSetROISequence: [
      { ROINumber: 1, ROIName: 'Lesion' },
    ],
    ROIContourSequence: [
      {
        ReferencedROINumber: 1,
        ContourSequence: [
          {
            ContourGeometricType: 'CLOSED_PLANAR',
            ContourData: [
              0, 0, 0,
              1, 0, 0,
              1, 1, 0,
              0, 1, 0,
            ],
          },
        ],
      },
    ],
  }, sourceSeries());

  assert.equal(result.kind, 'rtstruct');
  assert.equal(result.roisBySlice['0'][0].shape, 'polygon');
  assert.equal(result.roisBySlice['0'][0].text, 'Lesion');
  assert.equal(result.roisBySlice['0'][0].pts.length, 4);
  assert.ok(result.roisBySlice['0'][0].stats.area_mm2 > 0);
});

test('buildRTStructImport skips contours that do not land near a real source slice plane', async () => {
  const { buildRTStructImport } = await freshModule();
  const result = buildRTStructImport({
    Modality: 'RTSTRUCT',
    StructureSetROISequence: [
      { ROINumber: 1, ROIName: 'Off plane' },
    ],
    ROIContourSequence: [
      {
        ReferencedROINumber: 1,
        ContourSequence: [
          {
            ContourGeometricType: 'CLOSED_PLANAR',
            ContourData: [
              0, 0, 0,
              1, 0, 0,
              1, 1, 2.5,
              0, 1, 2.5,
            ],
          },
        ],
      },
    ],
  }, sourceSeries());

  assert.deepEqual(result.roisBySlice, {});
});

test('buildRTStructImport skips contours when the source affine is not invertible', async () => {
  const { buildRTStructImport } = await freshModule();
  const degenerate = { ...sourceSeries(), orientation: [1, 0, 0, 1, 0, 0] };
  const result = buildRTStructImport({
    Modality: 'RTSTRUCT',
    StructureSetROISequence: [
      { ROINumber: 1, ROIName: 'Degenerate' },
    ],
    ROIContourSequence: [
      {
        ReferencedROINumber: 1,
        ContourSequence: [
          {
            ContourGeometricType: 'CLOSED_PLANAR',
            ContourData: [
              0, 0, 0,
              1, 0, 0,
              1, 1, 0,
              0, 1, 0,
            ],
          },
        ],
      },
    ],
  }, degenerate);

  assert.deepEqual(result.roisBySlice, {});
});

test('buildSRImport converts viewer-style measurement groups into slice annotations', async () => {
  const { buildSRImport } = await freshModule();
  const result = buildSRImport({
    Modality: 'SR',
    ContentSequence: [
      {
        ValueType: 'CONTAINER',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
        ContentSequence: [
          {
            ValueType: 'TEXT',
            ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
            TextValue: 'src slice 2',
          },
          {
            ValueType: 'NUM',
            ConceptNameCodeSequence: [{ CodeMeaning: 'Length' }],
            MeasuredValueSequence: [{ NumericValue: '12.5' }],
          },
          {
            ValueType: 'TEXT',
            ConceptNameCodeSequence: [{ CodeMeaning: 'Comment' }],
            TextValue: 'Follow-up target',
          },
        ],
      },
    ],
  }, sourceSeries());

  assert.equal(result.kind, 'sr');
  assert.equal(result.annotationsBySlice['1'].length, 1);
  assert.match(result.annotationsBySlice['1'][0].text, /Length: 12.5/);
  assert.match(result.annotationsBySlice['1'][0].text, /Comment: Follow-up target/);
});

test('buildSRImport rejects SR groups without explicit VoxelLab slice references', async () => {
  const { buildSRImport } = await freshModule();

  assert.throws(
    () => buildSRImport({
      Modality: 'SR',
      ContentSequence: [
        {
          ValueType: 'CONTAINER',
          ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
          ContentSequence: [
            {
              ValueType: 'TEXT',
              ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
              TextValue: 'Clinical SR image reference',
            },
            {
              ValueType: 'TEXT',
              ConceptNameCodeSequence: [{ CodeMeaning: 'Comment' }],
              TextValue: 'Imported note',
            },
          ],
        },
      ],
    }, sourceSeries()),
    /viewer-exported measurement notes/i,
  );
});

test('buildRtDoseImport normalizes dose metadata without claiming rendering', async () => {
  const { buildRtDoseImport } = await freshModule();
  const result = buildRtDoseImport({
    Modality: 'RTDOSE',
    Rows: 32,
    Columns: 16,
    NumberOfFrames: 4,
    DoseGridScaling: '0.001',
    DoseUnits: 'GY',
    DoseType: 'PHYSICAL',
    DoseSummationType: 'PLAN',
    FrameOfReferenceUID: '1.2.3',
  }, sourceSeries());

  assert.equal(result.kind, 'rtdose');
  assert.equal(result.summary.format, 'rtdose-summary-v1');
  assert.equal(result.summary.rows, 32);
  assert.equal(result.summary.cols, 16);
  assert.equal(result.summary.frames, 4);
  assert.equal(result.summary.doseUnits, 'GY');
  assert.equal(result.summary.doseType, 'PHYSICAL');
});

test('hydrateDerivedStateForSeries consumes persisted derived registry entries', async () => {
  const { buildDerivedRegistryEntry, clearDerivedRegistry, upsertDerivedRegistryEntry } = await import('../js/derived-objects.js');
  const { state } = await import('../js/state.js');
  const { hydrateDerivedStateForSeries } = await freshModule();
  clearDerivedRegistry();

  const source = sourceSeries();
  const entry = buildDerivedRegistryEntry({
    derivedKind: 'rtdose',
    sourceSeries: source,
    derivedSeries: { frameOfReferenceUID: source.frameOfReferenceUID || '1.2.3' },
    objectUID: '9.8.7.6',
    name: 'Plan dose',
    modality: 'RTDOSE',
    payload: {
      format: 'rtdose-summary-v1',
      rows: 4,
      cols: 4,
      frames: 2,
      doseGridScaling: 0.01,
      doseUnits: 'GY',
      doseType: 'PHYSICAL',
      doseSummationType: 'PLAN',
      frameOfReferenceUID: '1.2.3',
    },
  });
  upsertDerivedRegistryEntry(entry);

  state._localDerivedObjects[source.slug] = {};
  delete state._localRtDoseBySlug[source.slug];

  const hydrated = hydrateDerivedStateForSeries(source);
  assert.equal(hydrated.length, 1);
  assert.equal(state._localDerivedObjects[source.slug]['9.8.7.6'].kind, 'rtdose');
  assert.equal(state._localRtDoseBySlug[source.slug][0].summary.doseUnits, 'GY');
});
