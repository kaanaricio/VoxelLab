import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  normalizeInstance,
  normalizeInstances,
  fetchFrameBytes,
  fetchSeriesItems,
  fetchSeriesMetadata,
  discoverQidoStudies,
  discoverQidoSeries,
  resolveDicomwebImportSession,
  clearDicomwebSessions,
  getDicomwebSessionStats,
  frameUrl,
  seriesMetadataUrl,
} = await import('../js/dicomweb/dicomweb-source.js');
const { classifyDICOMImport } = await import('../js/dicom-import-parse.js');
const { geometryFromDicomMetas } = await import('../js/geometry.js');

function dicomJsonInstance(overrides = {}) {
  return {
    '00080060': { vr: 'CS', Value: ['CT'] },
    '0020000E': { vr: 'UI', Value: ['1.2.series'] },
    '0020000D': { vr: 'UI', Value: ['1.2.study'] },
    '00080018': { vr: 'UI', Value: ['1.2.sop.1'] },
    '00200013': { vr: 'IS', Value: [1] },
    '00280010': { vr: 'US', Value: [512] },
    '00280011': { vr: 'US', Value: [512] },
    '00280100': { vr: 'US', Value: [16] },
    '00200032': { vr: 'DS', Value: [0, 0, 0] },
    '00200037': { vr: 'DS', Value: [1, 0, 0, 0, 1, 0] },
    '00280030': { vr: 'DS', Value: [0.5, 0.5] },
    '00180050': { vr: 'DS', Value: [1.0] },
    '00200052': { vr: 'UI', Value: ['1.2.for'] },
    ...overrides,
  };
}

test('normalizeInstance converts DICOM JSON to naturalized metadata', () => {
  const meta = normalizeInstance(dicomJsonInstance());

  assert.equal(meta.Modality, 'CT');
  assert.equal(meta.SeriesInstanceUID, '1.2.series');
  assert.equal(meta.Rows, 512);
  assert.deepEqual(meta.ImagePositionPatient, [0, 0, 0]);
  assert.deepEqual(meta.ImageOrientationPatient, [1, 0, 0, 0, 1, 0]);
  assert.deepEqual(meta.PixelSpacing, [0.5, 0.5]);
  assert.equal(meta.FrameOfReferenceUID, '1.2.for');
});

test('normalizeInstances produces array compatible with classifyDICOMImport', () => {
  const instances = [
    dicomJsonInstance({ '00200032': { vr: 'DS', Value: [0, 0, 0] }, '00200013': { vr: 'IS', Value: [1] } }),
    dicomJsonInstance({ '00200032': { vr: 'DS', Value: [0, 0, 1] }, '00200013': { vr: 'IS', Value: [2] } }),
  ];

  const metas = normalizeInstances(instances);
  const result = classifyDICOMImport(metas);

  assert.equal(result.kind, 'volume-stack');
  assert.equal(result.isReconstructedVolumeStack, true);
  assert.equal(result.hasVolumeStackGeometry, true);
});

test('normalizeInstances produces geometry parity with local DICOM imports', () => {
  const instances = [
    dicomJsonInstance({ '00200032': { vr: 'DS', Value: [0, 0, 0] } }),
    dicomJsonInstance({ '00200032': { vr: 'DS', Value: [0, 0, 1] } }),
    dicomJsonInstance({ '00200032': { vr: 'DS', Value: [0, 0, 2] } }),
  ];

  const metas = normalizeInstances(instances);
  const geometry = geometryFromDicomMetas(metas);

  assert.deepEqual(geometry.pixelSpacing, [0.5, 0.5]);
  assert.equal(geometry.sliceSpacingRegular, true);
  assert.deepEqual(geometry.firstIPP, [0, 0, 0]);
  assert.deepEqual(geometry.lastIPP, [0, 0, 2]);
  assert.equal(geometry.frameOfReferenceUID, '1.2.for');
});

