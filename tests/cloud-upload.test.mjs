/* global Response, URL */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overlayKindsForSeries } from '../js/runtime/overlay-kinds.js';
import { normalizeCloudSeriesEntry } from '../js/series-contract.js';

const CLOUD_OPTIONS = {
  trustedUploadOrigins: ['https://upload.example'],
};
const VALID_SERIES_ENTRY = {
  slug: 'cloud_job123',
  name: 'Cloud CT',
  description: '2 slices',
  slices: 2,
  width: 4,
  height: 4,
  pixelSpacing: [1, 1],
  sliceThickness: 1,
  hasRaw: true,
};

async function freshCloudModule() {
  // Example: file:///.../js/cloud.js?t=abc imports a fresh module state.
  const url = new URL(`../js/cloud.js?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

async function sharedConfigModule() {
  // Example: file:///.../js/config.js singleton reused by cloud.js.
  return import(new URL('../js/config.js', import.meta.url).href);
}

test('cloud upload completion fetches the processed manifest entry from R2', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') {
      return new Response('', { status: 200 });
    }
    if (String(url).endsWith('/start_processing')) {
      return Response.json({ status: 'started' });
    }
    if (String(url).endsWith('/check_status')) {
      return Response.json({ status: 'complete', slug: 'cloud_job123' });
    }
    if (String(url).startsWith('https://r2.example/results/')) {
      return Response.json({ ...VALID_SERIES_ENTRY });
    }
    return new Response('not found', { status: 404 });
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  assert.equal(result.slug, 'cloud_job123');
  assert.equal(result.seriesEntry.slug, 'cloud_job123');
  assert.equal(result.seriesEntry.sourceJobId, result.jobId);
  assert.equal(result.seriesEntry.sliceUrlBase, 'https://r2.example/data/cloud_job123');
  assert.equal(calls.find(c => c.url === 'https://upload.example/slice-1.dcm')?.method, 'PUT');
  const startBody = JSON.parse(calls.find(c => c.url.endsWith('/start_processing'))?.body);
  assert.deepEqual(Object.keys(startBody).sort(), ['job_id', 'modality', 'total_upload_bytes']);
  assert.equal(startBody.modality, 'auto');
  assert.equal(startBody.total_upload_bytes, 0);
  const statusBody = JSON.parse(calls.find(c => c.url.endsWith('/check_status'))?.body);
  assert.deepEqual(statusBody, { job_id: result.jobId });
  assert.ok(calls.some(c => c.url.startsWith('https://r2.example/results/')));
});

test('cloud upload matches the signer content-type contract for DICOM and source manifests', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
    });
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({
        urls: Object.fromEntries(body.items.map((item) => [item.upload_id, `https://upload.example/${item.filename}`])),
      });
    }
    if (String(url).startsWith('https://upload.example/')) return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) return Response.json({ status: 'complete', slug: 'cloud_job123' });
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', '', CLOUD_OPTIONS);

  await cloud.uploadAndProcess([
    { name: 'slice-1.dcm', type: 'application/octet-stream' },
    { name: 'voxellab.source.json', type: 'text/plain' },
  ]);

  const dicomPut = calls.find((call) => call.url === 'https://upload.example/slice-1.dcm');
  const manifestPut = calls.find((call) => call.url === 'https://upload.example/voxellab.source.json');

  assert.equal(dicomPut.headers['Content-Type'], 'application/dicom');
  assert.equal(manifestPut.headers['Content-Type'], 'application/json');
});

test('cloud upload still completes when no public R2 base is configured', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') {
      return new Response('', { status: 200 });
    }
    if (String(url).endsWith('/start_processing')) {
      return Response.json({ status: 'started' });
    }
    if (String(url).endsWith('/check_status')) {
      return Response.json({ status: 'complete', slug: 'cloud_job123' });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', '', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  assert.equal(result.slug, 'cloud_job123');
  assert.equal(result.seriesEntry, null);
});

test('cloud endpoints derive deployed Modal function URLs from app prefix', async () => {
  const cloud = await freshCloudModule();
  cloud.initCloud('https://example-org--medical-imaging-pipeline', '', CLOUD_OPTIONS);

  assert.equal(
    cloud.cloudEndpoint('get_upload_urls'),
    'https://example-org--medical-imaging-pipeline-get-upload-urls.modal.run',
  );
  assert.equal(
    cloud.cloudEndpoint('check_status'),
    'https://example-org--medical-imaging-pipeline-check-status.modal.run',
  );
});

