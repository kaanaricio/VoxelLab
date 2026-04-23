import * as THREE from './vendor-three.js';

import { $ } from './dom.js';
import { renderInspectionReadout, resolveVoxelInspection } from './inspection-readout.js';
import { state } from './state.js';
import { getThreeRuntime } from './runtime/viewer-runtime.js';

let _hideHover = () => {};

export function initVolume3DHover(deps) {
  _hideHover = deps.hideHover;
}

const _hoverRay = new THREE.Raycaster();
const _hoverNDC = new THREE.Vector2();
const _hoverInvMat = new THREE.Matrix4();

/**
 * CPU ray march for 3D hover tooltip: intensity, mm coords, region, tissue.
 */
export function show3DHover(ev, renderer, camera) {
  const three = getThreeRuntime();
  if (!three.mesh) { _hideHover(); return; }
  const hr = state.hrVoxels;
  const vox = state.voxels;
  if (!hr && !vox) { _hideHover(); return; }
  const series = state.manifest.series[state.seriesIdx];
  const W = series.width, H = series.height, D = series.slices;
  const WH = W * H;
  const mesh = three.mesh;

  const rect = renderer.domElement.getBoundingClientRect();
  _hoverNDC.set(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );
  _hoverRay.setFromCamera(_hoverNDC, camera);
  const ray = _hoverRay.ray;

  _hoverInvMat.copy(mesh.matrixWorld).invert();
  const oOrigin = ray.origin.clone().applyMatrix4(_hoverInvMat);
  const oDir = ray.direction.clone().transformDirection(_hoverInvMat).normalize();

  const bmin = -0.5, bmax = 0.5;
  const idx = 1 / oDir.x, idy = 1 / oDir.y, idz = 1 / oDir.z;
  const t1x = (bmin - oOrigin.x) * idx, t2x = (bmax - oOrigin.x) * idx;
  const t1y = (bmin - oOrigin.y) * idy, t2y = (bmax - oOrigin.y) * idy;
  const t1z = (bmin - oOrigin.z) * idz, t2z = (bmax - oOrigin.z) * idz;
  const tmin = Math.max(Math.min(t1x, t2x), Math.min(t1y, t2y), Math.min(t1z, t2z));
  const tmax = Math.min(Math.max(t1x, t2x), Math.max(t1y, t2y), Math.max(t1z, t2z));
  if (tmin > tmax || tmax < 0) { _hideHover(); return; }

  const steps = 100;
  const tStart = Math.max(tmin, 0);
  const dt = (tmax - tStart) / steps;

  for (let i = 0; i < steps; i++) {
    const t = tStart + i * dt;
    const tx = oOrigin.x + oDir.x * t + 0.5;
    const ty = oOrigin.y + oDir.y * t + 0.5;
    const tz = oOrigin.z + oDir.z * t + 0.5;
    if (tx < 0 || tx > 1 || ty < 0 || ty > 1 || tz < 0 || tz > 1) continue;

    const vx = Math.min(W - 1, Math.max(0, Math.round(tx * (W - 1))));
    const vy = Math.min(H - 1, Math.max(0, Math.round(ty * (H - 1))));
    const vz = Math.min(D - 1, Math.max(0, Math.round(tz * (D - 1))));
    const vi = vz * WH + vy * W + vx;

    let normVal;
    if (hr && hr.length === W * H * D) {
      normVal = hr[vi];
    } else {
      normVal = (vox[vi] || 0) / 255;
    }
    if (normVal < state.lowT || normVal > state.highT || normVal < 0.005) continue;

    const inspection = resolveVoxelInspection(series, vx, vy, vz, { intensity: Math.round(normVal * 255) });

    const hov = $('hover-readout');
    hov.innerHTML = renderInspectionReadout(inspection, { coordLabel: 'vx', includeSlice: true });
    hov.classList.add('visible');
    const wrap = $('canvas-wrap').getBoundingClientRect();
    let hx = ev.clientX - wrap.left + 14, hy = ev.clientY - wrap.top + 14;
    if (hx + hov.offsetWidth > wrap.width - 8) hx = ev.clientX - wrap.left - hov.offsetWidth - 10;
    if (hy + hov.offsetHeight > wrap.height - 8) hy = ev.clientY - wrap.top - hov.offsetHeight - 10;
    hov.style.left = hx + 'px'; hov.style.top = hy + 'px';
    return;
  }
  _hideHover();
}
