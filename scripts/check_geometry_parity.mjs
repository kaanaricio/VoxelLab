#!/usr/bin/env node
// Geometry contract guard for the JS/Python dual implementation.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURE_PATH = join(ROOT, 'tests', 'fixtures', 'geometry', 'canonical-cases.json');
const JS_PATH = join(ROOT, 'js', 'geometry.js');
const PY_PATH = join(ROOT, 'geometry.py');
const PYTHON = process.env.PYTHON
  || (existsSync(join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
    ? join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    : (process.platform === 'win32' ? 'python' : 'python3'));

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const contractKeys = new Set(Object.keys(fixture.sharedContract));

const sharedMap = new Map([
  ['dot3', { js: 'dot3', py: 'dot3' }],
  ['cross3', { js: 'cross3', py: 'cross3' }],
  ['norm3', { js: 'norm3', py: 'norm3' }],
  ['normalize3', { js: 'normalize3', py: 'normalize3' }],
  ['sliceNormalFromIOP', { js: 'sliceNormalFromIOP', py: 'slice_normal_from_iop' }],
  ['projectionAlongNormal', { js: 'projectionAlongNormal', py: 'ipp_projection' }],
  ['sortDatasetsSpatially', { js: 'sortDatasetsSpatially', py: 'sort_datasets_spatially' }],
  ['sliceSpacingStatsFromPositions', { js: 'sliceSpacingStatsFromPositions', py: 'spacing_from_positions' }],
  ['classifyGeometryKind', { js: 'classifyGeometryKind', py: 'classify_geometry_kind' }],
  ['affineLpsFromSeries', { js: 'geometryFromSeries', py: 'affine_lps_from_series' }],
  ['compareGroup', { js: 'seriesCompareGroup', py: 'compare_group_key' }],
  ['buildGeometryRecord', { js: 'buildGeometryRecord', py: 'build_geometry_record' }],
]);

const allowedJsOnly = new Set([
  'orientationFromIOP',
  'voxelToPatientLps',
  'geometryFromDicomMetas',
  'inPlaneDisplaySize',
  'patientPointAtSlice',
  'closestSliceIndexForPatientPoint',
]);
const allowedPyOnly = new Set(['float_list', 'slice_sort_key', 'extract_enhanced_multiframe_slices', 'geometry_from_slices', 'series_effective_slice_spacing']);

let failed = false;
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  failed = true;
};
const pass = (message) => console.log(`OK: ${message}`);

for (const key of contractKeys) {
  if (!sharedMap.has(key)) fail(`fixture contract "${key}" is missing from sharedMap`);
}
for (const key of sharedMap.keys()) {
  if (!contractKeys.has(key)) fail(`sharedMap contract "${key}" is missing from canonical-cases.json`);
}

const jsExports = [...readFileSync(JS_PATH, 'utf8').matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
const pyDefs = [...readFileSync(PY_PATH, 'utf8').matchAll(/^def (\w+)/gm)].map((m) => m[1]);
const mappedJs = new Set([...sharedMap.values()].map((value) => value.js));
const mappedPy = new Set([...sharedMap.values()].map((value) => value.py));

for (const name of jsExports) {
  if (!mappedJs.has(name) && !allowedJsOnly.has(name)) fail(`js/geometry.js export "${name}" lacks a shared fixture entry or allowlist reason`);
}
for (const name of pyDefs) {
  if (!mappedPy.has(name) && !allowedPyOnly.has(name)) fail(`geometry.py function "${name}" lacks a shared fixture entry or allowlist reason`);
}

if (!failed) pass('fixture keys, shared map, and allowlists are in sync');

try {
  execSync('node --test tests/geometry.test.mjs', { cwd: ROOT, stdio: 'inherit' });
  pass('JS geometry contract tests pass');
} catch (error) {
  fail(`JS geometry contract tests failed: ${error.status ?? error.message}`);
}

try {
  execSync(`${JSON.stringify(PYTHON)} -m pytest -q tests/test_geometry.py`, { cwd: ROOT, stdio: 'inherit' });
  pass('Python geometry contract tests pass');
} catch (error) {
  fail(`Python geometry contract tests failed: ${error.status ?? error.message}`);
}

if (failed) process.exit(1);
console.log('All geometry contract checks passed.');
