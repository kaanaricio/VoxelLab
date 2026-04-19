// DICOMweb WADO-RS → same per-instance / frame model as local Part 10
// ({ Modality, ImagePositionPatient, ... }) for classifyDICOMImport + geometry.

import { frameMetasForInstance } from '../dicom-frame-meta.js';
import { resolveDicomwebSession, dicomwebSessionStats, clearDicomwebSessions, assertDicomUid } from './session-transport.js';

const TAG = {
  Modality:                   '00080060',
  SeriesInstanceUID:          '0020000E',
  StudyInstanceUID:           '0020000D',
  SOPInstanceUID:             '00080018',
  InstanceNumber:             '00200013',
  NumberOfFrames:             '00280008',
  Rows:                       '00280010',
  Columns:                    '00280011',
  BitsAllocated:              '00280100',
  BitsStored:                 '00280101',
  PixelRepresentation:        '00280103',
  PhotometricInterpretation:  '00280004',
  RescaleSlope:               '00281053',
  RescaleIntercept:           '00281052',
  WindowCenter:               '00281050',
  WindowWidth:                '00281051',
  ImagePositionPatient:       '00200032',
  ImageOrientationPatient:    '00200037',
  PixelSpacing:               '00280030',
  SliceThickness:             '00180050',
  FrameOfReferenceUID:        '00200052',
  SeriesDescription:          '0008103E',
  SeriesNumber:               '00200011',
  TransferSyntaxUID:          '00083002',
  BodyPartExamined:           '00180015',
  ImageType:                  '00080008',
  PatientName:                '00100010',
  PatientID:                  '00100020',
  StudyDate:                  '00080020',
  StudyDescription:           '00081030',
  ModalitiesInStudy:          '00080061',
  NumberOfStudyRelatedSeries: '00201206',
  NumberOfStudyRelatedInstances: '00201208',
  NumberOfSeriesRelatedInstances: '00201209',
  SharedFunctionalGroupsSequence: '52009229',
  PerFrameFunctionalGroupsSequence: '52009230',
  PixelMeasuresSequence:      '00289110',
  PlaneOrientationSequence:   '00209116',
  PlanePositionSequence:      '00209113',
};

function tagValue(instance, tag) {
  const entry = instance?.[tag];
  if (!entry?.Value) return undefined;
  return entry.Value.length === 1 ? entry.Value[0] : entry.Value;
}

function tagString(instance, tag, fallback = '') {
  const v = tagValue(instance, tag);
  return typeof v === 'string' ? v : (v != null ? String(v) : fallback);
}

function tagNumber(instance, tag, fallback = 0) {
  const v = tagValue(instance, tag);
  return typeof v === 'number' ? v : (parseFloat(v) || fallback);
}

function tagNumberArray(instance, tag) {
  const entry = instance?.[tag];
  if (!entry?.Value || !Array.isArray(entry.Value)) return null;
  return entry.Value.map(Number).filter(Number.isFinite);
}

function tagStringArray(instance, tag) {
  const entry = instance?.[tag];
  if (!entry?.Value || !Array.isArray(entry.Value)) return [];
  return entry.Value.map(String);
}

function tagSequence(instance, tag) {
  const entry = instance?.[tag];
  return Array.isArray(entry?.Value) ? entry.Value : [];
}

function normalizeFunctionalGroupItem(item) {
  const normalized = {};
  const planePosition = tagSequence(item, TAG.PlanePositionSequence);
  const planeOrientation = tagSequence(item, TAG.PlaneOrientationSequence);
  const pixelMeasures = tagSequence(item, TAG.PixelMeasuresSequence);

  if (planePosition.length) {
    normalized.PlanePositionSequence = planePosition.map((seqItem) => ({
      ImagePositionPatient: tagNumberArray(seqItem, TAG.ImagePositionPatient),
    }));
  }
  if (planeOrientation.length) {
    normalized.PlaneOrientationSequence = planeOrientation.map((seqItem) => ({
      ImageOrientationPatient: tagNumberArray(seqItem, TAG.ImageOrientationPatient),
    }));
  }
  if (pixelMeasures.length) {
    normalized.PixelMeasuresSequence = pixelMeasures.map((seqItem) => ({
      PixelSpacing: tagNumberArray(seqItem, TAG.PixelSpacing),
      SliceThickness: tagNumber(seqItem, TAG.SliceThickness, 0),
    }));
  }
  return Object.keys(normalized).length ? normalized : null;
}

