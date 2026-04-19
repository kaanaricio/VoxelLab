// Global viewer state. Single source of truth, now wrapped in an
// observable proxy so renderers can subscribe instead of relying on
// every mutation site to remember a redraw call.

import { APP_ALIASES, APP_ROOT_KEYS, createInitialAppModel } from './state/app-model.js';
import { RUNTIME_ROOT_KEYS, createInitialRuntimeState } from './state/runtime-state.js';

// Local-backend detection. This controls browser features that depend on
// same-origin helper APIs such as `/api/analyze`, `/api/ask`, and `/api/consult`.
// Static/public builds can still load committed sidecars and remote assets.
//
// Preferred manual override: `?localBackend=1` or `?localBackend=0`.
// Legacy alias kept for compatibility: `?hosted=0|1`, where `hosted=1`
// maps to `localBackend=0`.
function parseBooleanQuery(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function hostnameLooksLocal(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  if (!value) return true;
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(value)) return true;
  if (value.endsWith('.local')) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(value)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(value)) return true;
  const private172 = value.match(/^172\.(\d{1,3})(?:\.\d{1,3}){2}$/);
  if (private172) {
    const secondOctet = Number(private172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return false;
}

// Shape: { search: "?localBackend=1", hostname: "localhost" } in browser, blank in Node tests.
const _location = typeof location === 'object' && location
  ? location
  : { search: '', hostname: '' };
const _query = new URLSearchParams(_location.search);
const _forcedLocalBackend = parseBooleanQuery(_query.get('localBackend'));
const _legacyHosted = parseBooleanQuery(_query.get('hosted'));
export const HAS_LOCAL_BACKEND = _forcedLocalBackend != null
  ? _forcedLocalBackend
  : _legacyHosted != null
  ? !_legacyHosted
  : hostnameLooksLocal(_location.hostname);

// Extends APP_ALIASES with runtime image stack roots (segImgs, …).
const ALIASES = {
  ...APP_ALIASES,
  segImgs: 'segImgs',
  segVoxels: 'segVoxels',
  symImgs: 'symImgs',
  symVoxels: 'symVoxels',
  regionImgs: 'regionImgs',
  regionVoxels: 'regionVoxels',
  fusionImgs: 'fusionImgs',
  fusionVoxels: 'fusionVoxels',
};

const ALIAS_ENTRIES = Object.entries(ALIASES).map(([key, path]) => [key, path.split('.')]);
const listeners = new Map();
const proxyCache = new WeakMap();
const proxyTargets = new WeakMap();
const pending = new Set();
// Skip nested proxying for compare peer stacks.
const PASSTHROUGH_ROOT_KEYS = new Set(['cmpStacks']);

let batchDepth = 0;
let flushing = false;

const appRaw = createInitialAppModel();
const runtimeRaw = createInitialRuntimeState();

function createLinkedRaw() {
  const linked = {};
  const roots = new Set([
    ...Object.keys(appRaw),
    ...Object.keys(runtimeRaw),
  ]);
  for (const key of roots) {
    const source = APP_ROOT_KEYS.has(key) ? appRaw : runtimeRaw;
    Object.defineProperty(linked, key, {
      configurable: true,
      enumerable: true,
      get: () => source[key],
      set: (value) => { source[key] = value; },
    });
  }
  return linked;
}

const raw = createLinkedRaw();

function isObject(value) {
  return value != null && typeof value === 'object';
}

function isProxyable(value) {
  if (!isObject(value)) return false;
  return Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
}

function toPath(key) {
  if (Array.isArray(key)) return key.map(String);
  const parts = String(key).split('.');
  const alias = ALIASES[parts[0]];
  if (!alias) return parts;
  return [...alias.split('.'), ...parts.slice(1)];
}

function resolvePath(path) {
  const rootKey = path[0];
  if (RUNTIME_ROOT_KEYS.has(rootKey)) {
    return { target: runtimeRaw, path };
  }
  return { target: appRaw, path };
}

function getAtPath(target, path) {
  if (target === raw) {
    const resolved = resolvePath(path);
    return getAtPath(resolved.target, resolved.path);
  }
  let cur = target;
  for (const part of path) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setAtPath(target, path, value) {
  if (target === raw) {
    const resolved = resolvePath(path);
    return setAtPath(resolved.target, resolved.path, value);
  }
  const parent = getAtPath(target, path.slice(0, -1));
  const key = path[path.length - 1];
  if (!parent) return false;
  const next = unwrap(value);
  if (Object.is(parent[key], next)) return true;
  parent[key] = next;
  markChanged(path);
  return true;
}

function deleteAtPath(target, path) {
  if (target === raw) {
    const resolved = resolvePath(path);
    return deleteAtPath(resolved.target, resolved.path);
  }
  const parent = getAtPath(target, path.slice(0, -1));
  const key = path[path.length - 1];
  if (!parent || !(key in parent)) return true;
  delete parent[key];
  markChanged(path);
  return true;
}

function unwrap(value) {
  return proxyTargets.get(value) || value;
}

function matchAlias(path, aliasPath) {
  if (path.length < aliasPath.length) return null;
  for (let i = 0; i < aliasPath.length; i++) {
    if (path[i] !== aliasPath[i]) return null;
  }
  return path.slice(aliasPath.length);
}

function expandKeys(path) {
  const keys = new Set();
  const direct = path.join('.');
  for (let i = path.length; i > 0; i--) {
    keys.add(path.slice(0, i).join('.'));
  }
  keys.add(direct);
  for (const [alias, aliasPath] of ALIAS_ENTRIES) {
    const suffix = matchAlias(path, aliasPath);
    if (!suffix) continue;
    keys.add(alias);
    if (suffix.length) keys.add(`${alias}.${suffix.join('.')}`);
  }
  return keys;
}

function markChanged(path) {
  pending.add(path.join('.'));
  if (batchDepth === 0) flush();
}

function flush() {
  if (flushing || batchDepth > 0) return;
  flushing = true;
  try {
    while (pending.size) {
      const changed = [...pending];
      pending.clear();
      const notifyKeys = new Set();
      for (const key of changed) {
        for (const expanded of expandKeys(key.split('.'))) notifyKeys.add(expanded);
      }
      for (const key of notifyKeys) {
        const subs = listeners.get(key);
        if (!subs || subs.size === 0) continue;
        const value = getAtPath(raw, toPath(key));
        for (const fn of [...subs]) {
          try {
            fn(value, key);
          } catch (err) {
            console.error(`[state:${key}]`, err);
          }
        }
      }
    }
  } finally {
    flushing = false;
  }
}

function createProxy(target, path = []) {
  if (!isProxyable(target)) return target;
  if (proxyCache.has(target)) return proxyCache.get(target);

  const proxy = new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key === 'string' && path.length === 0 && ALIASES[key]) {
        return createProxy(getAtPath(raw, ALIASES[key].split('.')), toPath(key));
      }
      if (typeof key === 'string' && path.length === 0 && (key.startsWith('_') || PASSTHROUGH_ROOT_KEYS.has(key))) {
        return Reflect.get(obj, key, receiver);
      }
      return createProxy(Reflect.get(obj, key, receiver), [...path, String(key)]);
    },
    set(obj, key, value) {
      if (typeof key === 'string' && path.length === 0 && ALIASES[key]) {
        return setAtPath(raw, ALIASES[key].split('.'), value);
      }
      const next = unwrap(value);
      if (Object.is(obj[key], next)) return true;
      obj[key] = next;
      markChanged([...path, String(key)]);
      return true;
    },
    deleteProperty(obj, key) {
      if (typeof key === 'string' && path.length === 0 && ALIASES[key]) {
        return deleteAtPath(raw, ALIASES[key].split('.'));
      }
      if (!(key in obj)) return true;
      delete obj[key];
      markChanged([...path, String(key)]);
      return true;
    },
  });

  proxyCache.set(target, proxy);
  proxyTargets.set(proxy, target);
  return proxy;
}

