// IndexedDB + localStorage for project folders and pinned series (no DOM).

const DB_NAME = 'mri-viewer-projects';
const DB_VERSION = 1;
const STORE = 'projects';
const PIN_KEY = 'mri-viewer/pinned-series';

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getAllProjects() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => (a.order || 0) - (b.order || 0)));
    req.onerror = () => reject(req.error);
  });
}

export async function putProject(project) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put(project);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProject(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function getPinnedSlugs() {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
  } catch {
    return [];
  }
}

export function setPinnedSlugs(slugs) {
  localStorage.setItem(PIN_KEY, JSON.stringify(slugs));
}

export function togglePinSlug(slug) {
  const pins = getPinnedSlugs();
  const idx = pins.indexOf(slug);
  if (idx >= 0) pins.splice(idx, 1);
  else pins.push(slug);
  setPinnedSlugs(pins);
}

export async function createProjectRecord(name) {
  const projects = await getAllProjects();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const project = {
    id,
    name: name || 'New folder',
    color: '#888',
    order: projects.length,
    collapsed: false,
    seriesSlugs: [],
  };
  await putProject(project);
  return project;
}

export async function renameProjectRecord(id, name) {
  const projects = await getAllProjects();
  const p = projects.find(x => x.id === id);
  if (!p || p.name === name) return false;
  p.name = name;
  await putProject(p);
  return true;
}

export async function toggleProjectCollapsedState(id) {
  const projects = await getAllProjects();
  const p = projects.find(x => x.id === id);
  if (!p) return null;
  p.collapsed = !p.collapsed;
  await putProject(p);
  return p;
}

export async function expandFolderForSeriesSlug(slug) {
  const projects = await getAllProjects();
  const folder = projects.find(p => p.collapsed && p.seriesSlugs.includes(slug));
  if (folder) {
    folder.collapsed = false;
    await putProject(folder);
  }
}

export async function assignSeriesSlugsToProject(slugOrSlugs, projectId) {
  const slugs = Array.isArray(slugOrSlugs) ? slugOrSlugs : [slugOrSlugs];
  const projects = await getAllProjects();
  for (const p of projects) {
    const before = p.seriesSlugs.length;
    p.seriesSlugs = p.seriesSlugs.filter(s => !slugs.includes(s));
    if (p.seriesSlugs.length !== before) await putProject(p);
  }
  if (projectId) {
    const target = projects.find(x => x.id === projectId);
    if (target) {
      target.seriesSlugs.push(...slugs);
      await putProject(target);
    }
  }
}

export async function swapFolderOrder(srcId, dstId) {
  const all = await getAllProjects();
  const src = all.find(p => p.id === srcId);
  const dst = all.find(p => p.id === dstId);
  if (!src || !dst) return false;
  const tmp = src.order;
  src.order = dst.order;
  dst.order = tmp;
  await putProject(src);
  await putProject(dst);
  return true;
}
