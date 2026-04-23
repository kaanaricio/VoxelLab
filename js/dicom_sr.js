// DICOM Structured Report (TID 1500) export — loader + download; see dicom-sr-*.js.

import { collectMeasurements } from './dicom-sr-collect.js';
import { buildSRDataset } from './dicom-sr-dataset.js';
import { DCMJS_SCRIPT_URL } from './dependencies.js';

let _dcmjs = null;
let _loading = null;

async function loadDcmjs() {
  if (_dcmjs) return _dcmjs;
  if (_loading) return _loading;
  _loading = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${DCMJS_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener('load', () => { _dcmjs = window.dcmjs; resolve(_dcmjs); });
      existing.addEventListener('error', reject);
      return;
    }
    const s = document.createElement('script');
    s.src = DCMJS_SCRIPT_URL;
    s.onload = () => { _dcmjs = window.dcmjs; resolve(_dcmjs); };
    s.onerror = () => reject(new Error('Failed to load dcmjs from CDN'));
    document.head.appendChild(s);
  });
  return _loading;
}

export async function exportDicomSR(host) {
  const bundle = collectMeasurements(host);
  if (!bundle.measurements.length) {
    throw new Error('Nothing to export — make a measurement, ROI, or annotation first.');
  }

  const dcmjs = await loadDcmjs();
  const dataset = buildSRDataset(bundle);

  const DicomMetaDictionary = dcmjs.data.DicomMetaDictionary;
  const naturalToRaw = DicomMetaDictionary.denaturalizeDataset(dataset);
  const meta         = DicomMetaDictionary.denaturalizeDataset(dataset._meta);
  const dict = new dcmjs.data.DicomDict(meta);
  dict.dict = naturalToRaw;
  const buffer = dict.write();

  const blob = new Blob([buffer], { type: 'application/dicom' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const studyDate = host.manifest.studyDate || 'unknown';
  a.download = `${bundle.slug}_measurements_${studyDate.replace(/-/g, '')}.dcm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  return { count: bundle.measurements.length, filename: a.download };
}

export function hasExportableMeasurements(host) {
  const bundle = collectMeasurements(host);
  return bundle.measurements.length;
}
