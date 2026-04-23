// Projects sidebar (folders, pins, DnD, menus). Persistence: projects-store.js.

import { $, escapeHtml } from './dom.js';
import { imageUrlForStack } from './series-image-stack.js';
import { state } from './state.js';
import { syncSeriesIdxForActiveSlug } from './state/viewer-commands.js';
import {
  assignSeriesSlugsToProject,
  createProjectRecord,
  deleteProject,
  expandFolderForSeriesSlug,
  getAllProjects,
  getPinnedSlugs,
  renameProjectRecord,
  swapFolderOrder,
  togglePinSlug,
  toggleProjectCollapsedState,
} from './projects-store.js';

const INTERACTIVE_UI_BLOCKING_ESCAPE =
  '.cmdk-backdrop.open, #annot-modal.visible, #ask-modal.visible, #consult-modal.visible, #upload-modal.visible, #confirm-modal.visible, #help-modal.visible';

const SORT_POPOVER_OPTIONS = [
  { label: 'Name A→Z', key: 'name-asc' },
  { label: 'Name Z→A', key: 'name-desc' },
  { label: 'Study type', key: 'study-type' },
  { label: 'Slices ↑', key: 'slices-asc' },
  { label: 'Slices ↓', key: 'slices-desc' },
];

const PIN_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>
</svg>`;

let _onUpdate = () => {};
const _multiSel = new Set();
let _lastClickedSlug = null;
let _flatOrder = [];
let _selectSeries = () => {};

export function initProjects({ onUpdate, selectSeries }) {
  _onUpdate = onUpdate;
  _selectSeries = selectSeries;
}

export function notifyProjectsChanged(currentSeriesIdx) {
  _onUpdate(currentSeriesIdx);
}

export async function createProject(name) {
  const project = await createProjectRecord(name);
  _onUpdate();
  return project;
}

export async function renameProject(id, name) {
  if (await renameProjectRecord(id, name)) _onUpdate();
}

export async function removeProject(id) {
  await deleteProject(id);
  _onUpdate();
}

function setFolderSeriesRowsVisible(folderEl, visible) {
  folderEl.querySelectorAll(':scope > li').forEach((li) => {
    li.style.display = visible ? '' : 'none';
  });
}

// { "CT": true, ... } — which study-type buckets are collapsed (study-type sort only)
const STUDY_TYPE_COLLAPSED_KEY = 'mri-viewer/studyTypeCollapsed/v1';

function studyTypeCollapsedMap() {
  try {
    const raw = localStorage.getItem(STUDY_TYPE_COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistStudyTypeCollapsed(groupKey, collapsed) {
  const m = studyTypeCollapsedMap();
  if (collapsed) m[groupKey] = true;
  else delete m[groupKey];
  try {
    localStorage.setItem(STUDY_TYPE_COLLAPSED_KEY, JSON.stringify(m));
  } catch {
    /* ignore quota */
  }
}

function pruneStudyTypeCollapsed(liveKeys) {
  const m = studyTypeCollapsedMap();
  let changed = false;
  for (const k of Object.keys(m)) if (!liveKeys.has(k)) { delete m[k]; changed = true; }
  if (!changed) return;
  try {
    localStorage.setItem(STUDY_TYPE_COLLAPSED_KEY, JSON.stringify(m));
  } catch {
    /* ignore quota */
  }
}

export async function toggleProjectCollapsed(id) {
  const p = await toggleProjectCollapsedState(id);
  if (!p) return;
  const el = document.querySelector(`[data-project-id="${id}"]`);
  if (el) {
    if (p.collapsed) {
      el.classList.add('collapsed');
      setFolderSeriesRowsVisible(el, false);
      return;
    }
    if (el.querySelector(':scope > li')) {
      el.classList.remove('collapsed');
      setFolderSeriesRowsVisible(el, true);
      return;
    }
  }
  _onUpdate();
}

export async function expandFolderForSeries(slug) {
  await expandFolderForSeriesSlug(slug);
  _onUpdate();
}

export async function assignSeriesToProject(slugOrSlugs, projectId) {
  await assignSeriesSlugsToProject(slugOrSlugs, projectId);
  _multiSel.clear();
  _onUpdate();
}

export function togglePin(slug) {
  togglePinSlug(slug);
  _onUpdate();
}

function scheduleStudiesFadeIn(seriesList, pinnedList) {
  const fade = (el) => {
    if (!el) return;
    el.classList.remove('studies-fade-in');
    if (!el.querySelector('li[data-series-slug]')) return;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    void el.offsetWidth;
    requestAnimationFrame(() => {
      el.classList.add('studies-fade-in');
    });
  };
  fade(seriesList);
  fade(pinnedList);
}

export async function renderProjectsSidebar(manifest, currentSeriesIdx) {
  const list = $('series-list');
  if (!list) return;

  const pinnedList = $('pinned-list');
  const hadStudyRows =
    !!list.querySelector('li[data-series-slug]')
    || !!(pinnedList && pinnedList.querySelector('li[data-series-slug]'));

  _manifest = manifest;
  const activeSlug = manifest.series[currentSeriesIdx]?.slug || '';

  // Drop in-memory state for slugs no longer in the manifest (e.g. study switch).
  // Keyed by slug: _thumbCache holds pre-loaded Images, _multiSel holds multi-select.
  const liveSlugs = new Set(manifest.series.map(s => s.slug));
  for (const slug of _thumbCache.keys()) if (!liveSlugs.has(slug)) _thumbCache.delete(slug);
  for (const slug of _multiSel) if (!liveSlugs.has(slug)) _multiSel.delete(slug);

  const projects = await getAllProjects();
  const assignedSlugs = new Set();
  projects.forEach(p => p.seriesSlugs.forEach(s => assignedSlugs.add(s)));

  const unassigned = manifest.series.filter(s => !assignedSlugs.has(s.slug));

  list.innerHTML = '';
  _flatOrder = [];

  for (const project of projects) {
    const folder = document.createElement('div');
    folder.className = 'project-folder' + (project.collapsed ? ' collapsed' : '');
    folder.dataset.projectId = project.id;

    const header = document.createElement('div');
    header.className = 'project-header';
    header.innerHTML = `
      <span class="project-toggle">
        <svg class="toggle-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
        </svg>
        <svg class="toggle-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </span>
      <span class="project-name">${escapeForProjects(project.name)}</span>
      <button class="project-menu-btn" aria-label="Folder options">
        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
        </svg>
      </button>
    `;

    header.addEventListener('click', (e) => {
      if (e.target.closest('.project-menu-btn')) return;
      toggleProjectCollapsed(project.id);
    });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showFolderContextMenu(e.clientX, e.clientY, project);
    });

    const menuBtn = header.querySelector('.project-menu-btn');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = menuBtn.querySelector('.folder-menu');
      if (existing) {
        existing.remove();
        return;
      }
      showFolderMenu(menuBtn, project);
    });

    header.draggable = true;
    header.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-folder-id', project.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    folder.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-folder-id')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        folder.classList.add('drag-over');
      }
    });
    folder.addEventListener('dragleave', () => folder.classList.remove('drag-over'));
    folder.addEventListener('drop', async (e) => {
      folder.classList.remove('drag-over');
      const srcId = e.dataTransfer.getData('application/x-folder-id');
      if (!srcId || srcId === project.id) return;
      e.preventDefault();
      const ok = await swapFolderOrder(srcId, project.id);
      if (ok) _onUpdate();
    });

    folder.appendChild(header);

    if (!project.collapsed) {
      const seriesInFolder = project.seriesSlugs
        .map(slug => manifest.series.find(s => s.slug === slug))
        .filter(Boolean);
      if (_currentSort) sortSeriesArray(seriesInFolder, _currentSort);

      for (const s of seriesInFolder) {
        const li = createSeriesItem(s, s.slug === activeSlug, false);
        _flatOrder.push(s.slug);
        li.draggable = true;
        li.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', dragPayload(s.slug).join(','));
          e.dataTransfer.effectAllowed = 'move';
        });
        folder.appendChild(li);
      }
    }

    folder.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      folder.classList.add('drag-over');
    });
    folder.addEventListener('dragleave', () => folder.classList.remove('drag-over'));
    folder.addEventListener('drop', (e) => {
      e.preventDefault();
      folder.classList.remove('drag-over');
      const payload = e.dataTransfer.getData('text/plain');
      if (payload) assignSeriesToProject(payload.split(',').filter(Boolean), project.id);
    });

    list.appendChild(folder);
  }

  const pins = getPinnedSlugs();
  const pinnedSeries = pins
    .map(slug => manifest.series.find(s => s.slug === slug))
    .filter(Boolean);

  if (pinnedList) {
    pinnedList.innerHTML = '';
    for (const s of pinnedSeries) {
      const li = document.createElement('li');
      const pinnedClasses = ['pinned-row'];
      if (s.slug === activeSlug) pinnedClasses.push('active');
      if (_multiSel.has(s.slug)) pinnedClasses.push('multi-selected');
      li.className = pinnedClasses.join(' ');
      li.dataset.seriesSlug = s.slug;
      li.dataset.seriesSlices = s.slices;
      _flatOrder.push(s.slug);
      li.innerHTML = `
        <button class="pin-btn" aria-label="Unpin">${PIN_ICON_SVG}</button>
        <div class="sname">${escapeForProjects(s.name || '')}</div>
      `;
      li.querySelector('.pin-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        togglePin(s.slug);
      });
      li.addEventListener('mousedown', (e) => {
        if (e.shiftKey) e.preventDefault();
      });
      li.addEventListener('click', (e) => handleSeriesClick(e, s.slug));
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showSeriesContextMenu(e.clientX, e.clientY, s.slug);
      });
      pinnedList.appendChild(li);
    }
  }

  const pinnedSet = new Set(pins);
  const unpinned = unassigned.filter(s => !pinnedSet.has(s.slug));

  if (_currentSort) sortSeriesArray(unpinned, _currentSort);

  const collapsedStudy = studyTypeCollapsedMap();
  if (_currentSort === 'study-type') {
    const groups = [];
    let bucket = null;
    for (const s of unpinned) {
      const key = studyType(s);
      if (!bucket || bucket.key !== key) {
        bucket = { key, series: [] };
        groups.push(bucket);
      }
      bucket.series.push(s);
    }
    pruneStudyTypeCollapsed(new Set(groups.map(g => g.key)));
    for (const { key, series } of groups) {
      const collapsed = !!collapsedStudy[key];
      const wrap = document.createElement('div');
      wrap.className = 'study-type-group' + (collapsed ? ' collapsed' : '');
      wrap.dataset.studyTypeGroup = key;

      const header = document.createElement('div');
      header.className = 'study-type-header';
      header.setAttribute('role', 'button');
      header.setAttribute('tabindex', '0');
      header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      header.innerHTML = `
      <span class="project-toggle">
        <svg class="toggle-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
        </svg>
        <svg class="toggle-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </span>
      <span class="study-type-label">${escapeForProjects(key)}</span>
    `;
      header.addEventListener('click', (e) => {
        if (e.target.closest('a,button')) return;
        const willCollapse = !wrap.classList.contains('collapsed');
        wrap.classList.toggle('collapsed', willCollapse);
        setFolderSeriesRowsVisible(wrap, !willCollapse);
        persistStudyTypeCollapsed(key, willCollapse);
        header.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
      });
      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          header.click();
        }
      });

      wrap.appendChild(header);
      for (const s of series) {
        const li = createSeriesItem(s, s.slug === activeSlug, false);
        _flatOrder.push(s.slug);
        li.draggable = true;
        li.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', dragPayload(s.slug).join(','));
          e.dataTransfer.effectAllowed = 'move';
        });
        wrap.appendChild(li);
      }
      if (collapsed) setFolderSeriesRowsVisible(wrap, false);
      list.appendChild(wrap);
    }
  } else {
    for (const s of unpinned) {
      const li = createSeriesItem(s, s.slug === activeSlug, false);
      _flatOrder.push(s.slug);
      li.draggable = true;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', dragPayload(s.slug).join(','));
        e.dataTransfer.effectAllowed = 'move';
      });
      list.appendChild(li);
    }
  }

  const newBtn = $('btn-new-folder');
  if (newBtn && !newBtn._wired) {
    newBtn._wired = true;
    newBtn.addEventListener('click', () => createProject());
  }
  const sortBtn = $('btn-sort-studies');
  if (sortBtn && !sortBtn._wired) {
    sortBtn._wired = true;
    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showSortPopover(sortBtn, manifest);
    });
  }

  wireSeriesThumbnailTooltip();
  wireSidebarOnce();

  const hasStudyRows =
    !!list.querySelector('li[data-series-slug]')
    || !!(pinnedList && pinnedList.querySelector('li[data-series-slug]'));
  if (hasStudyRows && !hadStudyRows) {
    scheduleStudiesFadeIn(list, pinnedList);
  }
}

function wireSidebarOnce() {
  const aside = document.querySelector('aside.left');
  const scroll = document.querySelector('.series-scroll');
  if (!aside || !scroll || aside._wired) return;
  aside._wired = true;

  const clearMultiSel = () => {
    if (_multiSel.size === 0) return;
    _multiSel.clear();
    _lastClickedSlug = null;
    _onUpdate();
  };

  scroll.addEventListener('dragover', (e) => {
    if (e.target.closest('.project-folder')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  scroll.addEventListener('drop', (e) => {
    if (e.target.closest('.project-folder')) return;
    e.preventDefault();
    const payload = e.dataTransfer.getData('text/plain');
    if (payload) assignSeriesToProject(payload.split(',').filter(Boolean), null);
  });

  aside.addEventListener('contextmenu', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    showSidebarContextMenu(e.clientX, e.clientY);
  });

  aside.addEventListener('click', (e) => {
    if (e.target.closest('li[data-series-slug]')) return;
    clearMultiSel();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (document.querySelector(INTERACTIVE_UI_BLOCKING_ESCAPE)) return;
    clearMultiSel();
  });
}

function createSeriesItem(s, active, isPinned = false) {
  const li = document.createElement('li');
  const classes = [];
  if (active) classes.push('active');
  if (isPinned) classes.push('pinned');
  if (_multiSel.has(s.slug)) classes.push('multi-selected');
  li.className = classes.join(' ');
  li.dataset.seriesSlug = s.slug;
  li.dataset.seriesSlices = s.slices;
  li.innerHTML = `
    <div class="sname">${escapeForProjects(s.name || '')}</div>
    <div class="sdesc">${escapeForProjects(s.description || '')}</div>
    <button class="pin-btn" aria-label="${isPinned ? 'Unpin' : 'Pin'}">${PIN_ICON_SVG}</button>
  `;
  li.querySelector('.pin-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePin(s.slug);
  });
  li.addEventListener('mousedown', (e) => {
    if (e.shiftKey) e.preventDefault();
  });
  li.addEventListener('click', (e) => handleSeriesClick(e, s.slug));
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showSeriesContextMenu(e.clientX, e.clientY, s.slug);
  });
  return li;
}

function handleSeriesClick(e, slug) {
  if (e.metaKey || e.ctrlKey) {
    if (_multiSel.has(slug)) _multiSel.delete(slug);
    else _multiSel.add(slug);
    _lastClickedSlug = slug;
    _onUpdate();
    return;
  }
  if (e.shiftKey && _lastClickedSlug) {
    const a = _flatOrder.indexOf(_lastClickedSlug);
    const b = _flatOrder.indexOf(slug);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) _multiSel.add(_flatOrder[i]);
      _onUpdate();
      return;
    }
  }
  _multiSel.clear();
  _lastClickedSlug = slug;
  const nextIdx = state.manifest.series.findIndex(series => series.slug === slug);
  if (nextIdx >= 0) _selectSeries(nextIdx);
  document.querySelector('aside.left')?.classList.remove('mobile-open');
  document.getElementById('mobile-backdrop')?.classList.remove('visible');
}

function dragPayload(slug) {
  if (_multiSel.has(slug) && _multiSel.size > 1) return [..._multiSel];
  return [slug];
}

const _thumbCache = new Map();
let _manifest = null;

function wireSeriesThumbnailTooltip() {
  const tip = document.getElementById('series-thumb-tip');
  const scroll = document.querySelector('.series-scroll');
  if (!scroll || !tip || scroll._thumbWired) return;
  scroll._thumbWired = true;

  const img = tip.querySelector('img');
  const label = tip.querySelector('.thumb-label');
  let hideTimer = null;
  let currentSlug = null;

  scroll.addEventListener('mouseover', (e) => {
    const li = e.target.closest?.('li[data-series-slug]');
    if (!li) return;
    clearTimeout(hideTimer);
    if (li.dataset.seriesSlug === currentSlug) return;
    showThumb(li);
  });

  scroll.addEventListener('mouseout', (e) => {
    const li = e.target.closest?.('li[data-series-slug]');
    if (li) {
      hideTimer = setTimeout(hideThumb, 100);
    }
  });

  const sidebar = scroll.closest('aside');
  if (sidebar) {
    sidebar.addEventListener('mouseleave', () => {
      clearTimeout(hideTimer);
      hideThumb();
    });
  }

  function showThumb(li) {
    const slug = li.dataset.seriesSlug;
    const slices = parseInt(li.dataset.seriesSlices, 10) || 1;
    const midIdx = Math.floor(slices / 2);
    currentSlug = slug;

    const series = _manifest?.series?.find(s => s.slug === slug);
    const url = imageUrlForStack(slug, midIdx, series);

    if (_thumbCache.has(slug)) {
      img.src = _thumbCache.get(slug).src;
    } else {
      const cached = new Image();
      cached.src = url;
      _thumbCache.set(slug, cached);
      img.src = url;
    }

    label.textContent = `Slice ${midIdx + 1} / ${slices}`;

    const r = li.getBoundingClientRect();
    const asideEl = li.closest('aside');
    const sidebarRight = asideEl ? asideEl.getBoundingClientRect().right : r.right;
    tip.style.left = `${sidebarRight + 8}px`;
    tip.style.top = `${Math.max(8, r.top + r.height / 2 - 90)}px`;
    tip.classList.add('visible');
  }

  function hideThumb() {
    tip.classList.remove('visible');
    currentSlug = null;
  }
}

function showFolderMenu(anchor, project) {
  document.querySelectorAll('.folder-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'folder-menu popover-menu';

  const renameItem = document.createElement('div');
  renameItem.className = 'popover-item';
  renameItem.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
    </svg>
    <span>Rename</span>
  `;
  renameItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    showRenameDialog(project);
  });

  const deleteItem = document.createElement('div');
  deleteItem.className = 'popover-item danger';
  deleteItem.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
    </svg>
    <span>Delete</span>
  `;
  deleteItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    removeProject(project.id);
  });

  menu.appendChild(renameItem);
  menu.appendChild(deleteItem);

  anchor.classList.add('project-menu-anchor');
  menu.style.zIndex = '300';
  anchor.appendChild(menu);

  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function showRenameDialog(project) {
  const overlay = document.createElement('div');
  overlay.className = 'project-rename-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'project-rename-title');

  const card = document.createElement('div');
  card.className = 'project-rename-card';

  card.innerHTML = `
    <div id="project-rename-title" class="project-rename-title">Rename folder</div>
    <input type="text" class="project-rename-dialog-input" value="${escapeForProjects(project.name)}" />
    <div class="project-rename-actions">
      <button type="button" class="annot-btn rename-cancel">Cancel</button>
      <button type="button" class="annot-btn primary rename-save">Save</button>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const input = card.querySelector('input');
  input.focus();
  input.select();

  const close = () => overlay.remove();
  const save = async () => {
    const newName = input.value.trim();
    if (newName && newName !== project.name) {
      await renameProject(project.id, newName);
    }
    close();
  };

  card.querySelector('.rename-cancel').addEventListener('click', close);
  card.querySelector('.rename-save').addEventListener('click', () => void save());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    }
    if (e.key === 'Escape') close();
  });
}