function cloneValue(value, seen = new WeakMap()) {
  if (!isObject(value)) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(cloneValue(item, seen));
    return out;
  }
  if (value instanceof Set) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(cloneValue(item, seen));
    return out;
  }
  if (value instanceof Map) {
    const out = {};
    seen.set(value, out);
    for (const [key, child] of value) out[String(key)] = cloneValue(child, seen);
    return out;
  }
  if (ArrayBuffer.isView(value)) return { type: value.constructor.name, length: value.length };
  if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength };
  if (value instanceof Date) return value.toISOString();
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const out = {};
  seen.set(value, out);
  for (const [key, child] of Object.entries(value)) out[key] = cloneValue(child, seen);
  return out;
}

function buildSnapshot() {
  const snapshot = cloneValue(appRaw);
  snapshot.voxels = cloneValue(runtimeRaw.voxels);
  snapshot.voxelsKey = runtimeRaw.voxelsKey;
  snapshot.cmpStacks = cloneValue(runtimeRaw.cmpStacks);
  snapshot.viewerSession = cloneValue(runtimeRaw.viewerSession);
  snapshot.segImgs = cloneValue(runtimeRaw.segImgs);
  snapshot.symImgs = cloneValue(runtimeRaw.symImgs);
  snapshot.regionImgs = cloneValue(runtimeRaw.regionImgs);
  snapshot.fusionImgs = cloneValue(runtimeRaw.fusionImgs);
  snapshot.hrVoxels = cloneValue(runtimeRaw.hrVoxels);
  snapshot.hrKey = runtimeRaw.hrKey;
  return snapshot;
}