test('cloud upload can request calibrated projection-set reconstruction mode', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({
        urls: Object.fromEntries(body.items.map(item => [item.upload_id, `https://upload.example/${item.filename}`])),
      });
    }
    if (String(url).startsWith('https://upload.example/')) return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_projection_job123',
        projection_set_entry: {
          id: 'projection_set_1',
          name: 'Projection Source',
          modality: 'XA',
          projectionKind: 'cbct',
          projectionCount: 2,
          reconstructionStatus: 'requires-calibration',
        },
        series_entry: {
          ...VALID_SERIES_ENTRY,
          slug: 'cloud_projection_job123',
          name: 'Projection Result',
          description: 'Derived volume',
          geometryKind: 'derivedVolume',
          sourceProjectionSetId: 'projection_set_1',
          sliceUrlBase: 'https://r2.example/data/cloud_projection_job123',
          rawUrl: 'https://r2.example/cloud_projection_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess(
    [{ name: 'projection-1.dcm' }, { name: 'projection-2.dcm' }],
    () => {},
    {
      processingMode: 'projection_set_reconstruction',
      inputKind: 'calibrated_projection_set',
    },
  );

  const startBody = JSON.parse(calls.find(call => call.url.endsWith('/start_processing'))?.body);
  assert.equal(startBody.modality, 'auto');
  assert.equal(startBody.total_upload_bytes, 0);
  assert.equal(startBody.processing_mode, 'projection_set_reconstruction');
  assert.equal(startBody.input_kind, 'calibrated_projection_set');
  assert.equal(result.seriesEntry.geometryKind, 'derivedVolume');
  assert.equal(result.seriesEntry.sourceProjectionSetId, 'projection_set_1');
  assert.equal(result.projectionSetEntry.id, 'projection_set_1');
  assert.equal(result.projectionSetEntry.projectionKind, 'cbct');
});

test('cloud upload uses trusted series entry returned by Modal status when present', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  assert.equal(result.seriesEntry.sliceUrlBase, 'https://r2.example/data/cloud_job123');
  assert.equal(result.seriesEntry.rawUrl, 'https://r2.example/cloud_job123.raw.zst');
  assert.equal(result.seriesEntry.sourceJobId, result.jobId);
});

test('cloud upload preserves explicit job identity fields returned by Modal', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          sourceJobId: 'modal_job_identity',
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  assert.equal(result.seriesEntry.sourceJobId, 'modal_job_identity');
});

test('cloud upload backfills trusted region overlay URLs for cloud results', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          hasRegions: true,
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  assert.equal(result.seriesEntry.regionUrlBase, 'https://r2.example/data/cloud_job123_regions');
  assert.equal(result.seriesEntry.regionMetaUrl, 'https://r2.example/data/cloud_job123_regions.json');
});

test('cloud normalization exposes canonical overlay kinds without changing legacy manifest flags', async () => {
  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const series = normalizeCloudSeriesEntry({
    ...VALID_SERIES_ENTRY,
    hasSeg: true,
    hasRegions: true,
    hasSym: true,
  }, { publicBase: 'https://r2.example/' });
  const overlays = overlayKindsForSeries(series);

  assert.equal(series.hasSeg, true);
  assert.equal(series.hasRegions, true);
  assert.equal(series.hasSym, true);
  assert.deepEqual(overlays.availableKinds, ['tissue', 'labels', 'heatmap']);
  assert.equal(overlays.byKind.tissue.source, 'cloud-seg');
  assert.equal(overlays.byKind.labels.source, 'cloud-regions');
  assert.equal(overlays.byKind.heatmap.source, 'cloud-sym');
});

test('cloud upload requests presigned URLs in batches and uploads every file before starting', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({
        urls: Object.fromEntries(body.items.map(item => [item.upload_id, `https://upload.example/${item.filename}`])),
      });
    }
    if (String(url).startsWith('https://upload.example/')) return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);
  const files = Array.from({ length: 501 }, (_, index) => ({ name: `slice-${index}.dcm` }));

  await cloud.uploadAndProcess(files);

  const urlRequests = calls.filter(call => call.url.endsWith('/get_upload_urls'));
  const putRequests = calls.filter(call => call.method === 'PUT');
  const startIndex = calls.findIndex(call => call.url.endsWith('/start_processing'));
  const lastPutIndex = Math.max(...calls.map((call, index) => call.method === 'PUT' ? index : -1));

  assert.deepEqual(urlRequests.map(call => JSON.parse(call.body).items.length), [450, 51]);
  assert.equal(putRequests.length, 501);
  assert.ok(startIndex > lastPutIndex);
});

test('cloud upload aborts before Modal processing when an R2 PUT fails', async (t) => {
  const previousFetch = globalThis.fetch;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 403 });
    if (String(url).endsWith('/start_processing')) assert.fail('processing should not start after failed upload');
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /Failed to upload slice-1\.dcm: 403/,
  );
  assert.equal(calls.some(call => call.url.endsWith('/start_processing')), false);
});