test('normalizeInstance preserves enhanced multi-frame functional groups for geometry expansion', () => {
  const instance = dicomJsonInstance({
    '00280008': { vr: 'IS', Value: [2] },
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
  });

  const meta = normalizeInstance(instance);
  const result = classifyDICOMImport([meta]);

  assert.equal(meta.SharedFunctionalGroupsSequence.length, 1);
  assert.equal(meta.PerFrameFunctionalGroupsSequence.length, 2);
  assert.deepEqual(
    meta.PerFrameFunctionalGroupsSequence[1].PlanePositionSequence[0].ImagePositionPatient,
    [0, 0, 1],
  );
  assert.equal(result.kind, 'volume-stack');
  assert.equal(result.isReconstructedVolumeStack, true);
});

test('frameUrl and seriesMetadataUrl build correct WADO-RS paths', () => {
  assert.equal(
    frameUrl('https://pacs.example/wado-rs', '1.2.study', '1.2.series', '1.2.sop', 3),
    'https://pacs.example/wado-rs/studies/1.2.study/series/1.2.series/instances/1.2.sop/frames/3',
  );
  assert.equal(
    seriesMetadataUrl('https://pacs.example/wado-rs', '1.2.study', '1.2.series'),
    'https://pacs.example/wado-rs/studies/1.2.study/series/1.2.series/metadata',
  );
});

test('frameUrl and seriesMetadataUrl reject invalid UID path segments', () => {
  assert.throws(
    () => frameUrl('https://pacs.example/wado-rs', '../../study', '1.2.series', '1.2.sop', 1),
    /invalid study uid/i,
  );
  assert.throws(
    () => seriesMetadataUrl('https://pacs.example/wado-rs', '1.2.study', '../../series'),
    /invalid series uid/i,
  );
});

test('discoverQidoSeries rejects invalid UID path segments before fetching', async () => {
  await assert.rejects(
    () => discoverQidoSeries({
      wadoBase: 'https://pacs.example/wado-rs',
      studyUID: '../../study',
      fetchImpl: async () => {
        assert.fail('unexpected fetch for invalid UID');
      },
    }),
    /invalid study uid/i,
  );
});

test('fetchSeriesMetadata caps Retry-After backoff to 30 seconds', async (t) => {
  const previousSetTimeout = globalThis.setTimeout;
  let seenDelay = 0;
  let calls = 0;
  t.after(() => {
    globalThis.setTimeout = previousSetTimeout;
  });
  globalThis.setTimeout = (fn, delay = 0) => {
    seenDelay = Number(delay || 0);
    fn();
    return 0;
  };

  const metas = await fetchSeriesMetadata({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    retryDelay: 1,
    useCache: false,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 503,
          headers: { get: (name) => (name === 'Retry-After' ? '99999999' : null) },
        };
      }
      return {
        ok: true,
        async json() {
          return [dicomJsonInstance()];
        },
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(seenDelay, 30_000);
  assert.equal(metas[0].Modality, 'CT');
});

test('fetchSeriesMetadata normalizes a WADO-RS metadata response', async () => {
  const metas = await fetchSeriesMetadata({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://pacs.example/wado-rs/studies/1.2.study/series/1.2.series/metadata');
      assert.equal(options.headers.Accept, 'application/dicom+json');
      return {
        ok: true,
        async json() {
          return [dicomJsonInstance()];
        },
      };
    },
  });

  assert.equal(metas.length, 1);
  assert.equal(metas[0].Modality, 'CT');
});

