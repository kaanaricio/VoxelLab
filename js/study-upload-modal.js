// "Open a study" modal: local DICOM/NIfTI parse or cloud pipeline.
import { state } from './state.js';
import { $, escapeHtml, openModal, closeModal } from './dom.js';
import { ensureTemplate } from './template-loader.js';
import {
  parseDICOMFileGroups,
  parseNIfTI,
  injectLocalSeries,
  injectManifestSeries,
  importDicomwebSeries,
  fetchSeriesMetadata,
  discoverQidoStudies,
  discoverQidoSeries,
  resolveDicomwebImportSession,
} from './dicom-import.js';
import { registerProjectionSet } from './series-contract.js';
import {
  importDicomwebDerivedObject,
  importLocalDerivedObjects,
  isDerivedObjectModality,
} from './dicom-derived-import.js';
import { isCloudAvailable, uploadAndProcess } from './cloud.js';
import { notify } from './notify.js';
import { enableRegionsIfAvailable } from './state/viewer-commands.js';

function setUploadStatus(statusEl, message, tone = 'muted', { html = false } = {}) {
  statusEl.className = `upload-status${tone === 'muted' ? '' : ` is-${tone}`}`;
  if (html) statusEl.innerHTML = message;
  else statusEl.textContent = message;
}

export async function showStudyUploadModal(selectSeries) {
  await ensureTemplate('./templates/upload-modal.html', 'modal-root', 'upload-modal');
  const modal = $('upload-modal');
  const body = $('upload-body');
  openModal('upload-modal');

  const cloudAvail = isCloudAvailable();
  body.innerHTML = `
    <div class="ask-a">
      <label class="upload-zone" id="upload-zone">
        <input type="file" id="upload-file-input" multiple
          accept=".dcm,application/dicom" class="upload-file-input" />
        <svg class="upload-zone-icon"><use href="icons.svg#i-upload"/></svg>
        <span class="upload-zone-title">Drop DICOM files here</span>
        <span class="upload-zone-subtitle">or click to browse</span>
      </label>
      <div id="upload-status" class="upload-status"></div>
      <div class="upload-section">
        <div class="upload-section-title">Open from DICOMweb (WADO-RS)</div>
        <div class="upload-grid">
          <input id="dicomweb-base" class="select-like upload-field" placeholder="WADO-RS base URL" />
          <input id="dicomweb-query" class="select-like upload-field" placeholder="QIDO query (optional, e.g. DOE*)" />
          <input id="dicomweb-study" class="select-like upload-field" placeholder="Study UID" />
          <input id="dicomweb-series" class="select-like upload-field" placeholder="Series UID" />
          <input id="dicomweb-token" class="select-like upload-field" placeholder="Bearer token (optional)" />
          <div class="upload-actions">
            <button class="btn upload-action" id="dicomweb-find-studies-btn">Find studies</button>
            <button class="btn upload-action" id="dicomweb-find-series-btn">Find series</button>
          </div>
          <button class="btn" id="upload-dicomweb-btn">Import DICOMweb series</button>
          <div class="upload-copy">
            Uses the same geometry and capability checks as local import. SEG, RTSTRUCT, and lightweight SR series bind to an already loaded source series in this session. DICOMweb session cache is in-memory and reused while this modal stays open.
          </div>
        </div>
      </div>
      ${cloudAvail ? `
        <div class="upload-actions upload-copy-spaced">
          <button class="btn upload-action" id="upload-local-btn">View locally</button>
          <button class="btn upload-action" id="upload-cloud-btn">Process CT/MR on cloud GPU</button>
        </div>
        <div class="upload-copy upload-copy-tight">
          <b>View locally</b>: instant preview in your browser, no upload needed.<br>
          <b>Cloud GPU</b>: uploads supported CT/MR volume stacks to R2, then runs segmentation + parcellation.<br>
          Projection sets stay 2D until a calibrated reconstruction engine emits a derived volume.
        </div>
      ` : `
        <div class="upload-copy upload-copy-spaced">
          Files are parsed entirely in your browser. Nothing is uploaded.
          Projection sets stay 2D until a calibrated reconstruction engine emits a derived volume.
        </div>
      `}
    </div>
  `;

  const zone = $('upload-zone');
  const input = $('upload-file-input');
  const statusEl = $('upload-status');
  const dicomwebState = { sessionId: '', studies: [], series: [] };
  let selectedFiles = null;
  let busy = false;

  const setBusy = (nextBusy) => {
    busy = nextBusy;
    zone.style.pointerEvents = nextBusy ? 'none' : '';
    if (input) input.disabled = nextBusy;
    if (localBtn) localBtn.disabled = nextBusy;
    if (cloudBtn) cloudBtn.disabled = nextBusy;
    if (dicomwebBtn) dicomwebBtn.disabled = nextBusy;
    if (findStudiesBtn) findStudiesBtn.disabled = nextBusy;
    if (findSeriesBtn) findSeriesBtn.disabled = nextBusy;
  };

  zone.addEventListener('click', (e) => {
    if (busy) return;
    if (e.target === input) return;
    input.click();
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    if (busy) return;
    e.preventDefault();
    zone.classList.remove('drag');
    selectedFiles = e.dataTransfer.files;
    setUploadStatus(statusEl, `${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} selected`, 'active');
    if (!cloudAvail) handleLocalImport(selectedFiles, statusEl, modal, selectSeries, setBusy);
  });
  input.addEventListener('change', () => {
    if (busy) return;
    selectedFiles = input.files;
    setUploadStatus(statusEl, `${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} selected`, 'active');
    if (!cloudAvail) handleLocalImport(selectedFiles, statusEl, modal, selectSeries, setBusy);
  });

  const localBtn = $('upload-local-btn');
  const cloudBtn = $('upload-cloud-btn');
  const dicomwebBtn = $('upload-dicomweb-btn');
  const findStudiesBtn = $('dicomweb-find-studies-btn');
  const findSeriesBtn = $('dicomweb-find-series-btn');
  if (localBtn) {
    localBtn.onclick = () => {
      if (!selectedFiles || !selectedFiles.length) {
        setUploadStatus(statusEl, 'Select files first');
        return;
      }
      handleLocalImport(selectedFiles, statusEl, modal, selectSeries, setBusy);
    };
  }
  if (cloudBtn) {
    cloudBtn.onclick = () => {
      if (busy) return;
      if (!selectedFiles || !selectedFiles.length) {
        setUploadStatus(statusEl, 'Select files first');
        return;
      }
      handleCloudUpload(selectedFiles, statusEl, modal, selectSeries, setBusy);
    };
  }
  if (dicomwebBtn) {
    dicomwebBtn.onclick = () => handleDicomwebImport(statusEl, modal, selectSeries, setBusy, dicomwebState);
  }
  if (findStudiesBtn) {
    findStudiesBtn.onclick = () => handleDicomwebStudyDiscovery(statusEl, setBusy, dicomwebState);
  }
  if (findSeriesBtn) {
    findSeriesBtn.onclick = () => handleDicomwebSeriesDiscovery(statusEl, setBusy, dicomwebState);
  }
}

