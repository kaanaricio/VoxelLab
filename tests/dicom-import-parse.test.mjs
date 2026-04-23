import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  buildDICOMSeriesResult,
  classifyDICOMImport,
  dicomSeriesGroupKey,
  extractEnhancedMultiFrameMetas,
  extractEnhancedMultiFramePixels,
} = await import('../js/dicom-import-parse.js');

function createCanvasStub() {
  const context = {
    // Shape: { width: 2, height: 1, data: Uint8ClampedArray(8) }.
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData() {},
  };
  return {
    width: 0,
    height: 0,
    getContext() {
      return context;
    },
  };
}

test('dicomSeriesGroupKey separates series within the same study', () => {
  const first = {
    StudyInstanceUID: '1.2.study',
    SeriesInstanceUID: '1.2.study.1',
    SeriesNumber: 1,
    Modality: 'CT',
  };
  const second = {
    StudyInstanceUID: '1.2.study',
    SeriesInstanceUID: '1.2.study.2',
    SeriesNumber: 2,
    Modality: 'CT',
  };

  assert.notEqual(dicomSeriesGroupKey(first), dicomSeriesGroupKey(second));
});

test('dicomSeriesGroupKey falls back to stable descriptive series tags', () => {
  const firstSlice = {
    StudyInstanceUID: '1.2.study',
    SeriesNumber: 7,
    SeriesDescription: 'Lateral projection',
    Modality: 'DX',
  };
  const secondSlice = {
    StudyInstanceUID: '1.2.study',
    SeriesNumber: 7,
    SeriesDescription: 'Lateral projection',
    Modality: 'DX',
  };
  const otherSeries = {
    StudyInstanceUID: '1.2.study',
    SeriesNumber: 8,
    SeriesDescription: 'AP projection',
    Modality: 'DX',
  };

  assert.equal(dicomSeriesGroupKey(firstSlice), dicomSeriesGroupKey(secondSlice));
  assert.notEqual(dicomSeriesGroupKey(firstSlice), dicomSeriesGroupKey(otherSeries));
});

test('classifyDICOMImport marks reconstructed geometry as a volume stack', () => {
  const slices = [0, 2.5].map((z, i) => ({
    Modality: 'CT',
    InstanceNumber: i + 1,
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, z],
  }));

  const result = classifyDICOMImport(slices);

  assert.equal(result.kind, 'volume-stack');
  assert.equal(result.isReconstructedVolumeStack, true);
  assert.equal(result.isProjection, false);
  assert.equal(result.hasVolumeStackGeometry, true);
});

test('classifyDICOMImport keeps CR/DX/XA projection sets out of volume stacks', () => {
  for (const modality of ['CR', 'DX', 'XA']) {
    // Example value: two projection images from one series, not a reconstructed volume.
    const result = classifyDICOMImport([
      { Modality: modality, InstanceNumber: 1 },
      { Modality: modality, InstanceNumber: 2 },
      { Modality: modality, InstanceNumber: 3 },
    ]);

    assert.equal(result.kind, 'projection-set', modality);
    assert.equal(result.isProjection, true, modality);
    assert.equal(result.isProjectionSet, true, modality);
    assert.equal(result.isReconstructedVolumeStack, false, modality);
  }
});

test('classifyDICOMImport keeps CT localizers out of volume stacks', () => {
  // Example value: CT scout/localizer images can carry CT modality but are projections.
  const result = classifyDICOMImport([0, 2.5].map((z, i) => ({
    Modality: 'CT',
    ImageType: ['ORIGINAL', 'PRIMARY', 'LOCALIZER'],
    InstanceNumber: i + 1,
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, z],
  })));

  assert.equal(result.kind, 'projection-set');
  assert.equal(result.isProjection, true);
  assert.equal(result.isReconstructedVolumeStack, false);
});

test('classifyDICOMImport treats non-projection multi-image series without geometry as image stacks', () => {
  // Example value: MR files lacking reliable IPP/IOP geometry from a partial export.
  const result = classifyDICOMImport([
    { Modality: 'MR', InstanceNumber: 1 },
    { Modality: 'MR', InstanceNumber: 2 },
  ]);

  assert.equal(result.kind, 'image-stack');
  assert.equal(result.isProjection, false);
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.equal(result.hasVolumeStackGeometry, false);
});