let _currentSort = '';

function showSortPopover(anchor, manifest) {
  const existing = document.querySelector('.sort-popover');
  if (existing) {
    existing.remove();
    return;
  }

  const pop = document.createElement('div');
  pop.className = 'sort-popover popover-menu';
  pop.style.zIndex = '300';

  for (const opt of SORT_POPOVER_OPTIONS) {
    const item = document.createElement('div');
    item.className = 'popover-item';
    const isActive = _currentSort === opt.key;
    item.innerHTML = `
      <span class="popover-label-grow">${opt.label}</span>
      ${isActive ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
    `;
    item.addEventListener('click', () => {
      _currentSort = opt.key;
      sortManifestSeries(manifest, opt.key);
      pop.remove();
      _onUpdate();
    });
    pop.appendChild(item);
  }

  anchor.parentElement.classList.add('project-menu-anchor');
  anchor.parentElement.appendChild(pop);
  const close = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) {
      pop.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function showContextMenu(x, y, items) {
  document.querySelectorAll('.context-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'popover-menu context-menu';
  menu.style.cssText = `position:fixed; left:${x}px; top:${y}px; z-index:500;`;

  for (const it of items) {
    if (!it) {
      const sep = document.createElement('div');
      sep.className = 'popover-separator';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'popover-item' + (it.danger ? ' danger' : '');
    row.innerHTML = (it.icon ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${it.icon}</svg>` : '')
      + `<span>${it.label}</span>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      it.action();
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) menu.style.left = `${x - r.width}px`;
  if (r.bottom > window.innerHeight - 8) menu.style.top = `${y - r.height}px`;

  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', close);
      document.removeEventListener('contextmenu', onCtx);
    }
  };
  const onCtx = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', close);
      document.removeEventListener('contextmenu', onCtx);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', close);
    document.addEventListener('contextmenu', onCtx);
  }, 0);
  return menu;
}

