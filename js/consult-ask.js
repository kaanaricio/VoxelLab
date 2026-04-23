// Region-and-ask (/api/ask) + study consult (/api/consult) modals.
import { state } from './state.js';
import { $, escapeHtml, openModal, closeModal, clientToCanvasPx as _clientToCanvasPx } from './dom.js';
import { viewerAiFlags, localApiHeaders } from './config.js';
import { ensureTemplate } from './template-loader.js';
import { drawMeasurements } from './measure.js';
import { notify } from './notify.js';
import { cachedFetchResponse, cachedFetchJson } from './cached-fetch.js';
import {
  setAskHistory,
  setAskMarquee,
  setAskMode,
} from './state/viewer-tool-commands.js';

const clientToCanvasPx = (cx, cy) => _clientToCanvasPx($('view'), cx, cy);

/** Min drag size (px in slice space) each dimension — below this we nudge the user. */
const ASK_MIN_DRAG = 24;

/** @type {((q: string | null) => void) | null} */
let _askInputResolve = null;
/** @type {(() => void) | null} */
let _teardownAskInput = null;

const localAiMessage = (flags) => {
  if (flags.aiUnavailableMessage) return flags.aiUnavailableMessage;
  return 'AI actions are unavailable in this mode.';
};

export function toggleAskMode() {
  const flags = viewerAiFlags();
  if (state.mode !== '2d' || !flags.localAiActionsEnabled) {
    setAskMode(false);
    $('btn-ask').classList.remove('active');
    $('view-xform').classList.toggle('measuring', state.measureMode || state.annotateMode);
    syncAskPickingUi();
    return false;
  }
  setAskMode(!state.askMode);
  $('btn-ask').classList.toggle('active', state.askMode);
  $('view-xform').classList.toggle(
    'measuring',
    state.askMode || state.measureMode || state.annotateMode,
  );
  syncAskPickingUi();
  return state.askMode;
}

/** Banner when Ask mode is on (2D slice view). */
function syncAskPickingUi() {
  const wrap = $('canvas-wrap');
  const hint = $('ask-mode-hint');
  if (!wrap || !hint) return;
  const show = state.askMode && state.mode === '2d' && state.loaded;
  wrap.classList.toggle('ask-picking', !!show);
  hint.hidden = !show;
  if (!show) {
    setAskMarquee(null);
    hideAskReticle();
  }
}

export function syncAskModeAfterViewChange() {
  syncAskPickingUi();
}

/** Legacy no-op — point reticle removed in favor of drag marquee. */
export function positionAskReticle(_clientX, _clientY, show) {
  const el = $('ask-reticle');
  if (!el) return;
  el.hidden = !show;
}

export function hideAskReticle() {
  const el = $('ask-reticle');
  if (el) el.hidden = true;
}

function finishAskInput(question) {
  const r = _askInputResolve;
  _askInputResolve = null;
  if (_teardownAskInput) {
    _teardownAskInput();
    _teardownAskInput = null;
  }
  if (question == null) closeModal('ask-modal');
  if (r) r(question);
}

/**
 * @param {{ slice: number, region: {x0:number,y0:number,x1:number,y1:number}, x: number, y: number, previewDataUrl?: string }} loc
 * @returns {Promise<string | null>}
 */
export async function promptAskQuestion(loc) {
  await ensureAskModal();
  return new Promise((resolve) => {
    _askInputResolve = resolve;
    renderAskQuestionForm(loc);
  });
}

function cropPreviewDataUrl(x0, y0, x1, y1) {
  const canvas = $('view');
  if (!canvas) return '';
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w < 1 || h < 1) return '';
  try {
    const maxSide = 280;
    let dw = w;
    let dh = h;
    if (Math.max(dw, dh) > maxSide) {
      const s = maxSide / Math.max(dw, dh);
      dw = Math.round(dw * s);
      dh = Math.round(dh * s);
    }
    const c = document.createElement('canvas');
    c.width = dw;
    c.height = dh;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, x0, y0, w, h, 0, 0, dw, dh);
    return c.toDataURL('image/png');
  } catch {
    return '';
  }
}

/**
 * Drag a rectangle on the slice (like a screengrab), then type a question.
 * @param {MouseEvent} ev
 */
