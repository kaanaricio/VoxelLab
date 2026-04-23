import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function walkJs(dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry);
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) out.push(...walkJs(rel));
    else if (rel.endsWith('.js')) out.push(rel);
  }
  return out;
}

test('service worker precaches every local JS module', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const cached = new Set([...sw.matchAll(/'\.\/(js\/[^']+\.js)'/g)].map((match) => match[1]));
  const modules = walkJs('js').sort();
  const missing = modules.filter((modulePath) => !cached.has(modulePath));

  assert.deepEqual(missing, []);
});
