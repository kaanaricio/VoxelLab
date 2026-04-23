import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_ROOTS = ['index.html', 'templates'];
const JS_ROOTS = ['viewer.js', 'js'];
const INLINE_STYLE_JS_TARGETS = new Set([
  'js/consult-ask.js',
  'js/projects-sidebar.js',
  'js/study-upload-modal.js',
]);
const INNER_HTML_ALLOWLIST = new Set([
  'js/analysis-findings.js',
  'js/annotation.js',
  'js/command-palette.js',
  'js/compare.js',
  'js/consult-ask.js',
  'js/dom.js',
  'js/fusion-regions.js',
  'js/measure.js',
  'js/metadata.js',
  'js/mpr-view.js',
  'js/notify.js',
  'js/plugin.js',
  'js/projects-sidebar.js',
  'js/select-series-dom.js',
  'js/slice-view.js',
  'js/study-upload-modal.js',
  'js/template-loader.js',
  'js/volume-3d-hover.js',
  'js/volume-label-overlay.js',
  'js/volumes-panel.js',
]);

function walk(target, out = []) {
  const abs = path.join(ROOT, target);
  const stats = statSync(abs);
  if (stats.isFile()) {
    out.push(target);
    return out;
  }
  for (const entry of readdirSync(abs)) {
    walk(path.join(target, entry), out);
  }
  return out;
}

function lineNumbers(text, pattern) {
  return text
    .split('\n')
    .map((line, index) => (pattern.test(line) ? index + 1 : 0))
    .filter(Boolean);
}

const issues = [];

for (const target of HTML_ROOTS.flatMap((item) => walk(item))) {
  if (!target.endsWith('.html')) continue;
  const text = readFileSync(path.join(ROOT, target), 'utf8');
  const lines = lineNumbers(text, /style\s*=/);
  if (lines.length) issues.push(`${target}: inline style attribute at ${lines.join(', ')}`);
}

for (const target of JS_ROOTS.flatMap((item) => walk(item))) {
  if (!target.endsWith('.js')) continue;
  const text = readFileSync(path.join(ROOT, target), 'utf8');
  if (INLINE_STYLE_JS_TARGETS.has(target)) {
    const styleLines = lineNumbers(text, /style\s*=/);
    if (styleLines.length) issues.push(`${target}: inline style attribute string at ${styleLines.join(', ')}`);
  }
  if (!INNER_HTML_ALLOWLIST.has(target) && /(innerHTML\s*=|insertAdjacentHTML)/.test(text)) {
    issues.push(`${target}: new innerHTML/insertAdjacentHTML usage needs review`);
  }
}

if (issues.length) {
  console.error('Inline-style / innerHTML guard failed:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}
