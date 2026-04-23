import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`);
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
    };
  },
};

async function freshImportModule() {
  const url = new URL(`../js/dicom-import.js?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

function enhancedMetadataInstance() {
  return {
    '00080060': { vr: 'CS', Value: ['CT'] },
    '0020000E': { vr: 'UI', Value: ['1.2.series'] },
    '0020000D': { vr: 'UI', Value: ['1.2.study'] },
    '00080018': { vr: 'UI', Value: ['1.2.sop.1'] },
    '00280008': { vr: 'IS', Value: [2] },
    '00280010': { vr: 'US', Value: [2] },
    '00280011': { vr: 'US', Value: [2] },
    '00280100': { vr: 'US', Value: [16] },
    '00280101': { vr: 'US', Value: [16] },
    '00200052': { vr: 'UI', Value: ['1.2.for'] },
    '52009229': {
      vr: 'SQ',
      Value: [{
        '00289110': { vr: 'SQ', Value: [{ '00280030': { vr: 'DS', Value: [0.5, 0.5] }, '00180050': { vr: 'DS', Value: [1.0] } }] },
        '00209116': { vr: 'SQ', Value: [{ '00200037': { vr: 'DS', Value: [1, 0, 0, 0, 1, 0] } }] },
      }],
    },
    '52009230': {
      vr: 'SQ',
      Value: [
        { '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 0] } }] } },
        { '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 1] } }] } },
      ],
    },
  };
}

test('importDicomwebSeries imports an enhanced multi-frame CT series through the shared stack builder', async () => {
  const { importDicomwebSeries } = await freshImportModule();
  const calls = [];

  const result = await importDicomwebSeries({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    bearerToken: 'secret',
    slug: 'dicomweb_test',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), headers: options.headers || {} });
      if (String(url).endsWith('/metadata')) {
        return {
          ok: true,
          async json() {
            return [enhancedMetadataInstance()];
          },
        };
      }
      const frame = Number(String(url).split('/').pop());
      return {
        ok: true,
        async arrayBuffer() {
          return new Uint16Array(frame === 1 ? [1, 2, 3, 4] : [5, 6, 7, 8]).buffer;
        },
      };
    },
  });

  assert.equal(result.entry.slug, 'dicomweb_test');
  assert.equal(result.entry.geometryKind, 'volumeStack');
  assert.equal(result.entry.reconstructionCapability, 'display-volume');
  assert.deepEqual(result.entry.firstIPP, [0, 0, 0]);
  assert.deepEqual(result.entry.lastIPP, [0, 0, 1]);
  assert.equal(result.sliceCanvases.length, 2);
  assert.equal(result.rawVolume.length, 8);
  assert.equal(calls[0].headers.Authorization, 'Bearer secret');
});

test('importDicomwebSeries keeps ultrasound cine as 2D-only image stack', async () => {
  const { importDicomwebSeries } = await freshImportModule();

  const result = await importDicomwebSeries({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.us.series',
    slug: 'dicomweb_us',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/metadata')) {
        return {
          ok: true,
          async json() {
            return [{
              '00080060': { vr: 'CS', Value: ['US'] },
              '0020000E': { vr: 'UI', Value: ['1.2.us.series'] },
              '0020000D': { vr: 'UI', Value: ['1.2.study'] },
              '00080018': { vr: 'UI', Value: ['1.2.us.sop'] },
              '00280008': { vr: 'IS', Value: [3] },
              '00280010': { vr: 'US', Value: [2] },
              '00280011': { vr: 'US', Value: [2] },
              '00280100': { vr: 'US', Value: [8] },
            }];
          },
        };
      }
      return {
        ok: true,
        async arrayBuffer() {
          return new Uint8Array([1, 2, 3, 4]).buffer;
        },
      };
    },
  });

  assert.equal(result.entry.modality, 'US');
  assert.equal(result.entry.geometryKind, 'imageStack');
  assert.equal(result.entry.reconstructionCapability, '2d-only');
  assert.equal(result.entry.renderability, '2d');
  assert.equal(result.sliceCanvases.length, 3);
});

test('importDicomwebSeries rejects missing connection details', async () => {
  const { importDicomwebSeries } = await freshImportModule();

  await assert.rejects(
    () => importDicomwebSeries({ wadoBase: '', studyUID: '1.2.study', seriesUID: '1.2.series' }),
    /requires WADO-RS base URL, Study UID, and Series UID/i,
  );
});

test('importDicomwebSeries reuses resumable DICOMweb session cache across retries', async () => {
  const { importDicomwebSeries } = await freshImportModule();
  let metadataCalls = 0;
  let frameCalls = 0;

  const baseOptions = {
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    sessionId: 'import-resume-session',
    slug: 'dicomweb_resume',
  };

  const first = await importDicomwebSeries({
    ...baseOptions,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/metadata')) {
        metadataCalls += 1;
        return {
          ok: true,
          async json() {
            return [enhancedMetadataInstance()];
          },
        };
      }
      frameCalls += 1;
      const frame = Number(String(url).split('/').pop());
      return {
        ok: true,
        async arrayBuffer() {
          return new Uint16Array(frame === 1 ? [1, 2, 3, 4] : [5, 6, 7, 8]).buffer;
        },
      };
    },
  });

  const second = await importDicomwebSeries({
    ...baseOptions,
    fetchImpl: async () => {
      throw new Error('session cache should avoid duplicate metadata/frame network requests');
    },
  });

  assert.equal(metadataCalls, 1);
  assert.equal(frameCalls, 2);
  assert.equal(first.entry.geometryKind, 'volumeStack');
  assert.equal(second.entry.geometryKind, 'volumeStack');
  assert.equal(second.sliceCanvases.length, 2);
});
