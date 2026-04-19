import { SHELL_TIP } from './shell-constants.js';

const SHELL_LAYOUT_KEY = 'mri-viewer/shellLayout/v1';

function loadShellLayout() {
  try {
    const raw = localStorage.getItem(SHELL_LAYOUT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (typeof o.leftCollapsed !== 'boolean' || typeof o.rightCollapsed !== 'boolean') return null;
    return o;
  } catch {
    return null;
  }
}

function saveShellLayout(leftCollapsed, rightCollapsed) {
  try {
    localStorage.setItem(
      SHELL_LAYOUT_KEY,
      JSON.stringify({ leftCollapsed, rightCollapsed }),
    );
  } catch {
    /* quota / private mode */
  }
}

export function initDesktopSidebarToggles() {
  const app = document.querySelector('.app');
  const btnToggleLeft = document.getElementById('btn-toggle-left');
  const btnToggleRight = document.getElementById('btn-toggle-right');
  const btnShowLeft = document.getElementById('btn-show-left');
  const btnShowRight = document.getElementById('btn-show-right');
  const btnTheme = document.getElementById('btn-theme');
  const rightPanelActions = document.querySelector('.sidebar-header-right .sidebar-actions');
  const viewerHeaderRightActions = document.getElementById('viewer-header-right-actions');
  if (!app) return;

  const saved = loadShellLayout();
  if (saved) {
    app.classList.toggle('left-collapsed', saved.leftCollapsed);
    app.classList.toggle('right-collapsed', saved.rightCollapsed);
  }
  const root = document.documentElement;
  root.removeAttribute('data-shell-left-collapsed');
  root.removeAttribute('data-shell-right-collapsed');

  const persistLayout = () => {
    saveShellLayout(
      app.classList.contains('left-collapsed'),
      app.classList.contains('right-collapsed'),
    );
  };

  // Button hosts: { rightPanelActions, viewerHeaderRightActions }.
  // Example: open => [theme][toggle-right] in panel actions; collapsed => [theme][show-right] in header right actions.
  const syncThemeButtonHost = () => {
    if (!btnTheme) return;
    const rightCollapsed = app.classList.contains('right-collapsed');
    if (rightCollapsed) {
      if (viewerHeaderRightActions) viewerHeaderRightActions.insertBefore(btnTheme, btnShowRight || null);
      // Default placement (centered below, viewport-clamped) keeps the tip readable without forcing it into a corner.
      delete btnTheme.dataset.tipPos;
      return;
    }
    if (rightPanelActions && !rightPanelActions.contains(btnTheme)) {
      rightPanelActions.insertBefore(btnTheme, btnToggleRight || null);
    }
    // Inside the right panel, keep the legacy left placement so the tooltip floats over the canvas.
    btnTheme.dataset.tipPos = 'left';
  };

  const syncShowButtons = () => {
    const leftCollapsed = app.classList.contains('left-collapsed');
    const rightCollapsed = app.classList.contains('right-collapsed');
    if (btnShowLeft) {
      btnShowLeft.hidden = !leftCollapsed;
      btnShowLeft.dataset.tip = SHELL_TIP.SHOW_SIDEBAR;
      btnShowLeft.setAttribute('aria-label', SHELL_TIP.SHOW_SIDEBAR);
    }
    if (btnShowRight) {
      btnShowRight.hidden = !rightCollapsed;
      btnShowRight.dataset.tip = SHELL_TIP.SHOW_PANEL;
      btnShowRight.setAttribute('aria-label', SHELL_TIP.SHOW_PANEL);
    }
    if (btnToggleLeft) {
      const tip = leftCollapsed ? SHELL_TIP.SHOW_SIDEBAR : SHELL_TIP.HIDE_SIDEBAR;
      btnToggleLeft.dataset.tip = tip;
      btnToggleLeft.setAttribute('aria-label', tip);
    }
    if (btnToggleRight) {
      const tip = rightCollapsed ? SHELL_TIP.SHOW_PANEL : SHELL_TIP.HIDE_PANEL;
      btnToggleRight.dataset.tip = tip;
      btnToggleRight.setAttribute('aria-label', tip);
    }
    syncThemeButtonHost();
  };

  btnToggleLeft?.addEventListener('click', () => {
    app.classList.toggle('left-collapsed');
    syncShowButtons();
    persistLayout();
  });
  btnToggleRight?.addEventListener('click', () => {
    app.classList.toggle('right-collapsed');
    syncShowButtons();
    persistLayout();
  });
  btnShowLeft?.addEventListener('click', () => {
    app.classList.remove('left-collapsed');
    syncShowButtons();
    persistLayout();
  });
  btnShowRight?.addEventListener('click', () => {
    app.classList.remove('right-collapsed');
    syncShowButtons();
    persistLayout();
  });
  syncShowButtons();
}
