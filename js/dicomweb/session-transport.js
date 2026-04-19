const SESSION_BY_ID = new Map();
const SESSION_ID_BY_SCOPE = new Map();
let SESSION_COUNTER = 0;

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_CACHE_LIMITS = {
  metadata: 24,
  frames: 256,
  qidoStudies: 12,
  qidoSeries: 48,
};
const MAX_SESSIONS = 12;
const MAX_RETRY_AFTER_MS = 30_000;
const SAFE_DICOM_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function trimTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeHeaderMap(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) out[key] = value;
  return out;
}

function stableHash(value = '') {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function authScopeKey(headers = {}) {
  const raw = String(headers.Authorization || headers.authorization || '');
  return raw ? `auth:${stableHash(raw)}` : '';
}

function scopeKeyFor({ wadoBase, headers = {}, cacheScopeKey = '' }) {
  return JSON.stringify([
    trimTrailingSlashes(wadoBase),
    cacheScopeKey || authScopeKey(headers),
  ]);
}

function nextSessionId() {
  SESSION_COUNTER += 1;
  return `dw_${Date.now().toString(36)}_${SESSION_COUNTER.toString(36)}`;
}

function buildHeaders(baseHeaders = {}, requestHeaders = {}, accept = '') {
  const merged = { ...normalizeHeaderMap(baseHeaders), ...normalizeHeaderMap(requestHeaders) };
  if (accept) {
    const hasAccept = Object.keys(merged).some((key) => key.toLowerCase() === 'accept');
    if (!hasAccept) merged.Accept = accept;
  }
  return merged;
}

function fetchOrThrow(fetchImpl) {
  const fn = fetchImpl || globalThis.fetch;
  if (typeof fn !== 'function') throw new Error('DICOMweb fetch requires a fetch implementation');
  return fn;
}

export function assertDicomUid(value, label = 'DICOM UID') {
  const uid = String(value || '').trim();
  if (
    !SAFE_DICOM_PATH_SEGMENT_RE.test(uid)
    || uid === '.'
    || uid === '..'
  ) throw new Error(`Invalid ${label}: ${value}`);
  return uid;
}

function retryDelayMs(response, fallbackMs) {
  const retryAfter = response?.headers?.get?.('Retry-After');
  const seconds = Number(retryAfter || 0);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    : fallbackMs;
}

function sortedQueryKey(query = {}) {
  return Object.keys(query)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`)
    .join('&');
}

function appendQuery(baseUrl, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null || item === '') continue;
        params.append(key, String(item));
      }
      continue;
    }
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${baseUrl}?${qs}` : baseUrl;
}

function metadataKey(studyUID, seriesUID) {
  return `${String(studyUID || '')}::${String(seriesUID || '')}`;
}

function frameKey(studyUID, seriesUID, instanceUID, frame, accept) {
  return [
    String(studyUID || ''),
    String(seriesUID || ''),
    String(instanceUID || ''),
    String(frame || 1),
    String(accept || ''),
  ].join('::');
}

function rememberBounded(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest == null) break;
    map.delete(oldest);
  }
}

function rememberSession(scopeKey, session) {
  if (SESSION_ID_BY_SCOPE.has(scopeKey)) SESSION_ID_BY_SCOPE.delete(scopeKey);
  SESSION_BY_ID.set(session.id, session);
  SESSION_ID_BY_SCOPE.set(scopeKey, session.id);
  while (SESSION_ID_BY_SCOPE.size > MAX_SESSIONS) {
    const oldestScope = SESSION_ID_BY_SCOPE.keys().next().value;
    if (oldestScope == null) break;
    const oldestId = SESSION_ID_BY_SCOPE.get(oldestScope);
    SESSION_ID_BY_SCOPE.delete(oldestScope);
    if (oldestId) SESSION_BY_ID.delete(oldestId);
  }
}

function qidoStudiesPath(base) {
  return `${trimTrailingSlashes(base)}/studies`;
}

function qidoSeriesPath(base, studyUID = '') {
  if (String(studyUID || '').trim()) {
    return `${trimTrailingSlashes(base)}/studies/${assertDicomUid(studyUID, 'Study UID')}/series`;
  }
  return `${trimTrailingSlashes(base)}/series`;
}

function seriesMetadataPath(base, studyUID, seriesUID) {
  return `${trimTrailingSlashes(base)}/studies/${assertDicomUid(studyUID, 'Study UID')}/series/${assertDicomUid(seriesUID, 'Series UID')}/metadata`;
}

