#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const root = join(dirname(scriptPath), '..');
const rawArgs = process.argv.slice(2);
const flags = new Set();
const options = new Map();
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const venvPython = process.platform === 'win32'
  ? join(root, '.venv', 'Scripts', 'python.exe')
  : join(root, '.venv', 'bin', 'python');

for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg.startsWith('--provider=')) {
    options.set('--provider', arg.slice('--provider='.length));
    continue;
  }
  if (arg === '--provider') {
    const value = rawArgs[index + 1];
    if (!value || value.startsWith('--')) {
      console.error('Missing value for --provider');
      process.exit(1);
    }
    options.set('--provider', value);
    index += 1;
    continue;
  }
  if (arg.startsWith('--demo=')) {
    options.set('--demo', arg.slice('--demo='.length));
    continue;
  }
  if (arg === '--demo') {
    const value = rawArgs[index + 1];
    if (!value || value.startsWith('--')) {
      console.error('Missing value for --demo');
      process.exit(1);
    }
    options.set('--demo', value);
    index += 1;
    continue;
  }
  flags.add(arg);
}

function run(command, args, options = {}) {
  console.log(`\n> ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function parseYesNo(answer, fallback) {
  const value = answer.trim().toLowerCase();
  if (!value) return fallback;
  if (['y', 'yes'].includes(value)) return true;
  if (['n', 'no'].includes(value)) return false;
  console.error(`Unknown choice: ${answer}`);
  process.exit(1);
}

function printNextSteps({ demoMode, withMri, withCt, flags }) {
  const lines = [
    'Open VoxelLab: npm start',
    'Trust check: npm run check',
  ];
  if (demoMode !== 'none') {
    lines.push('Try the shipped demo: open http://localhost:8000 after start');
  } else {
    lines.push('Use your own data: open http://localhost:8000 and drag in DICOM or NIfTI');
  }
  if (withMri || withCt) {
    lines.push('Extra source packs were installed under demo_packs/ and data/');
  }
  if (flags.has('--cloud')) {
    lines.push('Cloud preflight: npm run check:cloud');
  }
  if (flags.has('--pipeline') || flags.has('--rtk')) {
    lines.push('Pipeline preflight: npm run check:pipeline');
  }
  if (flags.has('--ai')) {
    lines.push('AI readiness: npm run ai:doctor');
  }
  console.log('\nNext steps:');
  for (const line of lines) {
    console.log(`  - ${line}`);
  }
}

async function chooseDemoSelection() {
  if (options.has('--demo') || !process.stdin.isTTY || !process.stdout.isTTY) {
    return {
      demoMode: options.get('--demo') || 'none',
      withMri: flags.has('--with-mri'),
      withCt: flags.has('--with-ct'),
    };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const lite = parseYesNo(
      await rl.question('Install the shipped public MRI demo pack with pregenerated artifacts (~44 MB download, ~82 MB unpacked)? [Y/n] '),
      true,
    );
    const withMri = parseYesNo(
      await rl.question('Download the public MRI source files too (~62 MB download)? [y/N] '),
      false,
    );
    const withCt = parseYesNo(
      await rl.question('Download the public CT source files too (~291 MB download)? [y/N] '),
      false,
    );
    return {
      demoMode: lite ? 'lite' : 'none',
      withMri,
      withCt,
    };
  } finally {
    rl.close();
  }
}

function probePython(command, baseArgs = []) {
  const code = [
    'import sys',
    'print(sys.executable)',
    'raise SystemExit(0 if sys.version_info >= (3, 11) else 42)',
  ].join('; ');
  const result = spawnSync(command, [...baseArgs, '-c', code], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status === 0) return { command, baseArgs };
  if (result.status === 42) {
    const version = spawnSync(command, [...baseArgs, '--version'], { encoding: 'utf8' });
    console.error(`${command} ${baseArgs.join(' ')} is too old: ${(version.stdout || version.stderr).trim()}`);
    console.error('VoxelLab tooling requires Python 3.11 or newer.');
    process.exit(1);
  }
  return null;
}

function findPython() {
  const candidates = [
    ...(process.env.PYTHON ? [[process.env.PYTHON, []]] : []),
    ['python3', []],
    ['python', []],
    ['py', ['-3']],
  ];
  for (const [command, baseArgs] of candidates) {
    const found = probePython(command, baseArgs);
    if (found) return found;
  }
  console.error('Could not find Python 3.11+. Install Python, then rerun `npm run setup`.');
  process.exit(1);
}

const extras = ['dev'];
if (flags.has('--ai')) extras.push('ai');
if (flags.has('--pipeline')) extras.push('pipeline');
if (flags.has('--cloud')) extras.push('cloud');
if (flags.has('--rtk')) extras.push('rtk');

const python = findPython();
const demoSelection = await chooseDemoSelection();
const demoMode = demoSelection.demoMode;

if (!existsSync(venvPython)) {
  run(python.command, [...python.baseArgs, '-m', 'venv', '.venv']);
}

if (!flags.has('--skip-python')) {
  run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  run(venvPython, ['-m', 'pip', 'install', '-e', `.[${extras.join(',')}]`]);
}

if (!flags.has('--skip-npm')) {
  const npmInstallMode = existsSync(join(root, 'package-lock.json')) ? 'ci' : 'install';
  run(npmCmd, [npmInstallMode]);
}

if (!flags.has('--skip-playwright')) {
  run(npxCmd, ['playwright', 'install', 'chromium']);
}

if (flags.has('--ai')) {
  const provider = options.get('--provider');
  const args = ['scripts/check_ai_ready.py'];
  if (provider) args.push('--provider', provider);
  run(venvPython, args);
}

if (demoMode !== 'none' || demoSelection.withMri || demoSelection.withCt) {
  const args = ['scripts/install_demo_data.py', '--demo', demoMode];
  if (demoSelection.withMri) args.push('--with-mri');
  if (demoSelection.withCt) args.push('--with-ct');
  run(venvPython, args);
}

console.log('\nSetup complete.');
printNextSteps({
  demoMode,
  withMri: demoSelection.withMri,
  withCt: demoSelection.withCt,
  flags,
});
