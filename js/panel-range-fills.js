// Right panel range inputs: --fill for WebKit filled tracks (matches scrubber).
// Firefox uses ::-moz-range-progress and does not need this.

import { $ } from './dom.js';

function pctForRange(el) {
  const min = +el.min || 0;
  const max = +el.max || 1;
  const v = +el.value;
  if (max <= min) return 0;
  return ((v - min) / (max - min)) * 100;
}

function applyFill(el) {
  el.style.setProperty('--fill', pctForRange(el) + '%');
}

/** Call after programmatic value changes (presets, sync from state). */
export function syncPanelRangeFills() {
  const root = $('right-panels-root');
  if (!root) return;
  root.querySelectorAll('input[type="range"]').forEach(applyFill);
}

export function initPanelRangeFills() {
  const root = $('right-panels-root');
  if (!root) return;

  const bind = (el) => {
    applyFill(el);
    el.addEventListener('input', () => applyFill(el));
    el.addEventListener('change', () => applyFill(el));
  };

  root.querySelectorAll('input[type="range"]').forEach(bind);

  const mo = new MutationObserver(() => {
    root.querySelectorAll('input[type="range"]').forEach((el) => {
      if (el.dataset.fillWired) return;
      el.dataset.fillWired = '1';
      bind(el);
    });
  });
  mo.observe(root, { childList: true, subtree: true });
}