test('cloud upload aborts before Modal processing when a presigned URL is missing', async (t) => {
  const previousFetch = globalThis.fetch;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/get_upload_urls')) return Response.json({ urls: {} });
    if (String(url).endsWith('/start_processing')) assert.fail('processing should not start without all upload URLs');
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /Missing upload URL for slice-1\.dcm/,
  );
  assert.equal(calls.some(call => call.url.endsWith('/start_processing')), false);
});

test('cloud upload keeps duplicate basenames distinct with upload ids', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.items.map(item => item.filename), ['IM0001', 'IM0001']);
      assert.deepEqual(body.items.map(item => item.upload_id), ['f000000', 'f000001']);
      return Response.json({
        urls: {
          f000000: 'https://upload.example/a',
          f000001: 'https://upload.example/b',
        },
      });
    }
    if (String(url) === 'https://upload.example/a') return new Response('', { status: 200 });
    if (String(url) === 'https://upload.example/b') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await cloud.uploadAndProcess([{ name: 'IM0001' }, { name: 'IM0001' }]);

  assert.equal(calls.filter(call => call.method === 'PUT').length, 2);
});

test('cloud upload rejects upload URLs outside the trusted allowlist', async (t) => {
  const previousFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://evil.example/upload'])) });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /untrusted origin/,
  );
});

test('cloud upload rejects presigned URLs that exceed the 15 minute expiry limit', async (t) => {
  const previousFetch = globalThis.fetch;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({
        urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm?expires=901'])),
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm', size: 1234 }]),
    /invalid expiry: 901s/,
  );
  assert.equal(calls.some(call => call.method === 'PUT'), false);
  assert.equal(calls.some(call => call.url.endsWith('/start_processing')), false);
});

test('cloud upload fails immediately on invalid complete payloads', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({ status: 'complete', slug: 'cloud_job123', series_entry: { slug: 'broken' } });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /missing required series metadata/i,
  );
});

test('cloud upload rejects complete payloads without any trustworthy slug', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) return Response.json({ status: 'complete' });
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', '', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /missing a completed slug/i,
  );
});

test('cloud upload rejects complete payloads whose status slug disagrees with the trusted series entry', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_wrong',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          slug: 'cloud_job123',
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /slug mismatch/i,
  );
});

test('cloud upload rejects derived results that omit the projection set registry entry', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_projection_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          slug: 'cloud_projection_job123',
          name: 'Projection Result',
          description: 'Derived volume',
          geometryKind: 'derivedVolume',
          sourceProjectionSetId: 'projection_set_1',
          sliceUrlBase: 'https://r2.example/data/cloud_projection_job123',
          rawUrl: 'https://r2.example/cloud_projection_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /missing projection set projection_set_1/i,
  );
});

test('cloud upload rejects projection set entries that do not match the derived result binding', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_projection_job123',
        projection_set_entry: {
          id: 'projection_set_wrong',
          name: 'Projection Source',
          modality: 'XA',
          projectionKind: 'cbct',
          projectionCount: 2,
          reconstructionStatus: 'requires-calibration',
        },
        series_entry: {
          ...VALID_SERIES_ENTRY,
          slug: 'cloud_projection_job123',
          name: 'Projection Result',
          description: 'Derived volume',
          geometryKind: 'derivedVolume',
          sourceProjectionSetId: 'projection_set_1',
          sliceUrlBase: 'https://r2.example/data/cloud_projection_job123',
          rawUrl: 'https://r2.example/cloud_projection_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /projection set id mismatch/i,
  );
});

test('local cloud proxy requests include the same-origin runtime token header', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  // Shape: local config.json payload served by serve.py for browser runtime.
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/config.json') || String(url).endsWith('./config.json')) {
      return Response.json({ localApiToken: 'local-token-123' });
    }
    assert.fail(`unexpected config fetch ${url}`);
  };
  const config = await sharedConfigModule();
  await config.loadConfig();

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {} });
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('/api/cloud', 'https://r2.example/', CLOUD_OPTIONS);

  await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  const proxyCalls = calls.filter(call => call.url.startsWith('/api/cloud/'));
  assert.equal(proxyCalls.length, 3);
  assert.deepEqual(
    proxyCalls.map(call => call.headers['X-VoxelLab-Local-Token']),
    ['local-token-123', 'local-token-123', 'local-token-123'],
  );
  const uploadCall = calls.find(call => call.method === 'PUT');
  assert.equal(uploadCall?.headers['X-VoxelLab-Local-Token'], undefined);
});
