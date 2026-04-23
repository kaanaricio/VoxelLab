// Shape: { name: "select-series-2d", detail: { slug: "brain_ax_t1" }, duration: 42.6 }.
//
// Small devtools/test-only perf ledger. The viewer records a few key
// first-paint spans here so Playwright can assert that we still hit the same
// runtime milestones after performance work lands.

const MAX_EVENTS = 128;
const _pending = new Map();
const _history = [];
let _seq = 0;

function now() {
  if (globalThis.performance?.now) return globalThis.performance.now();
  return Date.now();
}

function mark(name) {
  try { globalThis.performance?.mark?.(name); } catch {}
}

function measure(name, start, end) {
  try { globalThis.performance?.measure?.(name, start, end); } catch {}
}

function writeGlobal() {
  // Shape: window.__voxellabPerf = { history: [...], pending: [{ name, count }] }.
  globalThis.__voxellabPerf = {
    history: _history.slice(),
    pending: [..._pending.entries()].map(([name, queue]) => ({ name, count: queue.length })),
    clear: clearPerfTraceHistory,
  };
}

function queueFor(name) {
  let queue = _pending.get(name);
  if (!queue) {
    queue = [];
    _pending.set(name, queue);
  }
  return queue;
}

export function beginPerfTrace(name, detail = {}) {
  const id = `voxellab:${name}:${++_seq}`;
  queueFor(name).push({
    id,
    name,
    detail,
    startTime: now(),
  });
  mark(`${id}:start`);
  writeGlobal();
  return id;
}

export function hasPendingPerfTrace(name) {
  return !!_pending.get(name)?.length;
}

export function dropPendingPerfTraces(names = []) {
  for (const name of names) _pending.delete(name);
  writeGlobal();
}

export function endPerfTrace(name, detail = {}) {
  const queue = _pending.get(name);
  const entry = queue?.shift();
  if (!entry) return null;
  if (!queue.length) _pending.delete(name);
  const endMark = `${entry.id}:end`;
  mark(endMark);
  measure(entry.name, `${entry.id}:start`, endMark);
  const event = {
    name: entry.name,
    startTime: entry.startTime,
    duration: Math.max(0, now() - entry.startTime),
    detail: { ...entry.detail, ...detail },
  };
  _history.push(event);
  if (_history.length > MAX_EVENTS) _history.splice(0, _history.length - MAX_EVENTS);
  writeGlobal();
  return event;
}

export function clearPerfTraceHistory() {
  _pending.clear();
  _history.length = 0;
  writeGlobal();
}

writeGlobal();
