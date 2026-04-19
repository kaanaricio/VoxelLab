// Touch/gesture support for iPad and trackpad users.
//
// - One finger drag: window/level (same as mouse drag)
// - Two finger pinch: zoom
// - Two finger pan: pan the image
// - Swipe up/down on scrubber area: scrub slices
//
// Attaches to the view-stage element. Coordinates with the existing
// mouse-driven pan/zoom in viewer.js via the same CSS custom properties
// (--zoom, --tx, --ty) on #view-xform.

import { $ } from './dom.js';
import { state } from './state.js';
import { setZoomTransform } from './state/viewer-commands.js';

let _onWL = null;       // callback: (dWindow, dLevel) => void
let _onScrub = null;    // callback: (delta) => void  — +1/-1 per slice

export function initTouch({ onWindowLevel, onScrub }) {
  _onWL = onWindowLevel;
  _onScrub = onScrub;

  const stage = $('view-stage');
  if (!stage) return;

  let touches0 = null;   // snapshot of touches at gesture start
  let startZoom = 1;
  let startTx = 0, startTy = 0;
  let gestureType = null; // 'wl' | 'zoom-pan' | null

  stage.addEventListener('touchstart', (e) => {
    if (state.mode !== '2d') return;
    touches0 = copyTouches(e.touches);
    startZoom = state.zoom;
    startTx = state.tx;
    startTy = state.ty;
    gestureType = e.touches.length === 1 ? 'wl' : 'zoom-pan';
  }, { passive: true });

  stage.addEventListener('touchmove', (e) => {
    if (!touches0 || state.mode !== '2d') return;

    if (gestureType === 'wl' && e.touches.length === 1 && _onWL) {
      // Single-finger drag → window/level
      const dx = e.touches[0].clientX - touches0[0].clientX;
      const dy = e.touches[0].clientY - touches0[0].clientY;
      _onWL(dx * 0.5, -dy * 0.5);
      touches0 = copyTouches(e.touches);
      e.preventDefault();
    } else if (gestureType === 'zoom-pan' && e.touches.length >= 2) {
      // Two-finger → pinch zoom + pan
      const d0 = dist(touches0[0], touches0[1]);
      const d1 = dist(e.touches[0], e.touches[1]);
      const scale = d1 / Math.max(1, d0);

      const cx0 = (touches0[0].clientX + touches0[1].clientX) / 2;
      const cy0 = (touches0[0].clientY + touches0[1].clientY) / 2;
      const cx1 = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy1 = (e.touches[0].clientY + e.touches[1].clientY) / 2;

      setZoomTransform({
        zoom: startZoom * scale,
        tx: startTx + (cx1 - cx0),
        ty: startTy + (cy1 - cy0),
      });

      const xf = $('view-xform');
      if (xf) {
        xf.style.setProperty('--zoom', String(state.zoom));
        xf.style.setProperty('--tx', state.tx + 'px');
        xf.style.setProperty('--ty', state.ty + 'px');
      }
      e.preventDefault();
    }
  }, { passive: false });

  stage.addEventListener('touchend', () => {
    touches0 = null;
    gestureType = null;
  }, { passive: true });

  // Swipe on the scrubber area for slice navigation
  const scrubWrap = document.querySelector('.scrub-block');
  if (scrubWrap && _onScrub) {
    let scrubStartY = null;
    scrubWrap.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) scrubStartY = e.touches[0].clientY;
    }, { passive: true });
    scrubWrap.addEventListener('touchmove', (e) => {
      if (scrubStartY === null || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - scrubStartY;
      if (Math.abs(dy) > 15) {
        _onScrub(dy > 0 ? -1 : 1);
        scrubStartY = e.touches[0].clientY;
        e.preventDefault();
      }
    }, { passive: false });
    scrubWrap.addEventListener('touchend', () => { scrubStartY = null; }, { passive: true });
  }
}

function copyTouches(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    out.push({ clientX: list[i].clientX, clientY: list[i].clientY });
  }
  return out;
}

function dist(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
