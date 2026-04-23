// Cloud processing module. Handles the browser side of the
// "upload DICOMs → process on Modal GPU → load results" flow.
//
// Flow:
//   1. User drops DICOM files on the upload zone
//   2. We generate a unique job_id
//   3. Call Modal's get_upload_urls webhook to get presigned R2 PUT URLs
//   4. Upload files directly from browser → R2 (no proxy)
//   5. Call Modal's start_processing webhook
//   6. Poll check_status until complete
//   7. Fetch the series.json result and add it to the manifest
//
// The Modal webhook URLs are configured at init time. If not configured,
// the cloud features are silently disabled (local-only mode).

import { localApiHeaders } from './config.js';
import { cachedFetchResponse } from './cached-fetch.js';
import { beginPerfTrace } from './perf-trace.js';
import {
  normalizeCloudSeriesEntry,
  normalizeCloudUploadResult,
  normalizeOrigin,
} from './series-contract.js';

let _webhookBase = '';
let _r2PublicBase = '';
let _trustedUploadOrigins = [];

const MODAL_FUNCTIONS = {
  get_upload_urls: 'get-upload-urls',
  start_processing: 'start-processing',
  check_status: 'check-status',
};
const UPLOAD_URL_BATCH_SIZE = 450;
const UPLOAD_CONCURRENCY = 6;
const MAX_PRESIGNED_UPLOAD_SECONDS = 15 * 60;
const SOURCE_MANIFEST_NAMES = new Set(['voxellab.source.json', 'voxellab-source.json']);

function cloudPollDelay(elapsedMs) {
  if (elapsedMs < 15_000) return 500;
  if (elapsedMs < 60_000) return 1_000;
  if (elapsedMs < 10 * 60_000) return 3_000;
  return 5_000;
}

function normalizeOrigins(values) {
  const out = new Set();
  for (const value of values || []) {
    const origin = normalizeOrigin(value);
    if (origin) out.add(origin);
  }
  return [...out];
}

function trustedUploadOrigins() {
  if (_trustedUploadOrigins.length) return _trustedUploadOrigins;
  const fallback = normalizeOrigin(_r2PublicBase);
  return fallback ? [fallback] : [];
}

function cloudHeaders(headers = {}) {
  return _webhookBase.startsWith('/api/cloud')
    ? localApiHeaders(headers)
    : headers;
}

function terminalCloudError(message) {
  const error = new Error(message);
  error.cloudTerminal = true;
  return error;
}

function validateUploadUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Cloud upload returned an invalid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Cloud upload returned a non-HTTPS URL');
  }
  const allowlist = trustedUploadOrigins();
  if (allowlist.length && !allowlist.includes(parsed.origin)) {
    throw new Error(`Cloud upload returned an untrusted origin: ${parsed.origin}`);
  }
  const rawExpiry = parsed.searchParams.get('X-Amz-Expires')
    || parsed.searchParams.get('x-amz-expires')
    || parsed.searchParams.get('expires');
  const expiry = rawExpiry == null ? NaN : Number(rawExpiry);
  if (rawExpiry != null && (!Number.isFinite(expiry) || expiry <= 0 || expiry > MAX_PRESIGNED_UPLOAD_SECONDS)) {
    throw new Error(`Cloud upload returned an invalid expiry: ${expiry}s`);
  }
  return parsed.href;
}

export function initCloud(webhookBaseUrl, r2PublicUrl = '', options = {}) {
  _webhookBase = (webhookBaseUrl || '').replace(/\/+$/, '');
  _r2PublicBase = (r2PublicUrl || '').replace(/\/+$/, '');
  _trustedUploadOrigins = normalizeOrigins(options.trustedUploadOrigins);
}

export function isCloudAvailable() {
  return !!(_webhookBase && (trustedUploadOrigins().length || _r2PublicBase));
}

export function cloudEndpoint(name) {
  if (!_webhookBase) return '';
  const suffix = MODAL_FUNCTIONS[name];
  try {
    const url = new URL(_webhookBase);
    if (!url.hostname.endsWith('.modal.run') && url.hostname.includes('--')) {
      return `https://${url.hostname}-${suffix}.modal.run`;
    }
    if (url.hostname.endsWith('.modal.run')) {
      let host = url.hostname.replace(/\.modal\.run$/, '');
      for (const known of Object.values(MODAL_FUNCTIONS)) {
        if (host.endsWith(`-${known}`)) host = host.slice(0, -(known.length + 1));
      }
      return `https://${host}-${suffix}.modal.run`;
    }
  } catch {}
  return `${_webhookBase}/${name}`;
}

