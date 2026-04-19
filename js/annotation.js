// Annotations tool — numbered pins dropped on 2D slices with a text
// note. Persisted to localStorage keyed by "<slug>|<sliceIdx>" so they
// survive reloads without a backend. Each entry:
//   { id, x, y, text, createdAt }
// where id is a monotonic counter per slice, used for the pin label.
//
// Exports a clean API: the viewer wires the click path + redraw
// callback once via initAnnotations() and then only has to call the
// exported draw/hit/list functions. Callbacks exist because drawing
// and slice navigation still live in viewer.js (until those paths are
// also extracted).

import { $, escapeHtml, openModal, clientToCanvasPx as _clientToCanvasPx } from './dom.js';
import { state } from './state.js';
import { updateScrubFill as _updateScrubFill } from './cine.js';
import { setSliceIndex } from './state/viewer-commands.js';
import { setAnnotateMode } from './state/viewer-tool-commands.js';
import {
  annotatedSlicesForSeries,
  deleteDrawingEntryById,
  drawingEntriesForSeries,
  nextDrawingEntryId,
  noteEntriesForSlice,
  setNoteEntriesForSlice,
} from './annotation-graph.js';

// Hooks into the main viewer — set once by initAnnotations(). Keeping
// them as module-level vars avoids passing them through every call.
let _drawSlice = () => {};
let _drawSparkline = () => {};
let _updateSliceDisplay = () => {};
const clientToCanvasPx = (cx, cy) => _clientToCanvasPx($('view'), cx, cy);

export function initAnnotations({ drawSlice, drawSparkline, updateSliceDisplay }) {
  if (typeof drawSlice === 'function') _drawSlice = drawSlice;
  if (typeof drawSparkline === 'function') _drawSparkline = drawSparkline;
  if (typeof updateSliceDisplay === 'function') _updateSliceDisplay = updateSliceDisplay;
}

export function loadAnnotations() {
  const slug = state.manifest.series[state.seriesIdx].slug;
  const entries = drawingEntriesForSeries(state, slug).filter((entry) => entry.kind === 'note');
  const bySlice = {};
  for (const entry of entries) {
    const key = `${slug}|${entry.sliceIdx}`;
    if (!bySlice[key]) bySlice[key] = [];
    bySlice[key].push(entry.data);
  }
  return bySlice;
}

export function saveAnnotations(obj) {
  const slug = state.manifest.series[state.seriesIdx].slug;
  for (const entry of drawingEntriesForSeries(state, slug).filter((entry) => entry.kind === 'note')) {
    setNoteEntriesForSlice(slug, entry.sliceIdx, []);
  }
  for (const [key, list] of Object.entries(obj || {})) {
    if (!key.startsWith(`${slug}|`)) continue;
    const sliceIdx = Number(key.split('|')[1] || 0);
    setNoteEntriesForSlice(slug, sliceIdx, list);
  }
}

export function annotKey() {
  const slug = state.manifest.series[state.seriesIdx].slug;
  return `${slug}|${state.sliceIdx}`;
}

export function getAnnotationsHere() {
  const slug = state.manifest.series[state.seriesIdx].slug;
  return noteEntriesForSlice(slug, state.sliceIdx);
}

export function setAnnotationsHere(list) {
  const slug = state.manifest.series[state.seriesIdx].slug;
  setNoteEntriesForSlice(slug, state.sliceIdx, list);
}

export function toggleAnnotate() {
  if (state.mode !== '2d' && !state.annotateMode) return false;
  setAnnotateMode(!state.annotateMode);
  $('btn-annot').classList.toggle('active', state.annotateMode);
  $('view-xform').classList.toggle('measuring', state.annotateMode || state.measureMode);
  _drawSlice();
  _drawSparkline();
  return state.annotateMode;
}

export async function onAnnotateClick(ev) {
  // First try to edit an existing pin under the cursor.
  const hit = pinAtClient(ev.clientX, ev.clientY);
  if (hit) { await editAnnotation(hit.pin); return; }

  // No existing pin → only add a new one if we're actually in annotate mode.
  if (!state.annotateMode) return;

  const [px, py] = clientToCanvasPx(ev.clientX, ev.clientY);
  const result = await showAnnotDialog({ mode: 'new', text: '', slice: state.sliceIdx });
  if (result === null || result.text === '') return;
  const list = getAnnotationsHere();
  const nextId = nextDrawingEntryId(list);
  list.push({ id: nextId, x: px, y: py, text: result.text, createdAt: Date.now() });
  setAnnotationsHere(list);
  _drawSlice();
  renderAnnotationList();
  _drawSparkline();
}

export async function editAnnotation(pin) {
  const result = await showAnnotDialog({ mode: 'edit', text: pin.text || '', slice: state.sliceIdx });
  if (result === null) return;
  const list = getAnnotationsHere();
  if (result.action === 'delete' || result.text === '') {
    setAnnotationsHere(list.filter(p => p.id !== pin.id));
  } else {
    const target = list.find(p => p.id === pin.id);
    if (target) target.text = result.text;
    setAnnotationsHere(list);
  }
  _drawSlice();
  renderAnnotationList();
  _drawSparkline();
}

