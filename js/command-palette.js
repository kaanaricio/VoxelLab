// Command palette (⌘K / Ctrl+K) — global action search.
//
// Commands are registered with { id, label, icon, section, shortcut, action }.
// Sections group visually: "Tools", "Overlays", "View", "Display", "Export".
// Filtering is case-insensitive substring match on label + section.
// Keyboard: ↑↓ navigate, Enter execute, Escape close.

import { $ } from './dom.js';

// { id, label, icon (href), section, shortcut?, keywords?, action() }
const commands = [];

export function registerCommand(cmd) {
  if (!commands.find(c => c.id === cmd.id)) commands.push(cmd);
}

export function registerCommands(list) {
  list.forEach(registerCommand);
}

const backdrop = $('cmdk');
const dialog   = $('cmdk-dialog');
const input    = $('cmdk-input');
const list     = $('cmdk-list');

let activeIdx = 0;
let filtered  = [];

function isOpen() { return backdrop.classList.contains('open'); }

export function openPalette() {
  backdrop.classList.add('open');
  input.value = '';
  activeIdx = 0;
  render();
  // Defer focus so the transition doesn't fight with the browser
  requestAnimationFrame(() => input.focus());
}

export function closePalette() {
  backdrop.classList.remove('open');
  input.blur();
}

function toggle() { isOpen() ? closePalette() : openPalette(); }

function matchFilter(cmd, q) {
  if (!q) return true;
  const hay = `${cmd.label} ${cmd.section} ${cmd.keywords || ''}`.toLowerCase();
  return q.split(/\s+/).every(w => hay.includes(w));
}

function render() {
  const q = input.value.trim().toLowerCase();
  filtered = commands.filter(c => matchFilter(c, q));

  // Group by section, preserving registration order
  const sections = [];
  const seen = new Set();
  for (const cmd of filtered) {
    if (!seen.has(cmd.section)) { seen.add(cmd.section); sections.push(cmd.section); }
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div class="cmdk-empty">No matching actions</div>';
    return;
  }

  let html = '';
  let flatIdx = 0;
  for (const sec of sections) {
    html += `<div class="cmdk-section-header">${sec}</div>`;
    for (const cmd of filtered) {
      if (cmd.section !== sec) continue;
      const sc = cmd.shortcut
        ? `<span class="cmdk-row-shortcut">${cmd.shortcut.split('+').map(k => `<kbd>${k.trim()}</kbd>`).join('')}</span>`
        : '';
      html += `<button class="cmdk-row${flatIdx === activeIdx ? ' active' : ''}" data-cmdk-idx="${flatIdx}">
        <span class="cmdk-row-icon"><svg class="ico"><use href="icons.svg#${cmd.icon}"/></svg></span>
        <span class="cmdk-row-label">${cmd.label}</span>
        ${sc}
      </button>`;
      flatIdx++;
    }
  }
  list.innerHTML = html;
}

function scrollActive() {
  const el = list.querySelector('.cmdk-row.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function execActive() {
  const cmd = filtered[activeIdx];
  if (cmd) {
    closePalette();
    cmd.action();
  }
}

// Global ⌘K / Ctrl+K
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    toggle();
    return;
  }
  if (!isOpen()) return;

  if (e.key === 'Escape') { e.stopPropagation(); closePalette(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); render(); scrollActive(); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); render(); scrollActive(); return; }
  if (e.key === 'Enter')     { e.preventDefault(); execActive(); return; }
}, true);

// Type to filter
input.addEventListener('input', () => { activeIdx = 0; render(); });

// Click row
list.addEventListener('click', (e) => {
  const row = e.target.closest('.cmdk-row');
  if (row) { activeIdx = +row.dataset.cmdkIdx; execActive(); }
});

// Mouse hover syncs active index
list.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.cmdk-row');
  if (row) {
    const idx = +row.dataset.cmdkIdx;
    if (idx !== activeIdx) { activeIdx = idx; render(); }
  }
});

// Backdrop click to close
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closePalette(); });
dialog.addEventListener('click', (e) => e.stopPropagation());

// Sidebar search button
const sidebarBtn = $('btn-cmdk-open');
if (sidebarBtn) sidebarBtn.addEventListener('click', openPalette);
