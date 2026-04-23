import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadDotenv(path = '.env') {
  if (!fs.existsSync(path)) return {};
  return Object.fromEntries(
    fs.readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && line.includes('='))
      .map(line => {
        const index = line.indexOf('=');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')];
      }),
  );
}

function envValue(env, name) {
  return process.env[name] || env[name] || '';
}

function envBool(env, name) {
  const value = envValue(env, name);
  if (!value) return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envList(env, name) {
  const value = envValue(env, name);
  if (!value) return undefined;
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const writeTracked = process.argv.includes('--write-tracked');
const configPath = path.join(ROOT, 'config.json');
const outputPath = writeTracked ? configPath : path.join(ROOT, 'config.local.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const env = loadDotenv(path.join(ROOT, '.env'));

for (const [envKey, configKey] of [
  ['MODAL_WEBHOOK_BASE', 'modalWebhookBase'],
  ['R2_PUBLIC_URL', 'r2PublicUrl'],
  ['SITE_NAME', 'siteName'],
  ['VIEWER_DISCLAIMER', 'disclaimer'],
]) {
  const value = envValue(env, envKey);
  if (value) config[configKey] = value;
}

const trustedUploadOrigins = envList(env, 'TRUSTED_UPLOAD_ORIGINS');
if (trustedUploadOrigins) config.trustedUploadOrigins = trustedUploadOrigins;
delete config.modalAuthToken;
delete config.localApiToken;

const features = { ...(config.features || {}) };
for (const [envKey, featureKey] of [
  ['VIEWER_CLOUD_PROCESSING', 'cloudProcessing'],
  ['VIEWER_AI_ANALYSIS', 'aiAnalysis'],
]) {
  const value = envBool(env, envKey);
  if (value !== undefined) features[featureKey] = value;
}
config.features = features;

fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
