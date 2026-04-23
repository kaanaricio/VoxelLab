import assert from 'node:assert/strict';
import { test } from 'node:test';

const { SLICE_COMPOSITOR_VERTEX_SHADER } = await import('../js/slice-compositor.js');

test('shared slice compositor flips Y in the GPU vertex shader to match canvas image origin', () => {
  assert.match(SLICE_COMPOSITOR_VERTEX_SHADER, /1\.0\s*-\s*\(aPosition\.y\s*\*\s*0\.5\s*\+\s*0\.5\)/);
});