const CTX_ICONS = {
  folderPlus: '<path d="M12 10v6M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  moveOut: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5V20"/>',
};

async function showSeriesContextMenu(x, y, slug) {
  if (!_multiSel.has(slug)) {
    _multiSel.clear();
    _multiSel.add(slug);
    _onUpdate();
  }
  const slugs = [..._multiSel];
  const count = slugs.length;
  const projects = await getAllProjects();
  const inFolder = projects.some(p => slugs.some(s => p.seriesSlugs.includes(s)));

  const items = [
    {
      label: count > 1 ? `New folder from ${count} items` : 'New folder from selection',
      icon: CTX_ICONS.folderPlus,
      action: async () => {
        const proj = await createProject();
        await assignSeriesToProject(slugs, proj.id);
      },
    },
  ];
  if (projects.length > 0) {
    for (const p of projects) {
      items.push({
        label: `Move to: ${p.name}`,
        icon: CTX_ICONS.folderPlus,
        action: () => assignSeriesToProject(slugs, p.id),
      });
    }
  }
  if (inFolder) {
    items.push({
      label: 'Remove from folder',
      icon: CTX_ICONS.moveOut,
      action: () => assignSeriesToProject(slugs, null),
    });
  }
  items.push(null);
  items.push({
    label: count === 1 && getPinnedSlugs().includes(slug) ? 'Unpin' : 'Pin',
    icon: CTX_ICONS.pin,
    action: () => {
      for (const s of slugs) togglePin(s);
    },
  });
  showContextMenu(x, y, items);
}

