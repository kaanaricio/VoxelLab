import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const links = [];
globalThis.document = {
  head: {
    appendChild(node) {
      links.push(node);
    },
  },
  createElement(tag) {
    assert.equal(tag, 'link');
    return {};
  },
};

const { applyCrossOriginPreloads } = await import('../js/preload-cross-origin.js');

test('applyCrossOriginPreloads routes the active first-slice preload through the local asset proxy', () => {
  links.length = 0;
  applyCrossOriginPreloads({
    series: [{
      slug: 'cloud_preload',
      sliceUrlBase: 'https://r2.example/data/cloud_preload/',
      rawUrl: 'https://r2.example/cloud_preload.raw.zst',
    }],
  });

  const preload = links.find((link) => link.rel === 'preload');
  assert.ok(preload, 'expected an active-series preload link');
  assert.equal(
    preload.href,
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fcloud_preload%2F0000.png',
  );
});
