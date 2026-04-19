// Tiny DOM helpers shared across every viewer module.
//
// Kept as minimal as possible — we're not reinventing jQuery, just
// giving ourselves a `$('foo')` shortcut and an HTML-escaper.

export const $ = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export function colorSwatchSvg(className, rgb, size = 10) {
  const [r, g, b] = Array.isArray(rgb) && rgb.length === 3 ? rgb : [85, 85, 85];
  const radius = Math.max(2, Math.round(size / 5));
  return `<svg class="${className}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false"><rect width="${size}" height="${size}" rx="${radius}" fill="rgb(${r},${g},${b})"></rect></svg>`;
}

export function openModal(id) {
  $(id).classList.add('visible');
}

export function closeModal(id) {
  $(id).classList.remove('visible');
}

export function closeTopModal() {
  const open = document.querySelector('[id$="-modal"].visible');
  if (open) { open.classList.remove('visible'); return true; }
  return false;
}

export function initModals() {
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.ask-close, .hc-close');
    if (closeBtn) { closeBtn.closest('[id$="-modal"]')?.classList.remove('visible'); return; }
    if (e.target.id?.endsWith('-modal') && e.target.classList.contains('visible')) {
      e.target.classList.remove('visible');
    }
  });
}

// confirm-modal: returns a dismiss function.
export function showDialog(title, bodyHTML) {
  $('confirm-title').textContent = title;
  $('confirm-body').innerHTML = bodyHTML;
  openModal('confirm-modal');
  return () => closeModal('confirm-modal');
}

// Convert a client (mouse) X/Y to canvas-internal pixel coords. The
// CSS transform on the canvas wrapper is already baked into
// getBoundingClientRect, so this works correctly even when the user
// has panned and zoomed the 2D view.
export function clientToCanvasPx(canvas, clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return [
    (clientX - r.left) / r.width  * canvas.width,
    (clientY - r.top)  / r.height * canvas.height,
  ];
}