function framePath(base, studyUID, seriesUID, instanceUID, frame = 1) {
  return `${trimTrailingSlashes(base)}/studies/${assertDicomUid(studyUID, 'Study UID')}/series/${assertDicomUid(seriesUID, 'Series UID')}/instances/${assertDicomUid(instanceUID, 'Instance UID')}/frames/${frame}`;
}

function indexOfBytes(haystack, needle, start = 0) {
  outer: for (let index = Math.max(0, start); index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function multipartBoundary(contentType = '') {
  const match = String(contentType || '').match(/boundary="?([^";]+)"?/i);
  return match ? match[1] : '';
}

function trimMultipartBody(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x0d || bytes[end - 1] === 0x0a)) end -= 1;
  return bytes.slice(0, end);
}

function extractMultipartPart(buffer, contentType = '') {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new Error(`DICOMweb multipart frame fetch is missing a boundary: ${contentType}`);
  const bytes = new Uint8Array(buffer);
  const boundaryBytes = new TextEncoder().encode(`--${boundary}`);
  const firstBoundary = indexOfBytes(bytes, boundaryBytes);
  if (firstBoundary < 0) throw new Error('DICOMweb multipart frame fetch is missing its first boundary marker');
  const lineEnd = indexOfBytes(bytes, new Uint8Array([0x0d, 0x0a]), firstBoundary);
  if (lineEnd < 0) throw new Error('DICOMweb multipart frame fetch is missing a boundary line ending');
  const headerStart = lineEnd + 2;
  let bodyStart = indexOfBytes(bytes, new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]), headerStart);
  if (bodyStart >= 0) bodyStart += 4;
  else {
    bodyStart = indexOfBytes(bytes, new Uint8Array([0x0a, 0x0a]), headerStart);
    if (bodyStart >= 0) bodyStart += 2;
  }
  if (bodyStart < 0) throw new Error('DICOMweb multipart frame fetch is missing part headers');
  let nextBoundary = indexOfBytes(bytes, new TextEncoder().encode(`\r\n--${boundary}`), bodyStart);
  if (nextBoundary < 0) nextBoundary = indexOfBytes(bytes, new TextEncoder().encode(`\n--${boundary}`), bodyStart);
  if (nextBoundary < 0) throw new Error('DICOMweb multipart frame fetch is missing a closing boundary');
  const partBytes = trimMultipartBody(bytes.slice(bodyStart, nextBoundary));
  return partBytes.buffer.slice(partBytes.byteOffset, partBytes.byteOffset + partBytes.byteLength);
}

class DicomwebTransportSession {
  constructor({
    id,
    wadoBase,
    headers = {},
    fetchImpl,
    cacheScopeKey = '',
    retries = 1,
    retryStatuses = RETRYABLE_STATUSES,
    retryDelay = 200,
  }) {
    if (!String(wadoBase || '').trim()) throw new Error('DICOMweb session requires WADO-RS/QIDO-RS base URL');
    this.id = id || nextSessionId();
    this.wadoBase = trimTrailingSlashes(wadoBase);
    this.baseHeaders = normalizeHeaderMap(headers);
    this.fetchImpl = fetchImpl;
    this.cacheScopeKey = cacheScopeKey;
    this.retries = Number.isFinite(retries) ? retries : 1;
    this.retryStatuses = retryStatuses || RETRYABLE_STATUSES;
    this.retryDelay = Number.isFinite(retryDelay) ? retryDelay : 200;
    this.cacheLimits = { ...DEFAULT_CACHE_LIMITS };
    this.scopeKey = scopeKeyFor({
      wadoBase: this.wadoBase,
      headers: this.baseHeaders,
      cacheScopeKey: this.cacheScopeKey,
    });

    this.metadataJsonCache = new Map();
    this.frameCache = new Map();
    this.qidoStudyCache = new Map();
    this.qidoSeriesCache = new Map();

    this.inflightMetadata = new Map();
    this.inflightFrame = new Map();
    this.inflightQidoStudy = new Map();
    this.inflightQidoSeries = new Map();
  }

  withOverrides({ headers = {}, fetchImpl, retries, retryStatuses, retryDelay } = {}) {
    return {
      headers: buildHeaders(this.baseHeaders, headers),
      fetchImpl: fetchImpl || this.fetchImpl,
      retries: Number.isFinite(retries) ? retries : this.retries,
      retryStatuses: retryStatuses || this.retryStatuses,
      retryDelay: Number.isFinite(retryDelay) ? retryDelay : this.retryDelay,
    };
  }

