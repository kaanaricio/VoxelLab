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

test('applyCrossOriginPreloads skips proxy-asset image preloads that cannot carry local auth', () => {
  links.length = 0;
  applyCrossOriginPreloads({
    series: [{
      slug: 'cloud_preload',
      sliceUrlBase: 'https://r2.example/data/cloud_preload/',
      rawUrl: 'https://r2.example/cloud_preload.raw.zst',
    }],
  });

  assert.ok(links.find((link) => link.rel === 'preconnect' && link.href === 'https://r2.example'));
  assert.equal(links.find((link) => link.rel === 'preload'), undefined);
});