test('fetchSeriesMetadata retries retryable failures and respects lowercase accept headers', async () => {
  let calls = 0;
  const metas = await fetchSeriesMetadata({
    wadoBase: 'https://pacs.example/wado-rs/',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    headers: { accept: 'application/dicom+json' },
    useCache: false,
    retryDelay: 0,
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.headers.accept, 'application/dicom+json');
      assert.equal(options.headers.Accept, undefined);
      if (calls === 1) return { ok: false, status: 503, headers: { get: () => null } };
      return {
        ok: true,
        async json() {
          return [dicomJsonInstance()];
        },
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(metas[0].Modality, 'CT');
});

test('fetchFrameBytes requests one WADO-RS frame as explicit little endian', async () => {
  const buffer = await fetchFrameBytes({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    instanceUID: '1.2.sop.1',
    frame: 2,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://pacs.example/wado-rs/studies/1.2.study/series/1.2.series/instances/1.2.sop.1/frames/2');
      assert.equal(options.headers.Accept, 'application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1');
      return {
        ok: true,
        async arrayBuffer() {
          return new Uint8Array([1, 2, 3]).buffer;
        },
      };
    },
  });

  assert.deepEqual(Array.from(new Uint8Array(buffer)), [1, 2, 3]);
  assert.equal(buffer.transferSyntaxUID, '1.2.840.10008.1.2.1');
});

test('fetchFrameBytes rejects a declared transfer syntax mismatch', async () => {
  await assert.rejects(
    () => fetchFrameBytes({
      wadoBase: 'https://pacs.example/wado-rs',
      studyUID: '1.2.study',
      seriesUID: '1.2.series',
      instanceUID: '1.2.sop.1',
      frame: 1,
      useCache: false,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => 'application/octet-stream; transfer-syntax=1.2.840.10008.1.2.4.90' },
        async arrayBuffer() {
          return new Uint8Array([1, 2, 3]).buffer;
        },
      }),
    }),
    /transfer syntax mismatch/i,
  );
});

test('fetchFrameBytes extracts the first part from standard WADO-RS multipart responses', async () => {
  const boundary = 'dicom-boundary';
  const body = new Uint8Array(Buffer.from(
    `--${boundary}\r\n`
    + 'Content-Type: application/octet-stream\r\n'
    + 'Content-Location: frame/1\r\n'
    + '\r\n'
  ));
  const payload = new Uint8Array([7, 8, 9]);
  const trailer = new Uint8Array(Buffer.from(`\r\n--${boundary}--\r\n`));
  const merged = new Uint8Array(body.length + payload.length + trailer.length);
  merged.set(body, 0);
  merged.set(payload, body.length);
  merged.set(trailer, body.length + payload.length);

  const buffer = await fetchFrameBytes({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    instanceUID: '1.2.sop.1',
    frame: 1,
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => `multipart/related; type="application/octet-stream"; boundary="${boundary}"` },
      async arrayBuffer() {
        return merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength);
      },
    }),
  });

  assert.deepEqual(Array.from(new Uint8Array(buffer)), [7, 8, 9]);
});

test('fetchFrameBytes rejects unsupported success content types', async () => {
  await assert.rejects(
    () => fetchFrameBytes({
      wadoBase: 'https://pacs.example/wado-rs',
      studyUID: '1.2.study',
      seriesUID: '1.2.series',
      instanceUID: '1.2.sop.1',
      frame: 1,
      useCache: false,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => 'text/html' },
        async arrayBuffer() {
          return new Uint8Array([1]).buffer;
        },
      }),
    }),
    /unsupported content type/i,
  );
});

test('fetchSeriesItems expands enhanced multi-frame metadata into one shared import item per frame', async () => {
  const metadata = [normalizeInstance(dicomJsonInstance({
    '00080018': { vr: 'UI', Value: ['1.2.sop.enhanced'] },
    '00280008': { vr: 'IS', Value: [2] },
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
  }))];

  const items = await fetchSeriesItems({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    metadata,
    fetchImpl: async (url) => {
      const frameNumber = Number(url.split('/').pop());
      return {
        ok: true,
        async arrayBuffer() {
          return new Uint8Array([frameNumber]).buffer;
        },
      };
    },
  });

  assert.equal(items.length, 2);
  assert.deepEqual(items[0].meta.ImagePositionPatient, [0, 0, 0]);
  assert.deepEqual(items[1].meta.ImagePositionPatient, [0, 0, 1]);
  assert.equal(items[1].meta.NumberOfFrames, 1);
  assert.equal(items[1].meta.TransferSyntaxUID, '1.2.840.10008.1.2.1');
  assert.deepEqual(Array.from(new Uint8Array(items[1].pixelData.Value[0])), [2]);
});