function makeJobId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `job_${Date.now().toString(36)}_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function chunks(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function uploadIdForIndex(index) {
  return `f${String(index).padStart(6, '0')}`;
}

function uploadContentType(filename) {
  return SOURCE_MANIFEST_NAMES.has(filename) ? 'application/json' : 'application/dicom';
}

async function uploadFile(url, file) {
  const response = await fetch(url, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': uploadContentType(file.name) },
  });
  if (!response.ok) throw new Error(`Failed to upload ${file.name}: ${response.status}`);
}

async function uploadFiles(items, jobId, onProgress) {
  onProgress('uploading', `0 / ${items.length}`);
  let uploaded = 0;

  for (const urlBatch of chunks(items, UPLOAD_URL_BATCH_SIZE)) {
    const requestItems = urlBatch.map(item => ({ upload_id: item.upload_id, filename: item.filename }));
    const urlResp = await fetch(cloudEndpoint('get_upload_urls'), {
      method: 'POST',
      headers: cloudHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ job_id: jobId, items: requestItems }),
    });
    if (!urlResp.ok) throw new Error(`Failed to get upload URLs: ${urlResp.status}`);
    const { urls, status, error } = await urlResp.json();
    if (status === 'error') throw new Error(error || 'Failed to get upload URLs');
    if (!urls || typeof urls !== 'object') throw new Error('Failed to get upload URLs: missing urls');

    const uploadTasks = urlBatch.map(item => async () => {
      const rawUrl = urls[item.upload_id];
      if (!rawUrl) throw new Error(`Missing upload URL for ${item.filename}`);
      const url = validateUploadUrl(rawUrl);
      await uploadFile(url, item.file);
      uploaded++;
      onProgress('uploading', `${uploaded} / ${items.length}`);
    });

    for (const uploadBatch of chunks(uploadTasks, UPLOAD_CONCURRENCY)) {
      await Promise.all(uploadBatch.map(task => task()));
    }
  }
}

function startProcessingPayload(jobId, totalUploadBytes, processing = {}) {
  const payload = { job_id: jobId, modality: processing.modality || 'auto' };
  payload.total_upload_bytes = totalUploadBytes;
  const processingMode = processing.processingMode || processing.processing_mode;
  const inputKind = processing.inputKind || processing.input_kind;
  if (processingMode) payload.processing_mode = processingMode;
  if (inputKind) payload.input_kind = inputKind;
  return payload;
}

export async function uploadAndProcess(files, onProgress = () => {}, processing = {}) {
  if (!isCloudAvailable()) throw new Error('Cloud processing is not fully configured');
  const jobId = makeJobId();
  const uploadFilesList = Array.from(files);
  if (!uploadFilesList.length) throw new Error('No files selected');
  const totalUploadBytes = uploadFilesList.reduce((sum, file) => sum + Math.max(0, Number(file?.size) || 0), 0);
  const uploadItems = uploadFilesList.map((file, index) => ({
    upload_id: uploadIdForIndex(index),
    filename: file.name,
    file,
  }));

  onProgress('preparing', `${uploadItems.length} files`);
  await uploadFiles(uploadItems, jobId, onProgress);

  onProgress('processing', 'starting GPU pipeline...');
  const startResp = await fetch(cloudEndpoint('start_processing'), {
    method: 'POST',
    headers: cloudHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(startProcessingPayload(jobId, totalUploadBytes, processing)),
  });
  if (!startResp.ok) throw new Error(`Failed to start processing: ${startResp.status}`);
  const started = await startResp.json();
  if (started.status === 'error') throw new Error(started.error || 'Failed to start processing');
  if (started.status !== 'started') throw new Error('Cloud processing did not start');

  const maxWait = 20 * 60 * 1000;
  const start = Date.now();
  let lastProgressAt = 0;
  while (Date.now() - start < maxWait) {
    const elapsedMs = Date.now() - start;
    await new Promise(r => setTimeout(r, cloudPollDelay(elapsedMs)));
    if (Date.now() - lastProgressAt >= 1000) {
      onProgress('processing', `running... (${Math.round((Date.now() - start) / 1000)}s)`);
      lastProgressAt = Date.now();
    }
    let status;
    try {
      const statusResp = await fetch(cloudEndpoint('check_status'), {
        method: 'POST',
        headers: cloudHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ job_id: jobId }),
      });
      if (!statusResp.ok) continue;
      status = await statusResp.json();
    } catch (e) {
      if (e?.cloudTerminal) throw e;
      continue;
    }
    if (status.status === 'complete') {
      beginPerfTrace('cloud-complete-to-paint', { jobId });
      const fallbackSeriesEntry = status.series_entry ? null : await fetchProcessedSeries(jobId);
      const result = normalizeCloudUploadResult(status, {
        jobId,
        publicBase: _r2PublicBase,
        fallbackSeriesEntry,
      });
      const { slug } = result;
      onProgress('complete', slug);
      return result;
    }
    if (status.status === 'error') {
      throw terminalCloudError(status.error || 'Processing failed');
    }
  }
  throw new Error('Processing timed out after 20 minutes');
}

async function fetchProcessedSeries(jobId) {
  if (!_r2PublicBase) return null;
  // Invalidate cached series.json for this job before fetch.
  const url = `${_r2PublicBase}/results/${encodeURIComponent(jobId)}/series.json`;
  try { await cachedFetchResponse.invalidate(url); } catch { /* best-effort */ }
  const r = await cachedFetchResponse(url, { kind: 'json' });
  if (!r.ok) return null;
  return normalizeCloudSeriesEntry(await r.json(), { publicBase: _r2PublicBase });
}
