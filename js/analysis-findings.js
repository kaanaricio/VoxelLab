// Findings sidebar + /api/analyze + scrubber severity ticks. Static builds
// keep cached findings; generation requires the local backend helper APIs.
import { state, HAS_LOCAL_BACKEND } from './state.js';
import { $, escapeHtml } from './dom.js';
import { viewerAiFlags, localApiHeaders } from './config.js';
import { cachedFetchResponse, cachedFetchJson } from './cached-fetch.js';
import { setAnalysis, setAnalysisBusy, setSliceIndex } from './state/viewer-commands.js';

let _renderScrubTicks = () => {};
const analysisUnavailableMessage = (flags) => {
  if (flags.aiUnavailableMessage) return flags.aiUnavailableMessage;
  return '';
};

/** Wired once from viewer after controls exist. */
export function initAnalysisFindings(h) {
  if (typeof h.renderScrubTicks === 'function') _renderScrubTicks = h.renderScrubTicks;
}

export function renderFindings() {
  const host = $('findings');
  $('findings-panel').hidden = false;
  const slug = state.manifest.series[state.seriesIdx].slug;
  const a = state.analysis;
  const hasFindings = !!(a && a.findings && a.findings.length);
  const groundedCount = hasFindings ? a.findings.filter(f => !!f.contextFingerprint).length : 0;
  const legacyCount = hasFindings ? a.findings.length - groundedCount : 0;
  const aiFlags = viewerAiFlags();
  const canRunAnalysis = aiFlags.localAiActionsEnabled;

  if (!hasFindings) {
    const statusMsg = !HAS_LOCAL_BACKEND
      ? 'No local backend — cached sidecars appear here when present.'
      : !aiFlags.analysisEnabled
      ? 'AI analysis is disabled in this build.'
      : !aiFlags.localAiAvailable
      ? aiFlags.aiUnavailableMessage
      : state.analysisBusy
      ? 'Sending slices to the local AI runner…'
      : '';
    host.innerHTML = `
      ${canRunAnalysis ? `
        <div class="gen-actions">
          <button class="gen-btn" id="gen-current-analysis">
            ${state.analysisBusy ? '<span class="spinner"></span> Analyzing…' : `Observe slice ${state.sliceIdx + 1}`}
          </button>
          <button class="gen-btn" id="gen-analysis">
            ${state.analysisBusy ? 'Queued' : '5-slice overview'}
          </button>
        </div>
      ` : ''}
      <div class="gen-note" id="gen-status">${statusMsg || 'Not a diagnosis. Unverified AI output, cached locally.'}</div>
    `;
    if (!canRunAnalysis) return;
    const btn = $('gen-analysis');
    const cur = $('gen-current-analysis');
    if (btn && !state.analysisBusy) btn.onclick = () => startAnalysis(slug);
    if (cur && !state.analysisBusy) cur.onclick = () => startAnalysis(slug, false, [state.sliceIdx]);
    return;
  }

  const items = a.findings.map((f) => {
    const sev = f.severity || 'note';
    return `
      <div class="finding ${sev}" data-slice="${f.slice}">
        <div class="f-head">
          <span class="f-idx">slice ${f.slice + 1}</span>
          <span class="ftag ${sev}">${sev.toUpperCase()}</span>
        </div>
        <div class="f-text">${escapeHtml(f.text)}</div>
      </div>
    `;
  }).join('');
  host.innerHTML = `
    ${a.summary ? `<div class="f-summary">${escapeHtml(a.summary)}</div>` : ''}
    <div class="regen-row">
      <span class="dlg-label">
        ${a.findings.length} observations${groundedCount ? ` · ${groundedCount} grounded` : ''}
        ${legacyCount > 0 ? ` · ${legacyCount} ungrounded` : ''}
      </span>
      ${canRunAnalysis
        ? `<span class="regen-link" id="regen-analysis">${state.analysisBusy ? 'analyzing…' : 'regenerate'}</span>`
        : ''}
    </div>
    ${items}
    <div class="gen-note">Not a diagnosis. Unverified AI output.</div>
  `;
  host.querySelectorAll('.finding').forEach((el) => {
    el.addEventListener('click', () => {
      setSliceIndex(+el.dataset.slice);
    });
  });
  const regen = $('regen-analysis');
  if (regen && !state.analysisBusy) regen.onclick = () => startAnalysis(slug, true);
}

export async function startAnalysis(slug, force = false, slices = null) {
  const aiFlags = viewerAiFlags();
  if (!aiFlags.localAiActionsEnabled) {
    const st = $('gen-status');
    if (st) st.textContent = analysisUnavailableMessage(aiFlags);
    return;
  }
  setAnalysisBusy(true);
  renderFindings();
  try {
    let url = `/api/analyze?slug=${encodeURIComponent(slug)}${force ? '&force=1' : ''}`;
    if (slices && slices.length) url += `&slices=${encodeURIComponent(slices.join(','))}`;
    const r = await fetch(url, { method: 'POST', headers: localApiHeaders() });
    if (!r.ok) {
      const payload = await r.json().catch(() => ({}));
      const msg = payload.error || payload.message || `HTTP ${r.status}`;
      $('gen-status').textContent = `Error: ${msg}`;
      setAnalysisBusy(false);
      return;
    }
  } catch (e) {
    $('gen-status').textContent = `Error: ${e.message}`;
    setAnalysisBusy(false);
    return;
  }

  const poll = async () => {
    try {
      const r = await fetch('/api/analyze/status', { headers: localApiHeaders() });
      const s = await r.json();
      const active = s[slug];
      if (active && active.running) {
        const st = $('gen-status');
        if (st) st.textContent = active.last || 'running…';
        setTimeout(poll, 2000);
        return;
      }
    } catch { /* fall through */ }
    setAnalysisBusy(false);
    // Drop stale cache entry before re-reading analysis JSON.
    const url = `./data/${slug}_analysis.json`;
    try { await cachedFetchResponse.invalidate(url); } catch { /* best-effort */ }
    const fresh = await cachedFetchJson(url);
    if (fresh) setAnalysis(fresh);
    renderFindings();
    _renderScrubTicks();
  };
  setTimeout(poll, 1500);
}

export function renderScrubTicks() {
  const host = $('scrub-ticks');
  host.innerHTML = '';
  const total = state.manifest.series[state.seriesIdx].slices;
  const addTick = (slice, cls, title) => {
    const pct = (slice / Math.max(1, total - 1)) * 100;
    const tick = document.createElement('div');
    tick.className = 'scrub-tick ' + cls;
    tick.style.left = `${pct}%`;
    tick.title = title;
    host.appendChild(tick);
  };

  if (state.analysis && state.analysis.findings) {
    for (const f of state.analysis.findings) {
      if (f.severity === 'note') continue;
      addTick(f.slice, f.severity, `slice ${f.slice + 1}: ${f.text}`);
    }
  }

  if (state.stats && state.stats.microbleeds && state.stats.microbleeds.per_slice) {
    const per = state.stats.microbleeds.per_slice;
    for (let z = 0; z < per.length; z++) {
      if (per[z] > 0) {
        addTick(z, 'microbleed', `slice ${z + 1}: ${per[z]} microbleed candidate${per[z] > 1 ? 's' : ''}`);
      }
    }
  }
}