test('fetchSeriesItems synthesizes frame metas for ultrasound cine without per-frame geometry', async () => {
  const metadata = [normalizeInstance(dicomJsonInstance({
    '00080060': { vr: 'CS', Value: ['US'] },
    '00080018': { vr: 'UI', Value: ['1.2.sop.us'] },
    '00280008': { vr: 'IS', Value: [3] },
  }))];

  const items = await fetchSeriesItems({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    metadata,
    fetchImpl: async (url) => {
      const frameNumber = Number(url.split('/').pop());
      return {
        ok: true,
        async arrayBuffer() {
          return new Uint8Array([frameNumber, frameNumber]).buffer;
        },
      };
    },
  });

  assert.equal(items.length, 3);
  assert.equal(items[0].meta.Modality, 'US');
  assert.equal(items[2].meta.InstanceNumber, 3);
  assert.equal(items[2].meta.NumberOfFrames, 1);
});

test('fetchSeriesMetadata fails closed on non-array metadata payloads', async () => {
  await assert.rejects(
    () => fetchSeriesMetadata({
      wadoBase: 'https://pacs.example/wado-rs',
      studyUID: '1.2.study',
      seriesUID: '1.2.series',
      useCache: false,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { bad: true };
        },
      }),
    }),
    /must be an array/i,
  );
});

test('fetchSeriesItems limits concurrent frame fetches for large series', async () => {
  let active = 0;
  let peak = 0;
  const metadata = [normalizeInstance(dicomJsonInstance({
    '00080060': { vr: 'CS', Value: ['US'] },
    '00080018': { vr: 'UI', Value: ['1.2.sop.us.concurrent'] },
    '00280008': { vr: 'IS', Value: [5] },
  }))];

  await fetchSeriesItems({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    metadata,
    frameConcurrency: 2,
    fetchImpl: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return {
        ok: true,
        async arrayBuffer() {
          return new Uint8Array([1, 2]).buffer;
        },
      };
    },
  });

  assert.equal(peak, 2);
});

test('fetchSeriesMetadata cache is isolated by auth scope', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      async json() {
        return [dicomJsonInstance()];
      },
    };
  };

  await fetchSeriesMetadata({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    headers: { Authorization: 'Bearer A' },
    fetchImpl,
  });
  await fetchSeriesMetadata({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    headers: { Authorization: 'Bearer A' },
    fetchImpl,
  });
  await fetchSeriesMetadata({
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    headers: { Authorization: 'Bearer B' },
    fetchImpl,
  });

  assert.equal(calls, 2);
});

test('discoverQidoStudies returns normalized study summaries and reuses session cache', async () => {
  clearDicomwebSessions();
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.match(String(url), /\/studies\?/);
    assert.match(String(url), /PatientName=DOE\*/);
    assert.equal(options.headers.Accept, 'application/dicom+json');
    return {
      ok: true,
      async json() {
        return [{
          '0020000D': { vr: 'UI', Value: ['1.2.study.qido'] },
          '00100010': { vr: 'PN', Value: [{ Alphabetic: 'DOE^JANE' }] },
          '00100020': { vr: 'LO', Value: ['MRN001'] },
          '00080020': { vr: 'DA', Value: ['20260410'] },
          '00081030': { vr: 'LO', Value: ['Brain MRI'] },
          '00080061': { vr: 'CS', Value: ['MR'] },
          '00201206': { vr: 'IS', Value: [3] },
        }];
      },
    };
  };

  const first = await discoverQidoStudies({
    sessionId: 'qido-study-session',
    wadoBase: 'https://pacs.example/dicom-web',
    query: { PatientName: 'DOE*' },
    fetchImpl,
  });
  const second = await discoverQidoStudies({
    sessionId: 'qido-study-session',
    wadoBase: 'https://pacs.example/dicom-web',
    query: { PatientName: 'DOE*' },
    fetchImpl: async () => {
      throw new Error('QIDO study cache miss');
    },
  });

  assert.equal(calls, 1);
  assert.equal(first.length, 1);
  assert.equal(first[0].studyUID, '1.2.study.qido');
  assert.equal(first[0].patientName, 'DOE^JANE');
  assert.equal(first[0].seriesCount, 3);
  assert.deepEqual(second, first);
});

