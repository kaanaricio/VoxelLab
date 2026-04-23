import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function loadMiddleware() {
  // Example: middleware.js source loaded as an ESM data URL for Node tests.
  const source = await readFile(new URL('../middleware.js', import.meta.url), 'utf8');

  // Shape: data:text/javascript;charset=utf-8,export%20const%20config%20%3D...
  const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
  return import(url);
}

function basicAuth(password, username = 'viewer') {
  // Example: "Basic dmlld2VyOnNlY3JldA==".
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function requestWithAuth(auth) {
  // Shape: Request for the middleware-protected static root.
  const headers = auth ? { authorization: auth } : {};
  return new Request('https://mri-viewer.test/', { headers });
}

const { default: middleware } = await loadMiddleware();

test('middleware fails closed when VIEWER_PASSWORD is missing', async (t) => {
  // Example: process.env.VIEWER_PASSWORD === undefined for a misconfigured deploy.
  const previous = process.env.VIEWER_PASSWORD;
  t.after(() => {
    if (previous === undefined) delete process.env.VIEWER_PASSWORD;
    else process.env.VIEWER_PASSWORD = previous;
  });
  delete process.env.VIEWER_PASSWORD;

  const response = middleware(requestWithAuth());

  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'VIEWER_PASSWORD env var is not set on this deployment.');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('middleware rejects wrong Basic auth credentials', async (t) => {
  // Example: process.env.VIEWER_PASSWORD === "correct-password".
  const previous = process.env.VIEWER_PASSWORD;
  t.after(() => {
    if (previous === undefined) delete process.env.VIEWER_PASSWORD;
    else process.env.VIEWER_PASSWORD = previous;
  });
  process.env.VIEWER_PASSWORD = 'correct-password';

  const response = middleware(requestWithAuth(basicAuth('wrong-password')));

  assert.equal(response.status, 401);
  assert.equal(await response.text(), 'Authentication required');
  assert.equal(response.headers.get('www-authenticate'), 'Basic realm="VoxelLab", charset="UTF-8"');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('middleware allows any username with the correct password', async (t) => {
  // Example: username is ignored, password is "correct-password".
  const previous = process.env.VIEWER_PASSWORD;
  t.after(() => {
    if (previous === undefined) delete process.env.VIEWER_PASSWORD;
    else process.env.VIEWER_PASSWORD = previous;
  });
  process.env.VIEWER_PASSWORD = 'correct-password';

  const response = middleware(requestWithAuth(basicAuth('correct-password', 'radiologist')));

  assert.equal(response, undefined);
});

test('middleware rejects malformed Basic auth headers with the same hardening response', async (t) => {
  // Example: invalid base64 payload should fail closed with the normal 401 response.
  const previous = process.env.VIEWER_PASSWORD;
  t.after(() => {
    if (previous === undefined) delete process.env.VIEWER_PASSWORD;
    else process.env.VIEWER_PASSWORD = previous;
  });
  process.env.VIEWER_PASSWORD = 'correct-password';

  const response = middleware(requestWithAuth('Basic !!!not-base64!!!'));

  assert.equal(response.status, 401);
  assert.equal(await response.text(), 'Authentication required');
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, private');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});