  async fetchWithPolicy(url, {
    headers = {},
    fetchImpl,
    signal,
    retries = this.retries,
    retryStatuses = this.retryStatuses,
    retryDelay = this.retryDelay,
  } = {}) {
    const fetchFn = fetchOrThrow(fetchImpl || this.fetchImpl);
    let attempt = 0;
    while (true) {
      const response = await fetchFn(url, { headers, signal });
      if (response?.ok) return response;
      const status = Number(response?.status || 0);
      if (attempt >= retries || !retryStatuses.has(status)) return response;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, retryDelay)));
    }
  }

  async fetchJsonArray(url, {
    headers = {},
    fetchImpl,
    signal,
    retries,
    retryStatuses,
    retryDelay,
  } = {}) {
    const response = await this.fetchWithPolicy(url, {
      headers,
      fetchImpl,
      signal,
      retries,
      retryStatuses,
      retryDelay,
    });
    if (!response?.ok) throw new Error(`DICOMweb request failed (${response?.status || 'unknown'}): ${url}`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error('DICOMweb response must be an array');
    return payload;
  }

  async discoverStudies({
    query = {},
    headers = {},
    fetchImpl,
    signal,
    retries,
    retryStatuses,
    retryDelay,
    useCache = true,
  } = {}) {
    const queryWithPaging = { limit: 25, ...query };
    const key = sortedQueryKey(queryWithPaging);
    if (useCache && this.qidoStudyCache.has(key)) return this.qidoStudyCache.get(key);
    if (useCache && this.inflightQidoStudy.has(key)) return this.inflightQidoStudy.get(key);
    const options = this.withOverrides({ headers, fetchImpl, retries, retryStatuses, retryDelay });
    const pending = this.fetchJsonArray(appendQuery(qidoStudiesPath(this.wadoBase), queryWithPaging), {
      ...options,
      headers: buildHeaders(options.headers, {}, 'application/dicom+json'),
      signal,
    });
    if (useCache) this.inflightQidoStudy.set(key, pending);
    try {
      const payload = await pending;
      if (useCache) rememberBounded(this.qidoStudyCache, key, payload, this.cacheLimits.qidoStudies);
      return payload;
    } finally {
      this.inflightQidoStudy.delete(key);
    }
  }

  async discoverSeries({
    studyUID = '',
    query = {},
    headers = {},
    fetchImpl,
    signal,
    retries,
    retryStatuses,
    retryDelay,
    useCache = true,
  } = {}) {
    const queryWithPaging = { limit: 200, ...query };
    const key = `${String(studyUID || '')}::${sortedQueryKey(queryWithPaging)}`;
    if (useCache && this.qidoSeriesCache.has(key)) return this.qidoSeriesCache.get(key);
    if (useCache && this.inflightQidoSeries.has(key)) return this.inflightQidoSeries.get(key);
    const options = this.withOverrides({ headers, fetchImpl, retries, retryStatuses, retryDelay });
    const pending = this.fetchJsonArray(appendQuery(qidoSeriesPath(this.wadoBase, studyUID), queryWithPaging), {
      ...options,
      headers: buildHeaders(options.headers, {}, 'application/dicom+json'),
      signal,
    });
    if (useCache) this.inflightQidoSeries.set(key, pending);
    try {
      const payload = await pending;
      if (useCache) rememberBounded(this.qidoSeriesCache, key, payload, this.cacheLimits.qidoSeries);
      return payload;
    } finally {
      this.inflightQidoSeries.delete(key);
    }
  }

  async fetchSeriesMetadataJson({
    studyUID,
    seriesUID,
    headers = {},
    fetchImpl,
    signal,
    retries,
    retryStatuses,
    retryDelay,
    useCache = true,
  }) {
    const key = metadataKey(studyUID, seriesUID);
    if (useCache && this.metadataJsonCache.has(key)) return this.metadataJsonCache.get(key);
    if (useCache && this.inflightMetadata.has(key)) return this.inflightMetadata.get(key);
    const options = this.withOverrides({ headers, fetchImpl, retries, retryStatuses, retryDelay });
    const pending = this.fetchJsonArray(seriesMetadataPath(this.wadoBase, studyUID, seriesUID), {
      ...options,
      headers: buildHeaders(options.headers, {}, 'application/dicom+json'),
      signal,
    });
    if (useCache) this.inflightMetadata.set(key, pending);
    try {
      const payload = await pending;
      if (useCache) rememberBounded(this.metadataJsonCache, key, payload, this.cacheLimits.metadata);
      return payload;
    } finally {
      this.inflightMetadata.delete(key);
    }
  }

  async fetchFrameBytes({
    studyUID,
    seriesUID,
    instanceUID,
    frame = 1,
    headers = {},
    fetchImpl,
    accept = 'application/octet-stream',
    signal,
    retries,
    retryStatuses,
    retryDelay,
    useCache = true,
  }) {
    const key = frameKey(studyUID, seriesUID, instanceUID, frame, accept);
    if (useCache && this.frameCache.has(key)) return this.frameCache.get(key);
    if (useCache && this.inflightFrame.has(key)) return this.inflightFrame.get(key);
    const options = this.withOverrides({ headers, fetchImpl, retries, retryStatuses, retryDelay });
    const pending = (async () => {
      const response = await this.fetchWithPolicy(
        framePath(this.wadoBase, studyUID, seriesUID, instanceUID, frame),
        {
          headers: buildHeaders(options.headers, {}, accept),
          fetchImpl: options.fetchImpl,
          signal,
          retries: options.retries,
          retryStatuses: options.retryStatuses,
          retryDelay: options.retryDelay,
        },
      );
      if (!response?.ok) {
        throw new Error(`DICOMweb frame fetch failed (${instanceUID} frame ${frame}): ${response?.status || 'unknown'}`);
      }
      const contentType = String(response?.headers?.get?.('Content-Type') || '');
      const normalizedContentType = contentType.toLowerCase();
      if (
        normalizedContentType &&
        (normalizedContentType.includes('text/html') || normalizedContentType.includes('application/json'))
      ) {
        throw new Error(`DICOMweb frame fetch returned unsupported content type: ${normalizedContentType}`);
      }
      const buffer = await response.arrayBuffer();
      return normalizedContentType.includes('multipart/related')
        ? extractMultipartPart(buffer, contentType)
        : buffer;
    })();
    if (useCache) this.inflightFrame.set(key, pending);
    try {
      const payload = await pending;
      if (useCache) rememberBounded(this.frameCache, key, payload, this.cacheLimits.frames);
      return payload;
    } finally {
      this.inflightFrame.delete(key);
    }
  }
}