function showFolderContextMenu(x, y, project) {
  showContextMenu(x, y, [
    { label: 'Rename', icon: CTX_ICONS.pencil, action: () => showRenameDialog(project) },
    { label: 'New folder', icon: CTX_ICONS.folderPlus, action: () => createProject() },
    null,
    { label: 'Delete folder', icon: CTX_ICONS.trash, danger: true, action: () => removeProject(project.id) },
  ]);
}

function showSidebarContextMenu(x, y) {
  showContextMenu(x, y, [
    { label: 'New folder', icon: CTX_ICONS.folderPlus, action: () => createProject() },
  ]);
}

// DICOM modality code → display label. Non-obvious codes only; self-explanatory
// codes (CT, MR, US, etc.) pass through. Example: { PT: 'PET', CR: 'X-Ray' }
const MODALITY_LABEL = { PT: 'PET', NM: 'Nuclear Medicine', CR: 'X-Ray', DX: 'X-Ray', XA: 'Angiography' };

function studyType(s) {
  const mod = (s.modality || '').toUpperCase();
  return MODALITY_LABEL[mod] || mod || 'Other';
}

function sortSeriesArray(arr, key) {
  switch (key) {
    case 'name-asc': arr.sort((a, b) => (a.name || '').localeCompare(b.name || '')); break;
    case 'name-desc': arr.sort((a, b) => (b.name || '').localeCompare(a.name || '')); break;
    case 'study-type': arr.sort((a, b) => studyType(a).localeCompare(studyType(b))); break;
    case 'slices-asc': arr.sort((a, b) => (a.slices || 0) - (b.slices || 0)); break;
    case 'slices-desc': arr.sort((a, b) => (b.slices || 0) - (a.slices || 0)); break;
  }
}

function sortManifestSeries(manifest, key) {
  const activeSlug = manifest.series[state.seriesIdx]?.slug || '';
  sortSeriesArray(manifest.series, key);
  syncSeriesIdxForActiveSlug(manifest, activeSlug);
}

function escapeForProjects(s) {
  return escapeHtml(s);
}
