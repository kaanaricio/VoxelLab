// Right sidebar sections: toggle `.collapsed` on title click; persist in localStorage.
const COLLAPSE_KEY = 'mri-viewer/collapsed/v1';

// Set<panelName> — panels that were open on last visit and should animate open once content is ready.
const _pendingExpand = new Set();

function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveCollapsed(obj) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(obj));
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * Call when a panel's content is fully rendered. If the user had that panel
 * open on their last visit, it will animate open from the collapsed start state.
 * Double-rAF lets the browser paint one collapsed frame so the CSS transition fires.
 */
export function signalPanelReady(name) {
  if (!_pendingExpand.has(name)) return;
  _pendingExpand.delete(name);
  const section = document.querySelector(`.rp-section[data-panel="${name}"]`);
  if (!section || !section.classList.contains('collapsed')) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      section.classList.remove('collapsed');
      const title = section.querySelector('.sec-title');
      if (!title) return;
      const useEl = title.querySelector('.rp-collapse-ico use');
      if (useEl) useEl.setAttribute('href', 'icons.svg#i-minus');
      title.setAttribute('aria-expanded', 'true');
    });
  });
}

export function wireCollapsiblePanels() {
  const saved = loadCollapsed();
  document.querySelectorAll('.rp-section.collapsible').forEach((section) => {
    if (section.dataset.collapseWired === '1') return;
    section.dataset.collapseWired = '1';

    const name = section.dataset.panel;
    const alwaysCollapsed = section.dataset.alwaysCollapsed === 'true';
    const userState = saved[name];
    // Always start collapsed to prevent flash of empty content on reload.
    // data-always-collapsed="true" ignores saved state entirely.
    // Otherwise, if the user left the panel open, queue it for animated re-expand
    // once its content signals readiness via signalPanelReady(name).
    section.classList.add('collapsed');
    if (!alwaysCollapsed && userState === false && name) {
      _pendingExpand.add(name);
    }

    const title = section.querySelector('.sec-title');
    if (!title) return;
    // Template should include the icon (instant paint). Fallback for dynamic panels.
    if (!title.querySelector('.rp-collapse-ico')) {
      const wrap = document.createElement('span');
      wrap.className = 'rp-collapse-ico';
      wrap.setAttribute('aria-hidden', 'true');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'rp-collapse-svg');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', 'icons.svg#i-plus');
      svg.appendChild(use);
      wrap.appendChild(svg);
      title.appendChild(wrap);
    }
    title.setAttribute('role', 'button');
    title.tabIndex = 0;
    const syncIcon = () => {
      const useEl = title.querySelector('.rp-collapse-ico use');
      if (!useEl) return;
      useEl.setAttribute(
        'href',
        section.classList.contains('collapsed') ? 'icons.svg#i-plus' : 'icons.svg#i-minus',
      );
    };
    const syncAria = () => {
      title.setAttribute(
        'aria-expanded',
        section.classList.contains('collapsed') ? 'false' : 'true',
      );
      syncIcon();
    };
    syncAria();
    const toggle = () => {
      section.classList.toggle('collapsed');
      syncAria();
      const cur = loadCollapsed();
      cur[name] = section.classList.contains('collapsed');
      saveCollapsed(cur);
    };
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  });
}
