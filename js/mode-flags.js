// Single place for compound display-mode checks (2D / MPR / MPR+3D / 3D).
import { state } from './state.js';

export function isMprActive() {
  return state.mode === 'mpr' || state.mode === 'mpr3d';
}

export function is3dActive() {
  return state.mode === '3d' || state.mode === 'mpr3d';
}