export function resolveDicomwebSession({
  sessionId = '',
  wadoBase,
  headers = {},
  fetchImpl,
  cacheScopeKey = '',
  retries = 1,
  retryStatuses,
  retryDelay = 200,
}) {
  const scopeKey = scopeKeyFor({ wadoBase, headers, cacheScopeKey });
  if (sessionId && SESSION_BY_ID.has(sessionId)) {
    const existing = SESSION_BY_ID.get(sessionId);
    if (existing.scopeKey !== scopeKey) {
      throw new Error(`DICOMweb session ${sessionId} scope mismatch`);
    }
    if (fetchImpl) existing.fetchImpl = fetchImpl;
    rememberSession(existing.scopeKey, existing);
    return existing;
  }
  if (!sessionId && SESSION_ID_BY_SCOPE.has(scopeKey)) {
    const existingId = SESSION_ID_BY_SCOPE.get(scopeKey);
    const existing = SESSION_BY_ID.get(existingId);
    if (existing) {
      if (fetchImpl) existing.fetchImpl = fetchImpl;
      rememberSession(existing.scopeKey, existing);
      return existing;
    }
    SESSION_ID_BY_SCOPE.delete(scopeKey);
  }
  const created = new DicomwebTransportSession({
    id: sessionId || nextSessionId(),
    wadoBase,
    headers,
    fetchImpl,
    cacheScopeKey,
    retries,
    retryStatuses,
    retryDelay,
  });
  rememberSession(created.scopeKey, created);
  return created;
}

export function getDicomwebSession(sessionId) {
  return SESSION_BY_ID.get(String(sessionId || '')) || null;
}

export function clearDicomwebSessions() {
  SESSION_BY_ID.clear();
  SESSION_ID_BY_SCOPE.clear();
}

export function dicomwebSessionStats(sessionId) {
  const session = getDicomwebSession(sessionId);
  if (!session) return null;
  return {
    sessionId: session.id,
    metadata: session.metadataJsonCache.size,
    frames: session.frameCache.size,
    qidoStudies: session.qidoStudyCache.size,
    qidoSeries: session.qidoSeriesCache.size,
  };
}
