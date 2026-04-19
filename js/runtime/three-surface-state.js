import { state } from '../state.js';
import { syncViewerRuntimeSession } from './viewer-session.js';
import { setSpinnerPending } from '../spinner.js';

export function isThreeSurfaceActive() {
  return state.mode === '3d' || state.mode === 'mpr3d';
}

// Shape: { pending: true, stage: "quality-ready" } while 3D overlays are still warming.
export function syncThreeSurfaceState(series = state.manifest?.series?.[state.seriesIdx]) {
  const session = syncViewerRuntimeSession(series);
  // Shape: { threeReady: true, mprReady: false } once the active surface is already visible.
  const pending = state.mode === '3d'
    ? !session?.readiness?.threeReady
    : state.mode === 'mpr3d'
      ? (!session?.readiness?.threeReady && !session?.readiness?.mprReady)
      : false;
  setSpinnerPending('three-surface', pending);
  return { pending, stage: session?.readiness?.stage || 'idle' };
}