// Normalize a DICOM JSON instance object into the naturalized metadata shape
// expected by the shared geometry/classification pipeline.
export function normalizeInstance(instance) {
  const bitsAllocated = tagNumber(instance, TAG.BitsAllocated, 16);
  const normalized = {
    Modality:                  tagString(instance, TAG.Modality, 'OT'),
    SeriesInstanceUID:         tagString(instance, TAG.SeriesInstanceUID),
    StudyInstanceUID:          tagString(instance, TAG.StudyInstanceUID),
    SOPInstanceUID:            tagString(instance, TAG.SOPInstanceUID),
    InstanceNumber:            tagNumber(instance, TAG.InstanceNumber, 0),
    NumberOfFrames:            tagNumber(instance, TAG.NumberOfFrames, 1),
    Rows:                      tagNumber(instance, TAG.Rows, 0),
    Columns:                   tagNumber(instance, TAG.Columns, 0),
    BitsAllocated:             bitsAllocated,
    BitsStored:                tagNumber(instance, TAG.BitsStored, bitsAllocated),
    PixelRepresentation:       tagNumber(instance, TAG.PixelRepresentation, 0),
    PhotometricInterpretation: tagString(instance, TAG.PhotometricInterpretation, 'MONOCHROME2'),
    RescaleSlope:              tagNumber(instance, TAG.RescaleSlope, 1),
    RescaleIntercept:          tagNumber(instance, TAG.RescaleIntercept, 0),
    WindowCenter:              tagNumber(instance, TAG.WindowCenter, 0),
    WindowWidth:               tagNumber(instance, TAG.WindowWidth, 0),
    ImagePositionPatient:      tagNumberArray(instance, TAG.ImagePositionPatient),
    ImageOrientationPatient:   tagNumberArray(instance, TAG.ImageOrientationPatient),
    PixelSpacing:              tagNumberArray(instance, TAG.PixelSpacing),
    SliceThickness:            tagNumber(instance, TAG.SliceThickness, 0),
    FrameOfReferenceUID:       tagString(instance, TAG.FrameOfReferenceUID),
    SeriesDescription:         tagString(instance, TAG.SeriesDescription),
    SeriesNumber:              tagNumber(instance, TAG.SeriesNumber, 0),
    BodyPartExamined:          tagString(instance, TAG.BodyPartExamined),
    ImageType:                 tagStringArray(instance, TAG.ImageType),
  };

  const sharedGroups = tagSequence(instance, TAG.SharedFunctionalGroupsSequence)
    .map(normalizeFunctionalGroupItem)
    .filter(Boolean);
  const perFrameGroups = tagSequence(instance, TAG.PerFrameFunctionalGroupsSequence)
    .map(normalizeFunctionalGroupItem)
    .filter(Boolean);
  if (sharedGroups.length) normalized.SharedFunctionalGroupsSequence = sharedGroups;
  if (perFrameGroups.length) normalized.PerFrameFunctionalGroupsSequence = perFrameGroups;
  return normalized;
}

// Normalize an array of DICOM JSON instances into the same shape used by local imports.
export function normalizeInstances(instances = []) {
  return instances.map(normalizeInstance);
}

// Build a WADO-RS frame retrieval URL for a given instance.
export function frameUrl(wadoBase, studyUID, seriesUID, instanceUID, frame = 1) {
  return `${wadoBase}/studies/${assertDicomUid(studyUID, 'Study UID')}/series/${assertDicomUid(seriesUID, 'Series UID')}/instances/${assertDicomUid(instanceUID, 'Instance UID')}/frames/${frame}`;
}

