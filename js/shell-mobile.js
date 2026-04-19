  /* Mobile shell: sidebars become viewport overlays and the bottom toolbar's
     tool rail (everything after the cine separator) becomes horizontally
     scrollable with edge fades.

     - Uses the viewer-header's built-in #btn-show-left / #btn-show-right as
       the open triggers (no separate floating hamburgers). On desktop these
       buttons are only visible when the sidebar is collapsed; on mobile CSS
       keeps them always visible.
     - Only one sidebar can be open at a time (opening one closes the other).
     - Fades on .tool-rail-wrap appear via has-overflow-left / has-overflow-right
       classes — left only when scrolled away from the start, right only when
       there's more content to reach. */

  // example state during iPad portrait: { mobileOpen: 'left', railOverflow: { left: false, right: true } }
  const MOBILE_MQ = '(max-width: 1100px)';

  export function initMobileShell() {
    const left = document.querySelector('aside.left');
    const right = document.querySelector('aside.right');
    const backdrop = document.getElementById('mobile-backdrop');
    const btnShowLeft = document.getElementById('btn-show-left');
    const btnShowRight = document.getElementById('btn-show-right');
    const btnToggleLeft = document.getElementById('btn-toggle-left');
    const btnClosePanel = document.getElementById('btn-close-panel');
    if (!left || !right || !backdrop) return;

    const isMobile = () => window.matchMedia(MOBILE_MQ).matches;

    const closeAll = () => {
      left.classList.remove('mobile-open');
      right.classList.remove('mobile-open');
      backdrop.classList.remove('visible');
    };

    const openLeft = () => {
      closeAll();
      left.classList.add('mobile-open');
      backdrop.classList.add('visible');
    };
    const openRight = () => {
      closeAll();
      right.classList.add('mobile-open');
      backdrop.classList.add('visible');
    };

    btnShowLeft?.addEventListener('click', () => {
      if (!isMobile()) return;
      left.classList.contains('mobile-open') ? closeAll() : openLeft();
    });
    btnShowRight?.addEventListener('click', () => {
      if (!isMobile()) return;
      right.classList.contains('mobile-open') ? closeAll() : openRight();
    });

    // Left sidebar's own header toggle doubles as "close" on mobile.
    btnToggleLeft?.addEventListener('click', () => {
      if (isMobile() && left.classList.contains('mobile-open')) closeAll();
    });
    btnClosePanel?.addEventListener('click', closeAll);
    backdrop.addEventListener('click', closeAll);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAll();
    });

    // Resize out of mobile: clear any overlay state so desktop layout is clean.
    window.addEventListener('resize', () => {
      if (!isMobile()) closeAll();
    });

    initToolRailFades();
  }

  /* Toolbar rail: tracks horizontal scroll position and toggles fade classes on
     the wrapper. Left fade is hidden at scrollLeft=0 so the first item doesn't
     look vignetted without reason. */
  function initToolRailFades() {
    const wrap = document.getElementById('tool-rail-wrap');
    const rail = document.getElementById('tool-rail');
    if (!wrap || !rail) return;

    let raf = 0;
    const update = () => {
      raf = 0;
      const max = rail.scrollWidth - rail.clientWidth;
      const left = rail.scrollLeft;
      // 1px threshold avoids sub-pixel jitter flipping the class on and off.
      wrap.classList.toggle('has-overflow-left', left > 1);
      wrap.classList.toggle('has-overflow-right', left < max - 1);
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };

    rail.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // Observe content size changes (e.g., toolbox panels toggling items on/off)
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(schedule).observe(rail);
    }
    // Initial measurement: double RAF so layout/fonts settle before we read scrollWidth.
    // setTimeout fallback covers backgrounded tabs where RAF may be throttled.
    requestAnimationFrame(() => requestAnimationFrame(update));
    setTimeout(update, 120);
  }
