// Singleton tooltip manager for [data-tip] anchors.
//
// Three behaviors the previous CSS-only implementation could not express:
//   1. Grace window — once any tooltip shows, the next one within GRACE_MS
//      appears instantly instead of re-running the show delay, so moving
//      button → button never flashes the translucent in-between state.
//   2. Click dismissal with region-based suppression — clicking a tooltip
//      anchor engages clickSuppressed, which stays on as long as the
//      cursor is over *any* [data-tip]. That survives the sidebar toggle
//      swap (hide ↔ show buttons appear at the same screen location under
//      a stationary cursor), which a per-element suppression could not.
//      The first pointerover on non-tooltip content clears the flag.
//   3. Viewport clamp / auto-flip — bubble is position:fixed, so it can
//      escape sidebar scroll clipping and flip below when near the top.
//
// The manager delegates via document-level pointerover/pointerout, so
// anchors added later need no registration.

const SHOW_DELAY_MS = 300;
const GRACE_MS = 450;
const LEAVE_DEBOUNCE_MS = 40;

let bubble = null;
let visible = false;
// After a click on any [data-tip] anchor, all tooltips are suppressed as
// long as the cursor is still within some [data-tip] region. The first
// pointerover on non-tooltip content clears the flag. This survives the
// sidebar toggle swap (hide-sidebar ↔ show-sidebar appear at the same
// screen location under a stationary cursor), which a per-element
// suppression could not handle.
let clickSuppressed = false;
let showTimer = 0;
let hideTimer = 0;
let lastHiddenAt = -Infinity;
let initialized = false;

function ensureBubble() {
  if (bubble) return bubble;
  bubble = document.createElement('div');
  bubble.className = 'tip-bubble';
  bubble.setAttribute('role', 'tooltip');
  bubble.hidden = true;
  document.body.appendChild(bubble);
  return bubble;
}

function placeBubble(anchor) {
  const b = ensureBubble();
  const pos = anchor.dataset.tipPos || 'top';
  const r = anchor.getBoundingClientRect();
  // Measure while visible (but visibility:hidden) so width/height are known.
  const prevVis = b.style.visibility;
  b.style.visibility = 'hidden';
  b.hidden = false;
  const bw = b.offsetWidth;
  const bh = b.offsetHeight;
  b.style.visibility = prevVis;
  const pad = 6;
  const gap = 8;
  let x;
  let y;
  if (pos === 'right') {
    x = r.right + gap;
    y = r.top + r.height / 2 - bh / 2;
  } else if (pos === 'left') {
    x = r.left - bw - gap;
    y = r.top + r.height / 2 - bh / 2;
  } else if (pos === 'bottom-start') {
    // Tooltip sits under the anchor, left edges aligned — prevents the bubble
    // from spilling off the left of the viewport for header-edge buttons.
    x = r.left;
    y = r.bottom + gap;
  } else if (pos === 'bottom-end') {
    // Mirror of bottom-start for right-edge header buttons.
    x = r.right - bw;
    y = r.bottom + gap;
  } else {
    x = r.left + r.width / 2 - bw / 2;
    y = r.top - bh - gap;
    if (y < pad) y = r.bottom + gap; // auto-flip when there's no room above
  }
  x = Math.max(pad, Math.min(x, window.innerWidth - bw - pad));
  y = Math.max(pad, Math.min(y, window.innerHeight - bh - pad));
  b.style.left = `${Math.round(x)}px`;
  b.style.top = `${Math.round(y)}px`;
}

function swapTo(anchor, opts = {}) {
  const tip = anchor.dataset.tip;
  if (!tip) return;
  // Suppress the trigger's own tip while its toolbox is open.
  if (anchor.matches('.toolbox.open > .toolbox-trigger')) return;
  const b = ensureBubble();
  b.textContent = tip;
  const wasVisible = visible;
  if (b.hidden) b.hidden = false;
  placeBubble(anchor);
  if (!wasVisible && !opts.instant) {
    // Force reflow so the opacity/transform transition replays.
    void b.offsetWidth;
  }
  b.classList.add('visible');
  visible = true;
}

function finishHide() {
  const b = ensureBubble();
  if (!b.classList.contains('visible')) b.hidden = true;
}

function beginHide() {
  if (!visible) return;
  const b = ensureBubble();
  b.classList.remove('visible');
  visible = false;
  lastHiddenAt = performance.now();
  setTimeout(finishHide, 160);
}

function cancelShow() {
  if (showTimer) { clearTimeout(showTimer); showTimer = 0; }
}

function cancelHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
}

function onEnter(anchor) {
  if (!anchor || !anchor.dataset.tip) return;
  if (clickSuppressed) return;
  cancelHide();
  cancelShow();
  const inGrace = performance.now() - lastHiddenAt < GRACE_MS;
  if (visible) {
    swapTo(anchor, { instant: true });
    return;
  }
  if (inGrace) {
    swapTo(anchor, { instant: true });
    return;
  }
  showTimer = setTimeout(() => {
    showTimer = 0;
    swapTo(anchor);
  }, SHOW_DELAY_MS);
}

function onLeave() {
  cancelShow();
  if (!visible) return;
  cancelHide();
  hideTimer = setTimeout(() => {
    hideTimer = 0;
    beginHide();
  }, LEAVE_DEBOUNCE_MS);
}

function findAnchor(node) {
  if (!node || typeof node.closest !== 'function') return null;
  return node.closest('[data-tip]');
}

export function initTooltips() {
  if (initialized) return;
  initialized = true;

  document.addEventListener('pointerover', (e) => {
    const anchor = findAnchor(e.target);
    // The first pointerover outside any [data-tip] clears the click flag —
    // that's the signal the user has "moved away" and returning to a tip
    // should go through the normal show delay.
    if (!anchor) { clickSuppressed = false; return; }
    const from = findAnchor(e.relatedTarget);
    if (from === anchor) return;
    onEnter(anchor);
  }, true);

  document.addEventListener('pointerout', (e) => {
    const anchor = findAnchor(e.target);
    if (!anchor) return;
    const to = findAnchor(e.relatedTarget);
    if (to === anchor) return;
    onLeave();
  }, true);

  // Click dismisses the current tooltip and engages clickSuppressed. The
  // flag clears only when the cursor moves over non-tooltip content, so a
  // button that swaps in under a stationary cursor (hide ↔ show sidebar)
  // stays quiet until the user intentionally leaves and returns.
  document.addEventListener('click', (e) => {
    const anchor = findAnchor(e.target);
    if (!anchor) return;
    clickSuppressed = true;
    cancelShow();
    cancelHide();
    if (visible) beginHide();
    lastHiddenAt = -Infinity;
  }, true);

  window.addEventListener('scroll', () => {
    if (visible) { cancelShow(); beginHide(); }
  }, true);
  window.addEventListener('blur', () => { cancelShow(); beginHide(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && visible) beginHide();
  });
}