export function handleAskPointerDown(ev) {
  if (state.mode !== '2d' || !state.loaded) return;
  ev.preventDefault();
  const [px, py] = clientToCanvasPx(ev.clientX, ev.clientY);
  setAskMarquee({ x0: px, y0: py, x1: px, y1: py });

  const onMove = (e) => {
    const [qx, qy] = clientToCanvasPx(e.clientX, e.clientY);
    if (!state.askMarquee) return;
    setAskMarquee({ ...state.askMarquee, x1: qx, y1: qy });
    drawMeasurements();
  };

  const onUp = async () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    const series = state.manifest.series[state.seriesIdx];
    const W = series.width;
    const H = series.height;
    const raw = state.askMarquee;
    setAskMarquee(null);
    drawMeasurements();

    if (!raw) return;
    let x0 = Math.round(Math.min(raw.x0, raw.x1));
    let y0 = Math.round(Math.min(raw.y0, raw.y1));
    let x1 = Math.round(Math.max(raw.x0, raw.x1));
    let y1 = Math.round(Math.max(raw.y0, raw.y1));
    x0 = Math.max(0, Math.min(x0, W - 1));
    x1 = Math.max(0, Math.min(x1, W - 1));
    y0 = Math.max(0, Math.min(y0, H - 1));
    y1 = Math.max(0, Math.min(y1, H - 1));
    const rw = x1 - x0 + 1;
    const rh = y1 - y0 + 1;
    if (rw < ASK_MIN_DRAG || rh < ASK_MIN_DRAG) {
      notify(`Drag a larger box (at least ${ASK_MIN_DRAG}×${ASK_MIN_DRAG} px on each side).`, { duration: 3400 });
      return;
    }

    const region = { x0, y0, x1, y1 };
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const previewDataUrl = cropPreviewDataUrl(x0, y0, x1, y1);

    const flags = viewerAiFlags();
    if (!flags.localAiActionsEnabled) {
      await showAskModal({
        error: localAiMessage(flags),
        x: cx,
        y: cy,
        slice: state.sliceIdx,
        region,
        question: 'Why is AI unavailable?',
      });
      return;
    }

    const question = await promptAskQuestion({
      slice: state.sliceIdx,
      region,
      x: cx,
      y: cy,
      previewDataUrl,
    });
    if (!question || !question.trim()) return;

    const slug = state.manifest.series[state.seriesIdx].slug;
    await showAskModal({
      loading: true,
      x: cx,
      y: cy,
      slice: state.sliceIdx,
      region,
      question: question.trim(),
    });
    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: localApiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          slug,
          slice: state.sliceIdx,
          region,
          question: question.trim(),
        }),
      });
      const result = await r.json();
      if (!r.ok) {
        await showAskModal({
          error: result.error || `HTTP ${r.status}`,
          x: cx,
          y: cy,
          slice: state.sliceIdx,
          region,
          question,
        });
        return;
      }
      // /api/ask just rewrote this sidecar; drop the cached entry before
      // re-reading so the new question round-trips through cachedFetchJson.
      const asksUrl = `./data/${slug}_asks.json`;
      try { await cachedFetchResponse.invalidate(asksUrl); } catch { /* best-effort */ }
      const askData = await cachedFetchJson(asksUrl);
      if (askData) setAskHistory(askData.entries || []);
      await showAskModal({ ...result, slice: state.sliceIdx, region, question });
    } catch (e) {
      await showAskModal({
        error: e.message,
        x: cx,
        y: cy,
        slice: state.sliceIdx,
        region,
        question,
      });
    }
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  drawMeasurements();
}

export async function showAskModal(info) {
  await ensureAskModal();
  renderAskModal(info);
}

async function ensureAskModal() {
  await ensureTemplate('./templates/ask-modal.html', 'modal-root', 'ask-modal');
}

const DEFAULT_ASK_PLACEHOLDER = 'What do you see in this region?';

function formatAskLocMeta(series, loc) {
  const sl = `Slice ${loc.slice + 1}`;
  if (loc.region) {
    const r = loc.region;
    return `${series.name} · ${sl} · ${r.x0},${r.y0} — ${r.x1},${r.y1}`;
  }
  return `${series.name} · ${sl} · ${Math.round(loc.x)}, ${Math.round(loc.y)}`;
}

function renderAskQuestionForm(loc) {
  const series = state.manifest.series[state.seriesIdx];
  const locLine = formatAskLocMeta(series, loc);
  const body = $('ask-body');
  const titleEl = document.querySelector('#ask-modal .ask-title');
  if (titleEl) titleEl.textContent = 'Question about selection';
  const preview = loc.previewDataUrl
    ? `<div class="ask-preview-frame"><img class="ask-preview-img" src="${loc.previewDataUrl}" alt="" /></div>`
    : '';
  openModal('ask-modal');
  body.innerHTML = `
    <div class="ask-input-lead">
      <p class="ask-input-context">${escapeHtml(locLine)}</p>
      ${preview}
    </div>
    <div class="ask-input-field">
      <textarea id="ask-q-input" class="ask-textarea" rows="5"
        placeholder="${escapeHtml(DEFAULT_ASK_PLACEHOLDER)}"
        aria-label="Question for AI"></textarea>
    </div>
    <div class="ask-input-footer">
      <button type="button" class="ask-btn ask-btn-ghost" id="ask-q-cancel">Cancel</button>
      <button type="button" class="ask-btn ask-btn-primary" id="ask-q-submit">Send</button>
    </div>
    <p class="ask-input-hint">⌘↵ or Ctrl+↵ to send · not a medical diagnosis</p>
  `;
  const ta = $('ask-q-input');
  const submit = () => {
    const q = ta.value.trim();
    if (!q) {
      ta.focus();
      return;
    }
    finishAskInput(q);
  };
  const cancel = () => finishAskInput(null);
  $('ask-q-submit').onclick = submit;
  $('ask-q-cancel').onclick = cancel;
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  const modal = $('ask-modal');
  const closeBtn = $('ask-close');
  const onBackdrop = (e) => {
    if (e.target === modal) cancel();
  };
  const onCloseBtn = (e) => {
    if (!_askInputResolve) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  };
  const onEscape = (e) => {
    if (e.key === 'Escape' && _askInputResolve && document.querySelector('#ask-q-input')) {
      e.preventDefault();
      cancel();
    }
  };
  modal.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onEscape, true);
  if (closeBtn) closeBtn.addEventListener('click', onCloseBtn, true);
  _teardownAskInput = () => {
    modal.removeEventListener('click', onBackdrop);
    document.removeEventListener('keydown', onEscape, true);
    if (closeBtn) closeBtn.removeEventListener('click', onCloseBtn, true);
    if (titleEl) titleEl.textContent = 'Ask AI';
  };
  queueMicrotask(() => {
    ta.focus();
    if (!ta.value) ta.placeholder = DEFAULT_ASK_PLACEHOLDER;
  });
}

