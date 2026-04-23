// viewer-spinner refcount with flash-guard.
//
// Callers no longer poke spinner.hidden directly; they mark a key as pending
// or done. The aggregate spinner is visible iff any key is pending. On top
// of that, two thresholds avoid visual jitter:
//
//   SHOW_DELAY_MS  — wait this long before showing; if the work finishes
//                    first, the spinner never flashes.
//   MIN_SHOW_MS    — once shown, stay visible at least this long so users
//                    don't see a 1-frame strobe on the tail end.
//
// Shape: pending keys Set<string> — e.g. Set { 'series-load', 'three-surface' }.
const pending = new Set();

const SHOW_DELAY_MS = 150;
const MIN_SHOW_MS = 350;

let showTimer = 0;
let hideTimer = 0;
let visible = false;
let shownAt = 0;

function el() { return document.getElementById('viewer-spinner'); }

function apply(next) {
  const node = el();
  if (!node) return;
  node.hidden = !next;
  visible = next;
  if (next) shownAt = performance.now();
}

function schedule() {
  const want = pending.size > 0;
  if (want) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    if (visible || showTimer) return;
    showTimer = setTimeout(() => {
      showTimer = 0;
      if (pending.size > 0) apply(true);
    }, SHOW_DELAY_MS);
    return;
  }
  if (showTimer) { clearTimeout(showTimer); showTimer = 0; }
  if (!visible || hideTimer) return;
  const remaining = Math.max(0, MIN_SHOW_MS - (performance.now() - shownAt));
  hideTimer = setTimeout(() => {
    hideTimer = 0;
    if (pending.size === 0) apply(false);
  }, remaining);
}

export function setSpinnerPending(key, isPending) {
  if (isPending) pending.add(key);
  else pending.delete(key);
  schedule();
}