test('classifyDICOMImport downgrades irregular slice spacing to image-stack', () => {
  const result = classifyDICOMImport([0, 1, 3.5].map((z, i) => ({
    Modality: 'CT',
    InstanceNumber: i + 1,
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, z],
  })));

  assert.equal(result.kind, 'image-stack');
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.equal(result.hasVolumeStackGeometry, false);
  assert.match(result.reason, /irregular/i);
});

test('classifyDICOMImport keeps ultrasound imports 2D-only until scan conversion exists', () => {
  const result = classifyDICOMImport([
    { Modality: 'US', InstanceNumber: 1, NumberOfFrames: 32 },
  ]);

  assert.equal(result.kind, 'ultrasound-cine');
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.match(result.reason, /scan/i);
});

test('classifyDICOMImport promotes enhanced multi-frame with regular per-frame geometry to a volume stack', () => {
  const result = classifyDICOMImport([{
    Modality: 'CT',
    NumberOfFrames: 3,
    SharedFunctionalGroupsSequence: [{
      PixelMeasuresSequence: [{ PixelSpacing: [0.5, 0.5], SliceThickness: 1.0 }],
      PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
    }],
    PerFrameFunctionalGroupsSequence: [
      { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }] },
      { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }] },
      { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 2] }] },
    ],
    FrameOfReferenceUID: '1.2.840.enhanced',
  }]);

  assert.equal(result.kind, 'volume-stack');
  assert.equal(result.isReconstructedVolumeStack, true);
  assert.equal(result.hasVolumeStackGeometry, true);
  assert.match(result.reason, /per-frame geometry/i);
});

test('classifyDICOMImport falls back to multiframe-image when per-frame geometry is missing', () => {
  const result = classifyDICOMImport([{
    Modality: 'MR',
    NumberOfFrames: 10,
  }]);

  assert.equal(result.kind, 'multiframe-image');
  assert.equal(result.isReconstructedVolumeStack, false);
});

test('extractEnhancedMultiFrameMetas extracts per-frame metadata from functional groups', () => {
  const meta = {
    SharedFunctionalGroupsSequence: [{
      PixelMeasuresSequence: [{ PixelSpacing: [0.625, 0.625], SliceThickness: 0.7 }],
      PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
    }],
    PerFrameFunctionalGroupsSequence: [
      { PlanePositionSequence: [{ ImagePositionPatient: [-160, -160, 0] }] },
      { PlanePositionSequence: [{ ImagePositionPatient: [-160, -160, 0.7] }] },
    ],
    FrameOfReferenceUID: '1.2.3.4',
  };

  const metas = extractEnhancedMultiFrameMetas(meta);

  assert.equal(metas.length, 2);
  assert.deepEqual(metas[0].ImagePositionPatient, [-160, -160, 0]);
  assert.deepEqual(metas[1].ImagePositionPatient, [-160, -160, 0.7]);
  assert.deepEqual(metas[0].ImageOrientationPatient, [1, 0, 0, 0, 1, 0]);
  assert.deepEqual(metas[0].PixelSpacing, [0.625, 0.625]);
  assert.equal(metas[0].FrameOfReferenceUID, '1.2.3.4');
});

test('extractEnhancedMultiFramePixels expands native uncompressed frames into typed pixel arrays', () => {
  const framePixels = new Uint16Array([
    1, 2, 3, 4,
    5, 6, 7, 8,
  ]);
  const item = {
    meta: {
      Modality: 'CT',
      NumberOfFrames: 2,
      Rows: 2,
      Columns: 2,
      BitsAllocated: 16,
      PixelRepresentation: 0,
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      SharedFunctionalGroupsSequence: [{
        PixelMeasuresSequence: [{ PixelSpacing: [0.5, 0.5], SliceThickness: 1 }],
        PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      }],
      PerFrameFunctionalGroupsSequence: [
        { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }] },
        { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }] },
      ],
      FrameOfReferenceUID: '1.2.840.enhanced',
    },
    pixelData: {
      Value: [framePixels.buffer],
    },
  };

  const frames = extractEnhancedMultiFramePixels(item);

  assert.equal(frames.length, 2);
  assert.deepEqual(Array.from(frames[0].pixels), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(frames[1].pixels), [5, 6, 7, 8]);
  assert.deepEqual(frames[1].meta.ImagePositionPatient, [0, 0, 1]);
});