// Promise-wrapped modal for add/edit/delete of an annotation.
// Resolves with { action: 'save'|'delete', text: string } on save/delete,
// or null if cancelled (Esc or Cancel button or click-outside).
function showAnnotDialog({ mode, text, slice }) {
  return new Promise((resolve) => {
    const modal = $('annot-modal');
    const title = $('annot-title');
    const meta  = $('annot-meta');
    const area  = $('annot-text');
    const saveBtn   = $('annot-save');
    const cancelBtn = $('annot-cancel');
    const deleteBtn = $('annot-delete');
    const closeBtn  = $('annot-close');

    title.textContent = mode === 'edit' ? 'Edit annotation' : 'New annotation';
    meta.textContent  = `Slice ${slice + 1}`;
    area.value = text || '';
    deleteBtn.style.display = mode === 'edit' ? '' : 'none';

    openModal('annot-modal');
    // Focus the textarea and place cursor at the end
    setTimeout(() => { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }, 20);

    // Single cleanup path — detach every listener on any exit so the modal
    // is reusable and doesn't accumulate handlers.
    const cleanup = (result) => {
      modal.classList.remove('visible');
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onCancel);
      deleteBtn.removeEventListener('click', onDelete);
      closeBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onSave = () => cleanup({ action: 'save', text: area.value.trim() });
    const onCancel = () => cleanup(null);
    const onDelete = () => cleanup({ action: 'delete', text: '' });
    const onBackdrop = (e) => { if (e.target === modal) cleanup(null); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      // Cmd/Ctrl+Enter saves without leaving keyboard
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSave(); }
    };

    saveBtn.addEventListener('click', onSave);
    cancelBtn.addEventListener('click', onCancel);
    deleteBtn.addEventListener('click', onDelete);
    closeBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

export function annotationPinsForSlice(slug, sliceIdx) {
  return noteEntriesForSlice(slug, sliceIdx);
}

export function drawAnnotationPins(ctx, {
  slug = state.manifest.series[state.seriesIdx].slug,
  sliceIdx = state.sliceIdx,
  series = state.manifest.series[state.seriesIdx],
} = {}) {
  const list = annotationPinsForSlice(slug, sliceIdx);
  if (!list.length) return;
  const r = Math.max(7, series.width * 0.016);
  ctx.save();
  list.forEach((pin, i) => {
    ctx.beginPath();
    ctx.arc(pin.x, pin.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = `500 ${Math.round(r * 1.05)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), pin.x, pin.y + 1);
  });
  ctx.restore();
}

// Hit-test mouse position against annotation pins on the current slice.
// Returns the pin object and its display index, or null if the cursor
// isn't over a pin. Used both for hover tooltip display and to change
// the cursor when not in any tool mode.
export function pinAtClient(clientX, clientY) {
  const list = getAnnotationsHere();
  if (!list.length) return null;
  const [px, py] = clientToCanvasPx(clientX, clientY);
  const series = state.manifest.series[state.seriesIdx];
  const hitRadius = Math.max(10, series.width * 0.02);
  for (let i = 0; i < list.length; i++) {
    const pin = list[i];
    if (Math.hypot(pin.x - px, pin.y - py) < hitRadius) {
      return { pin, index: i };
    }
  }
  return null;
}

export function showAnnotHover(pin, index, clientX, clientY) {
  const host = $('annot-hover');
  const wrap = $('canvas-wrap').getBoundingClientRect();
  host.innerHTML = `
    <div class="ah-label">Note ${index + 1}</div>
    <div>${escapeHtml(pin.text || '')}</div>
  `;
  host.classList.add('visible');
  // Measure after showing (display:none hides dimensions)
  const hw = host.offsetWidth, hh = host.offsetHeight;
  let x = clientX - wrap.left + 14;
  let y = clientY - wrap.top - hh - 12;
  if (x + hw > wrap.width - 8) x = clientX - wrap.left - hw - 10;
  if (y < 8) y = clientY - wrap.top + 18;
  host.style.left = x + 'px';
  host.style.top  = y + 'px';
}

export function hideAnnotHover() {
  $('annot-hover').classList.remove('visible');
}

export function renderAnnotationList() {
  const host = $('annot-list');
  if (!host) return;
  const slug = state.manifest.series[state.seriesIdx].slug;
  const entries = drawingEntriesForSeries(state, slug)
    .filter((entry) => entry.kind === 'note')
    .map((entry) => ({ z: entry.sliceIdx, pin: entry.data }));

  const panel = $('annot-panel');
  if (!entries.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  host.innerHTML = entries.map(({ z, pin }) => `
    <div class="annot-row" data-z="${z}" data-id="${pin.id}">
      <div class="ar-head">
        <span class="ar-z">slice ${z + 1}</span>
        <span class="ar-del" title="delete">×</span>
      </div>
      <div class="ar-text">${escapeHtml(pin.text)}</div>
    </div>
  `).join('');
  host.querySelectorAll('.annot-row').forEach(el => {
    el.addEventListener('click', (e) => {
      const z = +el.dataset.z;
      if (e.target.classList.contains('ar-del')) {
        e.stopPropagation();
        const next = deleteDrawingEntryById(noteEntriesForSlice(slug, z), +el.dataset.id);
        setNoteEntriesForSlice(slug, z, next);
        renderAnnotationList();
        _drawSlice();
        _drawSparkline();
        return;
      }
      setSliceIndex(z);
    });
  });
}

// Set of slice indices with annotations — used by the sparkline marker
export function getAnnotatedSlices() {
  const slug = state.manifest.series[state.seriesIdx].slug;
  return annotatedSlicesForSeries(slug);
}