test('discoverQidoSeries supports study scoped discovery with resumable cache', async () => {
  clearDicomwebSessions();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(String(url), /\/studies\/1\.2\.study\.qido\/series/);
    return {
      ok: true,
      async json() {
        return [{
          '0020000D': { vr: 'UI', Value: ['1.2.study.qido'] },
          '0020000E': { vr: 'UI', Value: ['1.2.series.qido'] },
          '00080060': { vr: 'CS', Value: ['CT'] },
          '0008103E': { vr: 'LO', Value: ['CT AXIAL'] },
          '00200011': { vr: 'IS', Value: [4] },
          '00201209': { vr: 'IS', Value: [120] },
        }];
      },
    };
  };

  const series = await discoverQidoSeries({
    sessionId: 'qido-series-session',
    wadoBase: 'https://pacs.example/dicom-web',
    studyUID: '1.2.study.qido',
    fetchImpl,
  });
  const cached = await discoverQidoSeries({
    sessionId: 'qido-series-session',
    wadoBase: 'https://pacs.example/dicom-web',
    studyUID: '1.2.study.qido',
    fetchImpl: async () => {
      throw new Error('QIDO series cache miss');
    },
  });

  assert.equal(calls, 1);
  assert.equal(series.length, 1);
  assert.equal(series[0].seriesUID, '1.2.series.qido');
  assert.equal(series[0].modality, 'CT');
  assert.equal(series[0].instanceCount, 120);
  assert.deepEqual(cached, series);
});

test('fetchSeriesItems reuses metadata and frame bytes from the same session', async () => {
  clearDicomwebSessions();
  let metadataCalls = 0;
  let frameCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/metadata')) {
      metadataCalls += 1;
      return {
        ok: true,
        async json() {
          return [dicomJsonInstance({
            '00080018': { vr: 'UI', Value: ['1.2.sop.cache'] },
            '00280008': { vr: 'IS', Value: [2] },
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
          })];
        },
      };
    }
    frameCalls += 1;
    return {
      ok: true,
      async arrayBuffer() {
        return new Uint16Array([1, 2, 3, 4]).buffer;
      },
    };
  };

  await fetchSeriesItems({
    sessionId: 'cache-session',
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    fetchImpl,
  });
  await fetchSeriesItems({
    sessionId: 'cache-session',
    wadoBase: 'https://pacs.example/wado-rs',
    studyUID: '1.2.study',
    seriesUID: '1.2.series',
    fetchImpl: async () => {
      throw new Error('session cache should avoid network');
    },
  });

  const stats = getDicomwebSessionStats('cache-session');
  assert.equal(metadataCalls, 1);
  assert.equal(frameCalls, 2);
  assert.equal(stats.metadata, 1);
  assert.equal(stats.frames, 2);
});

test('DICOMweb frame cache stays bounded within one reusable session', async () => {
  clearDicomwebSessions();
  const wadoBase = 'https://pacs.example/wado-rs';
  const headers = { Authorization: 'Bearer top-secret-token' };
  const session = resolveDicomwebImportSession({ wadoBase, headers });

  for (let frame = 1; frame <= 300; frame += 1) {
    await fetchFrameBytes({
      wadoBase,
      studyUID: '1.2.study',
      seriesUID: '1.2.series',
      instanceUID: '1.2.sop.1',
      frame,
      headers,
      fetchImpl: async () => ({
        ok: true,
        async arrayBuffer() {
          return new Uint8Array([frame % 256]).buffer;
        },
      }),
    });
  }

  const stats = getDicomwebSessionStats(session.id);
  assert.equal(stats.sessionId, session.id);
  assert.equal(stats.frames, 256);
});

test('DICOMweb session registry stays bounded across many auth scopes', () => {
  clearDicomwebSessions();
  const sessions = [];
  for (let index = 0; index < 16; index += 1) {
    sessions.push(resolveDicomwebImportSession({
      wadoBase: 'https://pacs.example/wado-rs',
      headers: { Authorization: `Bearer token-${index}` },
    }));
  }

  assert.equal(getDicomwebSessionStats(sessions[0].id), null);
  assert.equal(getDicomwebSessionStats(sessions[15].id).sessionId, sessions[15].id);
});