test('extractEnhancedMultiFramePixels synthesizes 2D frame metas for ultrasound cine without per-frame geometry', () => {
  const framePixels = new Uint8Array([
    1, 2, 3, 4,
    5, 6, 7, 8,
  ]);
  const frames = extractEnhancedMultiFramePixels({
    meta: {
      Modality: 'US',
      NumberOfFrames: 2,
      Rows: 2,
      Columns: 2,
      BitsAllocated: 8,
      PixelRepresentation: 0,
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
    },
    pixelData: {
      Value: [framePixels.buffer],
    },
  });

  assert.equal(frames.length, 2);
  assert.equal(frames[0].meta.NumberOfFrames, 1);
  assert.equal(frames[0].meta.InstanceNumber, 1);
  assert.equal(frames[1].meta.InstanceNumber, 2);
  assert.deepEqual(Array.from(frames[1].pixels), [5, 6, 7, 8]);
});

test('buildDICOMSeriesResult preserves negative signed 16-bit pixel values in normalized CT volume', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createCanvasStub();
      throw new Error(`unexpected element: ${tag}`);
    },
  };

  try {
    const signedPixels = new Int16Array([-1024, 0]);
    const result = await buildDICOMSeriesResult([
      {
        meta: {
          Modality: 'CT',
          Rows: 1,
          Columns: 2,
          BitsAllocated: 16,
          BitsStored: 16,
          PixelRepresentation: 1,
          PhotometricInterpretation: 'MONOCHROME2',
          TransferSyntaxUID: '1.2.840.10008.1.2.1',
          PixelSpacing: [1, 1],
          SliceThickness: 1,
          ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
          ImagePositionPatient: [0, 0, 0],
          InstanceNumber: 1,
          SeriesDescription: 'Signed CT',
        },
        pixels: signedPixels,
      },
    ], () => {}, 'local_signed_ct');

    assert.equal(result.rawVolume[0], 0);
    assert.ok(Math.abs(result.rawVolume[1] - (1024 / 3072)) < 1e-6);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('buildDICOMSeriesResult fails closed on color DICOM pixel layouts', async () => {
  const skippedReasons = [];
  const result = await buildDICOMSeriesResult([
    {
      meta: {
        Modality: 'OT',
        Rows: 1,
        Columns: 2,
        BitsAllocated: 8,
        BitsStored: 8,
        SamplesPerPixel: 3,
        PhotometricInterpretation: 'RGB',
        PixelSpacing: [1, 1],
        SliceThickness: 1,
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        ImagePositionPatient: [0, 0, 0],
        InstanceNumber: 1,
      },
      pixels: new Uint8Array([255, 0, 0, 0, 255, 0]),
    },
  ], () => {}, 'local_rgb', skippedReasons);

  assert.equal(result, null);
  assert.match(skippedReasons[0] || '', /single-sample|MONOCHROME/i);
});

test('buildDICOMSeriesResult fails closed on invalid BitsStored values', async () => {
  const skippedReasons = [];
  const result = await buildDICOMSeriesResult([
    {
      meta: {
        Modality: 'CT',
        Rows: 1,
        Columns: 2,
        BitsAllocated: 16,
        BitsStored: 0,
        PixelRepresentation: 0,
        PhotometricInterpretation: 'MONOCHROME2',
        PixelSpacing: [1, 1],
        SliceThickness: 1,
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        ImagePositionPatient: [0, 0, 0],
        InstanceNumber: 1,
      },
      pixels: new Uint16Array([1, 2]),
    },
  ], () => {}, 'local_bad_bits', skippedReasons);

  assert.equal(result, null);
  assert.match(skippedReasons[0] || '', /BitsStored/i);
});