function deepFreeze(value) {
  if (!isObject(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const state = createProxy(raw);

/** Subscribe to a state key or namespace path and receive `(value, key)` on changes. */
export function subscribe(key, fn) {
  const name = String(key);
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name)?.delete(fn);
}

/** Batch synchronous or async state writes and flush subscriptions once at the end. */
export function batch(fn) {
  batchDepth++;
  const finish = () => {
    batchDepth = Math.max(0, batchDepth - 1);
    if (batchDepth === 0) flush();
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(finish);
    }
    finish();
    return result;
  } catch (err) {
    finish();
    throw err;
  }
}

/** Set one entry inside a passthrough root bucket and notify subscribers. */
export function setPassthroughRootEntry(rootKey, entryKey, value) {
  const bucket = RUNTIME_ROOT_KEYS.has(rootKey) ? runtimeRaw[rootKey] : appRaw[rootKey];
  if (!bucket || typeof bucket !== 'object') return false;
  const next = unwrap(value);
  if (Object.is(bucket[entryKey], next)) return true;
  bucket[entryKey] = next;
  markChanged([String(rootKey), String(entryKey)]);
  return true;
}

/** Delete one entry inside a passthrough root bucket and notify subscribers. */
export function deletePassthroughRootEntry(rootKey, entryKey) {
  const bucket = RUNTIME_ROOT_KEYS.has(rootKey) ? runtimeRaw[rootKey] : appRaw[rootKey];
  if (!bucket || typeof bucket !== 'object' || !(entryKey in bucket)) return true;
  delete bucket[entryKey];
  markChanged([String(rootKey), String(entryKey)]);
  return true;
}

/** Return a deep-frozen snapshot that plugins and tests can read without mutating live state. */
export function getStateSnapshot() {
  const snapshot = buildSnapshot();
  for (const [alias, path] of ALIAS_ENTRIES) {
    snapshot[alias] = cloneValue(getAtPath(raw, path));
  }
  return deepFreeze(snapshot);
}
