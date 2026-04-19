import { batch, state } from '../state.js';
import { beginPerfTrace, dropPendingPerfTraces, endPerfTrace, hasPendingPerfTrace } from '../perf-trace.js';
import { activeOverlayStateForSeries } from './active-overlay-state.js';
import { overlaySessionForSeries, hasHrVolume, reviewReadinessForSeries } from './review-readiness.js';
import {
  createViewerSessionState,
  VIEWER_SESSION_STAGE_ORDER,
} from './viewer-session-shape.js';

const PERF_NAMES = [
  'runtime-first-slice',
  'runtime-base-volume-ready',
  'runtime-overlay-ready',
  'runtime-quality-ready',
  'runtime-3d-ready',
];

function overlayKindsForSeries(series) {
  const active = activeOverlayStateForSeries(series);
  const kinds = createViewerSessionState().overlayKinds;
  for (const kind of Object.keys(kinds)) {
    kinds[kind].available = !!active[kind]?.available;
    kinds[kind].enabled = !!active[kind]?.enabled;
    kinds[kind].ready = !!active[kind]?.ready;
  }
  return kinds;
}

function stageForReadiness(readiness) {
  let stage = 'idle';
  if (readiness.firstSlice) stage = 'first-slice';
  if (readiness.baseVolume) stage = 'base-volume';
  if (readiness.orthogonalReady) stage = 'orthogonal-ready';
  if (readiness.overlayReady) stage = 'overlay-ready';
  if (readiness.qualityReady) stage = 'quality-ready';
  if (readiness.threeReady && readiness.overlayReady) stage = '3d-ready';
  return stage;
}

function stageRank(stage) {
  return VIEWER_SESSION_STAGE_ORDER.indexOf(stage);
}

function syncStagePerf(stage, detail) {
  const stages = [
    ['first-slice', 'runtime-first-slice'],
    ['base-volume', 'runtime-base-volume-ready'],
    ['overlay-ready', 'runtime-overlay-ready'],
    ['quality-ready', 'runtime-quality-ready'],
    ['3d-ready', 'runtime-3d-ready'],
  ];
  for (const [targetStage, perfName] of stages) {
    if (stageRank(stage) >= stageRank(targetStage) && hasPendingPerfTrace(perfName)) {
      endPerfTrace(perfName, detail);
    }
  }
}

function startRuntimePerf(session) {
  dropPendingPerfTraces(PERF_NAMES);
  const detail = { slug: session.slug, requestId: session.requestId };
  for (const name of PERF_NAMES) beginPerfTrace(name, detail);
}

// Shape: { stage: "overlay-ready", baseSource: "hr", overlayKinds: { labels: ... } }.
export function syncViewerRuntimeSession(series = state.manifest?.series?.[state.seriesIdx]) {
  const session = state.viewerSession;
  if (!series || session.slug !== series.slug) return session;
  const overlayKinds = overlayKindsForSeries(series);
  const overlaySession = overlaySessionForSeries(series);
  const readiness = reviewReadinessForSeries(series, { overlaySession });
  const stage = stageForReadiness(readiness);
  batch(() => {
    session.seriesIdx = state.seriesIdx;
    session.baseSource = hasHrVolume(series) ? 'raw' : readiness.baseVolume ? 'png-stack' : '';
    session.firstSliceIdx = readiness.firstSlice ? state.sliceIdx : -1;
    session.overlayKinds = overlayKinds;
    session.overlaySession = overlaySession;
    session.readiness = { ...readiness, stage };
  });
  syncStagePerf(stage, { slug: session.slug, requestId: session.requestId });
  return session;
}

// Shape: { slug: "brain_ax_t1", requestId: 7, readiness: { stage: "idle" } }.
export function beginViewerRuntimeSession(series, { seriesIdx = state.seriesIdx, requestId = state.selectRequestId } = {}) {
  const next = createViewerSessionState({
    slug: String(series?.slug || ''),
    seriesIdx,
    requestId,
  });
  batch(() => {
    state.viewerSession = next;
  });
  startRuntimePerf(next);
  return syncViewerRuntimeSession(series);
}

export function resetViewerRuntimeSession() {
  dropPendingPerfTraces(PERF_NAMES);
  state.viewerSession = createViewerSessionState();
  return state.viewerSession;
}