async function handleLocalImport(files, statusEl, modal, selectSeries, setBusy = () => {}) {
  setBusy(true);
  try {
    const first = files[0];
    const isNifti = first.name.endsWith('.nii') || first.name.endsWith('.nii.gz');

    let results;
    if (isNifti) {
      setUploadStatus(statusEl, 'Parsing NIfTI...', 'active');
      const result = await parseNIfTI(first, (stage, detail) => {
        setUploadStatus(statusEl, `${stage}: ${detail}`, 'active');
      });
      results = result ? [result] : null;
    } else {
      setUploadStatus(statusEl, 'Parsing DICOM...', 'active');
      results = await parseDICOMFileGroups(Array.from(files), (stage, detail) => {
        setUploadStatus(statusEl, `${stage}: ${detail}`, 'active');
      });
    }

    const imageResults = results || [];
    setUploadStatus(statusEl, imageResults.length ? 'Loading into viewer...' : 'Applying derived objects...', 'active');
    const projectionSetCount = imageResults.filter(result => result.entry?.isProjectionSet).length;
    const indexes = imageResults.map(result =>
      injectLocalSeries(state.manifest, result.entry, result.sliceCanvases, result.rawVolume)
    );
    const derived = isNifti ? [] : await importLocalDerivedObjects(Array.from(files), state.manifest, (stage, detail) => {
      setUploadStatus(statusEl, `${stage}: ${detail}`, 'active');
    });
    const affectedSlug = derived.find((item) => item.sourceSlug)?.sourceSlug || null;
    const affectedIndex = affectedSlug
      ? state.manifest.series.findIndex((series) => series.slug === affectedSlug)
      : -1;

    if (!indexes.length && affectedIndex < 0) {
      setUploadStatus(statusEl, 'Could not parse files. Check format.', 'error');
      return;
    }

    closeModal('upload-modal');
    const selectedIndex = indexes[0] ?? affectedIndex;
    if (selectedIndex >= 0) {
      const selectedSeries = state.manifest.series[selectedIndex];
      enableRegionsIfAvailable(selectedSeries);
      await selectSeries(selectedIndex);
    }
    if (projectionSetCount > 0) {
      notify(`${projectionSetCount} projection set${projectionSetCount > 1 ? 's' : ''} registered for calibrated reconstruction; source images stay 2D until a derived volume exists.`);
    }
    const imported = derived.filter((item) => !item.skipped);
    if (imported.length) {
      const byKind = imported.reduce((acc, item) => {
        acc[item.kind] = (acc[item.kind] || 0) + 1;
        return acc;
      }, {});
      const parts = [];
      if (byKind.seg) parts.push(`${byKind.seg} SEG overlay${byKind.seg > 1 ? 's' : ''}`);
      if (byKind.rtstruct) parts.push(`${byKind.rtstruct} RTSTRUCT import${byKind.rtstruct > 1 ? 's' : ''}`);
      if (byKind.sr) parts.push(`${byKind.sr} SR note set${byKind.sr > 1 ? 's' : ''}`);
      notify(`Imported ${parts.join(', ')} onto the referenced source series.`);
    }
  } catch (e) {
    setUploadStatus(statusEl, `Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    setBusy(false);
  }
}

async function handleCloudUpload(files, statusEl, modal, selectSeries, setBusy = () => {}) {
  setBusy(true);
  try {
    setUploadStatus(statusEl, 'Preparing upload...', 'active');
    const result = await uploadAndProcess(files, (stage, detail) => {
      setUploadStatus(statusEl, `${stage}: ${detail}`, 'active');
    });
    if (result.seriesEntry) {
      if (result.projectionSetEntry) {
        registerProjectionSet(state.manifest, {
          ...result.projectionSetEntry,
          slug: result.projectionSetEntry.slug || result.projectionSetEntry.id,
          isProjectionSet: true,
        });
      }
      const idx = injectManifestSeries(state.manifest, result.seriesEntry);
      closeModal('upload-modal');
      await selectSeries(idx);
      return;
    }
    setUploadStatus(statusEl, `Complete! Series <b>${escapeHtml(result.slug)}</b> is ready on R2.`, 'success', { html: true });
  } catch (e) {
    setUploadStatus(statusEl, `Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    setBusy(false);
  }
}

function dicomwebRequestHeaders(bearerToken = '') {
  return bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};
}