// Build a WADO-RS metadata URL for a series.
export function seriesMetadataUrl(wadoBase, studyUID, seriesUID) {
  return `${wadoBase}/studies/${assertDicomUid(studyUID, 'Study UID')}/series/${assertDicomUid(seriesUID, 'Series UID')}/metadata`;
}

const _normalizedMetadataCache = new Map();

function normalizePersonName(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    for (const key of ['Alphabetic', 'Ideographic', 'Phonetic']) {
      if (typeof value[key] === 'string' && value[key]) return value[key];
    }
  }
  return String(value);
}

function qidoStudySummary(instance) {
  return {
    studyUID: tagString(instance, TAG.StudyInstanceUID),
    patientName: normalizePersonName(tagValue(instance, TAG.PatientName)),
    patientId: tagString(instance, TAG.PatientID),
    studyDate: tagString(instance, TAG.StudyDate),
    studyDescription: tagString(instance, TAG.StudyDescription),
    modalitiesInStudy: tagStringArray(instance, TAG.ModalitiesInStudy),
    seriesCount: tagNumber(instance, TAG.NumberOfStudyRelatedSeries, 0),
    instanceCount: tagNumber(instance, TAG.NumberOfStudyRelatedInstances, 0),
  };
}

function qidoSeriesSummary(instance) {
  return {
    studyUID: tagString(instance, TAG.StudyInstanceUID),
    seriesUID: tagString(instance, TAG.SeriesInstanceUID),
    seriesNumber: tagNumber(instance, TAG.SeriesNumber, 0),
    seriesDescription: tagString(instance, TAG.SeriesDescription),
    modality: tagString(instance, TAG.Modality, 'OT'),
    bodyPartExamined: tagString(instance, TAG.BodyPartExamined),
    instanceCount: tagNumber(instance, TAG.NumberOfSeriesRelatedInstances, 0),
  };
}

function normalizedMetadataKey(session, studyUID, seriesUID) {
  return `${String(session?.id || '')}::${String(studyUID || '')}::${String(seriesUID || '')}`;
}

function resolveSession(options = {}) {
  return resolveDicomwebSession({
    sessionId: options?.sessionId || '',
    wadoBase: options?.wadoBase,
    headers: options?.headers || {},
    fetchImpl: options?.fetchImpl,
    cacheScopeKey: options?.cacheScopeKey || '',
    retries: options?.retries,
    retryStatuses: options?.retryStatuses,
    retryDelay: options?.retryDelay,
  });
}

export function resolveDicomwebImportSession(options = {}) {
  return resolveSession(options);
}

