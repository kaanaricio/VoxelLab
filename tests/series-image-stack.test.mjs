import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/config.local.json') || String(url).endsWith('./config.local.json')) {
    return new Response('', { status: 404 });
  }
  if (String(url).endsWith('/config.json') || String(url).endsWith('./config.json')) {
    return Response.json({ localApiToken: 'local-dev-token' });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const config = await import('../js/config.js');
await config.loadConfig();
globalThis.fetch = previousFetch;

const {
  assetUrlForBrowser,
  imageUrlForStack,
  loadImageStack,
  rawVolumeUrlForSeries,
  regionMetaUrlForSeries,
} = await import('../js/series-image-stack.js');
const { state } = await import('../js/state.js');

test('imageUrlForStack keeps bundled prototype data on local ./data paths', () => {
  const url = imageUrlForStack('t2_tse', 3, { slug: 't2_tse' });

  assert.equal(url, './data/t2_tse/0003.png');
});

test('imageUrlForStack supports R2-backed processed cloud series', () => {
  const series = { slug: 'cloud_job123', sliceUrlBase: 'https://r2.example/data/cloud_job123/' };

  const url = imageUrlForStack('cloud_job123', 12, series);

  assert.equal(url, '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fcloud_job123%2F0012.png');
});

test('imageUrlForStack supports R2-backed overlay stacks without changing bundled overlays', () => {
  const series = {
    slug: 'cloud_job123',
    overlayUrlBases: {
      cloud_job123_regions: 'https://r2.example/data/cloud_job123_regions/',
    },
  };

  assert.equal(
    imageUrlForStack('cloud_job123_regions', 1, series),
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fcloud_job123_regions%2F0001.png',
  );
  assert.equal(
    imageUrlForStack('t2_tse_regions', 1, { slug: 't2_tse' }),
    './data/t2_tse_regions/0001.png',
  );
});

test('imageUrlForStack supports the compact regionUrlBase manifest field', () => {
  const series = {
    slug: 'cloud_job123',
    regionUrlBase: 'https://r2.example/data/cloud_job123_regions/',
  };

  assert.equal(
    imageUrlForStack('cloud_job123_regions', 4, series),
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fcloud_job123_regions%2F0004.png',
  );
});

test('regionMetaUrlForSeries supports R2-backed region sidecars', () => {
  const series = {
    slug: 'cloud_job123',
    regionMetaUrl: 'https://r2.example/data/cloud_job123_regions.json',
  };

  assert.equal(
    regionMetaUrlForSeries(series),
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fcloud_job123_regions.json',
  );
  assert.equal(regionMetaUrlForSeries({ slug: 't2_tse' }), './data/t2_tse_regions.json');
});

test('assetUrlForBrowser keeps local assets direct and proxies remote ones on localhost', () => {
  assert.equal(assetUrlForBrowser('./data/t2_tse/0003.png'), './data/t2_tse/0003.png');
  assert.equal(
    assetUrlForBrowser('https://r2.example/cloud_job123.raw.zst'),
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fcloud_job123.raw.zst',
  );
});

test('rawVolumeUrlForSeries proxies remote raw volumes on localhost', () => {
  assert.equal(
    rawVolumeUrlForSeries({ slug: 'cloud_job123', rawUrl: 'https://r2.example/cloud_job123.raw.zst' }),
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fcloud_job123.raw.zst',
  );
  assert.equal(rawVolumeUrlForSeries({ slug: 't2_tse' }), './data/t2_tse.raw');
});

test('loadImageStack reuses in-memory local DICOM/NIfTI imports', async () => {
  const localImgs = [
    { complete: true, naturalWidth: 4 },
    { complete: true, naturalWidth: 4 },
  ];
  state._localStacks = { local_abc: localImgs };

  const result = loadImageStack('local_abc', 2, []);
  await Promise.all(result.loaders);

  assert.equal(result.imgs, localImgs);
  assert.equal(result.imgs._dir, 'local_abc');
});

test('loadImageStack can start with only a visible slice window and backfill later', async (t) => {
  const previousImage = globalThis.Image;

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  const result = loadImageStack(
    'cloud_job123',
    20,
    [],
    { slug: 'cloud_job123', sliceUrlBase: 'https://r2.example/data/cloud_job123/' },
    { windowRadius: 5, initialIndex: 10 },
  );
  await Promise.all(result.loaders);

  assert.equal(result.imgs.filter(Boolean).length, 11);
  await result.imgs.prefetchRemaining(10, 5);
  assert.equal(result.imgs.filter(Boolean).length, 20);
});