/** Cancel in-progress ask question dialog (e.g. Escape before other handlers). */
export function cancelAskQuestionIfOpen() {
  if (!_askInputResolve || !$('ask-q-input')) return false;
  finishAskInput(null);
  return true;
}

function renderAskModal(info) {
  const body = $('ask-body');
  const titleEl = document.querySelector('#ask-modal .ask-title');
  if (titleEl) titleEl.textContent = 'Ask AI';
  openModal('ask-modal');
  const series = state.manifest.series[state.seriesIdx];
  const locMeta = formatAskLocMeta(series, info);

  if (info.loading) {
    body.innerHTML = `
      <div class="ask-result-q">“${escapeHtml(info.question)}”</div>
      <div class="ask-result-meta">${escapeHtml(locMeta)}</div>
      <div class="ask-result-body"><span class="spinner ask-inline-spinner"></span> Asking…</div>
    `;
    return;
  }
  if (info.error) {
    body.innerHTML = `
      <div class="ask-result-q">“${escapeHtml(info.question)}”</div>
      <div class="ask-result-meta">${escapeHtml(locMeta)}</div>
      <div class="ask-result-body err">Error: ${escapeHtml(info.error)}</div>
    `;
    return;
  }
  body.innerHTML = `
    <div class="ask-result-q">“${escapeHtml(info.question)}”</div>
    <div class="ask-result-meta">${escapeHtml(locMeta)}${info.cached ? ' · cached' : ''}</div>
    <div class="ask-result-body">${escapeHtml(info.answer || '')}</div>
    <div class="ask-result-foot">
      <span>Descriptive observation only — discuss with a radiologist.</span>
    </div>
  `;
}

export async function runConsult(force = false) {
  const body = $('consult-body');
  openModal('consult-modal');
  const flags = viewerAiFlags();
  if (!flags.localAiActionsEnabled) {
    body.innerHTML = `<div class="ask-a err">${escapeHtml(localAiMessage(flags))}</div>`;
    return;
  }
  body.innerHTML = `<div class="ask-a"><span class="spinner"></span> ${force ? 'Re-running consult…' : 'Synthesizing findings…'}</div>`;
  try {
    let result;
    if (!force) {
      const r = await fetch('/api/consult', { headers: localApiHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      result = await r.json();
    }
    if (force || !result || !result.impression) {
      const r2 = await fetch('/api/consult?force=1', { method: 'POST', headers: localApiHeaders() });
      result = await r2.json();
      if (!r2.ok) throw new Error(result.error || `HTTP ${r2.status}`);
    }
    renderConsultBody(body, result);
  } catch (e) {
    body.innerHTML = `<div class="ask-a err">Error: ${escapeHtml(e.message)}</div>`;
  }
}

export function renderConsultBody(body, result) {
  const bullets = (result.ask_radiologist || []).map((b) => `<li>${escapeHtml(b)}</li>`).join('');
  body.innerHTML = `
    <div class="ask-section-title">Impression${result.cached ? ' · cached' : ''}</div>
    <div class="ask-a">${escapeHtml(result.impression || '')}</div>
    ${bullets ? `
      <div class="ask-section-title">Things worth asking a radiologist</div>
      <ul class="ask-list">${bullets}</ul>
    ` : ''}
    ${result.limitations ? `
      <div class="ask-section-title">What this study cannot assess</div>
      <div class="ask-a">${escapeHtml(result.limitations)}</div>
    ` : ''}
    <div class="ask-foot">
      <span>${escapeHtml(result.disclaimer || 'Generated by a general-purpose AI, not a medical imaging model. May contain errors. Always consult a qualified radiologist.')}</span>
      <span class="rerun" id="consult-rerun">re-run</span>
    </div>
  `;
  const rerun = $('consult-rerun');
  if (rerun) rerun.onclick = () => runConsult(true);
}