async function mapConcurrent(items, limit, worker) {
  const out = new Array(items.length);
  let nextIndex = 0;
  const width = Math.max(1, Math.min(limit || items.length || 1, items.length || 1));
  const runners = Array.from({ length: width }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

export function getDicomwebSessionStats(sessionId) {
  return dicomwebSessionStats(sessionId);
}

export { clearDicomwebSessions };

export async function discoverQidoStudies(options = {}) {
  const session = resolveSession(options);
  const rows = await session.discoverStudies({
    query: options?.query || {},
    headers: options?.headers || {},
    fetchImpl: options?.fetchImpl,
    signal: options?.signal,
    retries: options?.retries,
    retryStatuses: options?.retryStatuses,
    retryDelay: options?.retryDelay,
    useCache: options?.useCache !== false,
  });
  return rows.map(qidoStudySummary);
}

export async function discoverQidoSeries(options = {}) {
  const session = resolveSession(options);
  const rows = await session.discoverSeries({
    studyUID: options?.studyUID || '',
    query: options?.query || {},
    headers: options?.headers || {},
    fetchImpl: options?.fetchImpl,
    signal: options?.signal,
    retries: options?.retries,
    retryStatuses: options?.retryStatuses,
    retryDelay: options?.retryDelay,
    useCache: options?.useCache !== false,
  });
  return rows.map(qidoSeriesSummary);
}

export async function fetchSeriesMetadataJson({
  wadoBase,
  studyUID,
  seriesUID,
  headers = {},
  fetchImpl,
  signal,
  retries = 1,
  retryStatuses,
  retryDelay,
  sessionId = '',
  cacheScopeKey = '',
  useCache = true,
}) {
  const session = resolveDicomwebSession({
    sessionId,
    wadoBase,
    headers,
    fetchImpl,
    cacheScopeKey,
    retries,
    retryStatuses,
    retryDelay,
  });
  return await session.fetchSeriesMetadataJson({
    studyUID,
    seriesUID,
    headers,
    fetchImpl,
    signal,
    retries,
    retryStatuses,
    retryDelay,
    useCache,
  });
}

export async function fetchSeriesMetadata(options) {
  const session = resolveSession(options);
  const cacheKey = normalizedMetadataKey(session, options?.studyUID, options?.seriesUID);
  if (options?.useCache !== false && _normalizedMetadataCache.has(cacheKey)) {
    return _normalizedMetadataCache.get(cacheKey);
  }
  const payload = await fetchSeriesMetadataJson({
    ...options,
    sessionId: session.id,
  });
  const normalized = normalizeInstances(payload);
  if (options?.useCache !== false) _normalizedMetadataCache.set(cacheKey, normalized);
  return normalized;
}

export async function fetchFrameBytes({
  wadoBase,
  studyUID,
  seriesUID,
  instanceUID,
  frame = 1,
  headers = {},
  fetchImpl,
  accept = 'application/octet-stream',
  signal,
  retries = 1,
  retryStatuses,
  retryDelay,
  sessionId = '',
  cacheScopeKey = '',
  useCache = true,
}) {
  const session = resolveDicomwebSession({
    sessionId,
    wadoBase,
    fetchImpl,
    headers,
    cacheScopeKey,
    retries,
    retryStatuses,
    retryDelay,
  });
  return await session.fetchFrameBytes({
    studyUID,
    seriesUID,
    instanceUID,
    frame,
    headers,
    fetchImpl,
    accept,
    signal,
    retries,
    retryStatuses,
    retryDelay,
    useCache,
  });
}

export async function fetchSeriesItems({
  wadoBase,
  studyUID,
  seriesUID,
  headers = {},
  fetchImpl,
  metadata,
  frameConcurrency = 8,
  signal,
  retries = 1,
  retryStatuses,
  retryDelay,
  sessionId = '',
  cacheScopeKey = '',
  useCache = true,
}) {
  const session = resolveDicomwebSession({
    sessionId,
    wadoBase,
    headers,
    fetchImpl,
    cacheScopeKey,
    retries,
    retryStatuses,
    retryDelay,
  });
  const metas = Array.isArray(metadata) ? metadata : await fetchSeriesMetadata({
    wadoBase,
    studyUID,
    seriesUID,
    headers,
    fetchImpl,
    signal,
    retries,
    retryStatuses,
    retryDelay,
    sessionId: session.id,
    cacheScopeKey,
    useCache,
  });
  const requests = [];
  for (const meta of metas) {
    const frameMetas = frameMetasForInstance(meta);
    for (const frameMeta of frameMetas) {
      requests.push({
        meta: frameMeta,
        instanceUID: String(meta.SOPInstanceUID || ''),
        frame: Number(frameMeta.FrameIndex || 1),
      });
    }
  }
  const buffers = await mapConcurrent(requests, frameConcurrency, (request) => fetchFrameBytes({
    wadoBase,
    studyUID,
    seriesUID,
    instanceUID: request.instanceUID,
    frame: request.frame,
    headers,
    fetchImpl,
    signal,
    retries,
    retryStatuses,
    retryDelay,
    sessionId: session.id,
    cacheScopeKey,
    useCache,
  }));
  return requests.map((request, index) => ({
    meta: request.meta,
    pixelData: { Value: [buffers[index]] },
  }));
}