function ensureDicomwebSession(dicomwebState, { wadoBase, headers }) {
  const session = resolveDicomwebImportSession({
    sessionId: dicomwebState?.sessionId || '',
    wadoBase,
    headers,
  });
  if (dicomwebState) dicomwebState.sessionId = session.id;
  return session;
}

async function handleDicomwebStudyDiscovery(statusEl, setBusy = () => {}, dicomwebState = null) {
  const wadoBase = $('dicomweb-base')?.value.trim() || '';
  const bearerToken = $('dicomweb-token')?.value || '';
  const qidoQuery = $('dicomweb-query')?.value.trim() || '';
  if (!wadoBase) {
    setUploadStatus(statusEl, 'Enter WADO-RS base URL', 'error');
    return;
  }

  setBusy(true);
  try {
    setUploadStatus(statusEl, 'dicomweb: discovering studies', 'active');
    const headers = dicomwebRequestHeaders(bearerToken);
    const session = ensureDicomwebSession(dicomwebState, { wadoBase, headers });
    const studies = await discoverQidoStudies({
      wadoBase,
      headers,
      sessionId: session.id,
      query: qidoQuery ? { PatientName: qidoQuery } : {},
    });
    if (dicomwebState) dicomwebState.studies = studies;
    if (!studies.length) {
      setUploadStatus(statusEl, 'No studies matched this QIDO query');
      return;
    }
    const picked = studies[0];
    $('dicomweb-study').value = picked.studyUID || '';
    setUploadStatus(statusEl, `dicomweb: found ${studies.length} stud${studies.length === 1 ? 'y' : 'ies'}, selected ${picked.studyUID}`, 'active');
  } catch (e) {
    setUploadStatus(statusEl, `Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    setBusy(false);
  }
}

async function handleDicomwebSeriesDiscovery(statusEl, setBusy = () => {}, dicomwebState = null) {
  const wadoBase = $('dicomweb-base')?.value.trim() || '';
  const bearerToken = $('dicomweb-token')?.value || '';
  const studyUID = $('dicomweb-study')?.value.trim() || '';
  if (!wadoBase) {
    setUploadStatus(statusEl, 'Enter WADO-RS base URL', 'error');
    return;
  }
  if (!studyUID) {
    setUploadStatus(statusEl, 'Set Study UID first (or click Find studies)', 'error');
    return;
  }

  setBusy(true);
  try {
    setUploadStatus(statusEl, 'dicomweb: discovering series', 'active');
    const headers = dicomwebRequestHeaders(bearerToken);
    const session = ensureDicomwebSession(dicomwebState, { wadoBase, headers });
    const series = await discoverQidoSeries({
      wadoBase,
      studyUID,
      headers,
      sessionId: session.id,
    });
    if (dicomwebState) dicomwebState.series = series;
    if (!series.length) {
      setUploadStatus(statusEl, 'No series found for this study');
      return;
    }
    const preferred = series.find((item) => !isDerivedObjectModality(item.modality)) || series[0];
    $('dicomweb-series').value = preferred.seriesUID || '';
    setUploadStatus(statusEl, `dicomweb: found ${series.length} series, selected ${preferred.seriesUID}`, 'active');
  } catch (e) {
    setUploadStatus(statusEl, `Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    setBusy(false);
  }
}

async function handleDicomwebImport(statusEl, modal, selectSeries, setBusy = () => {}, dicomwebState = null) {
  const wadoBase = $('dicomweb-base')?.value.trim() || '';
  const studyUID = $('dicomweb-study')?.value.trim() || '';
  const seriesUID = $('dicomweb-series')?.value.trim() || '';
  const bearerToken = $('dicomweb-token')?.value || '';
  if (!wadoBase || !studyUID || !seriesUID) {
    setUploadStatus(statusEl, 'Enter WADO-RS base URL, Study UID, and Series UID', 'error');
    return;
  }

  setBusy(true);
  try {
    setUploadStatus(statusEl, 'dicomweb: fetching metadata', 'active');
    const headers = dicomwebRequestHeaders(bearerToken);
    const session = ensureDicomwebSession(dicomwebState, { wadoBase, headers });
    const metadata = await fetchSeriesMetadata({
      wadoBase,
      studyUID,
      seriesUID,
      headers,
      sessionId: session.id,
    });
    const modality = metadata?.[0]?.Modality || '';
    if (isDerivedObjectModality(modality)) {
      const result = await importDicomwebDerivedObject({
        wadoBase,
        studyUID,
        seriesUID,
        headers,
        manifest: state.manifest,
      });
      if (result.sourceSlug) {
        const idx = state.manifest.series.findIndex((series) => series.slug === result.sourceSlug);
        if (idx >= 0) {
          enableRegionsIfAvailable(state.manifest.series[idx]);
          closeModal('upload-modal');
          await selectSeries(idx);
        }
      }
      if (result.skipped) throw new Error(result.reason || 'Could not import DICOMweb derived object');
      notify(`Imported ${result.modality} onto ${result.sourceSlug}.`);
      return;
    }
    const result = await importDicomwebSeries({
      wadoBase,
      studyUID,
      seriesUID,
      bearerToken,
      sessionId: session.id,
      metadata,
      onProgress: (stage, detail) => {
        setUploadStatus(statusEl, `${stage}: ${detail}`, 'active');
      },
    });
    if (!result) throw new Error('DICOMweb series could not be parsed');
    setUploadStatus(statusEl, 'Loading DICOMweb series into viewer...', 'active');
    const idx = injectLocalSeries(state.manifest, result.entry, result.sliceCanvases, result.rawVolume);
    closeModal('upload-modal');
    await selectSeries(idx);
  } catch (e) {
    setUploadStatus(statusEl, `Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    setBusy(false);
  }
}
