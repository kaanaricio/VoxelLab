import assert from 'node:assert/strict';
import { test } from 'node:test';

test('cachedFetchResponse sends the local token for proxy-asset requests', async () => {
  globalThis.location = new URL('http://127.0.0.1/');
  const cacheStore = new Map();
  globalThis.caches = {
    async open() {
      return {
        match: async (key) => cacheStore.get(key),
        put: async (key, response) => { cacheStore.set(key, response); },
        delete: async (key) => cacheStore.delete(key),
      };
    },
    async keys() { return []; },
    async delete() { return true; },
  };

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    if (String(url).endsWith('/config.local.json') || String(url) === './config.local.json') {
      return new Response('', { status: 404 });
    }
    if (String(url).endsWith('/config.json') || String(url) === './config.json') {
      return Response.json({});
    }
    if (String(url).endsWith('/api/local-token')) {
      return Response.json({ localApiToken: 'local-token-123' });
    }
    return new Response('ok');
  };

  const { loadConfig } = await import('../js/config.js');
  const { cachedFetchResponse } = await import('../js/cached-fetch.js');
  await loadConfig();
  const response = await cachedFetchResponse('/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fslice.png');

  assert.equal(response.ok, true);
  assert.equal(calls.at(-1).headers['X-VoxelLab-Local-Token'], 'local-token-123');
});
