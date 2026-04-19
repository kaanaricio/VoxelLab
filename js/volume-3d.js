import * as THREE from './vendor-three.js';

import { state } from './state.js';
import { initVolume3DHover } from './volume-3d-hover.js';
export { setThreeDView } from './volume-3d-views.js';
import { ensureThreeRenderer } from './volume-three-bootstrap.js';
import { updateLabelTexture } from './volume-label-overlay.js';
import { createVolumeRaycastMaterial } from './volume-raycast-material.js';
import { ensureVoxels, initEnsureVoxels } from './volume-voxels-ensure.js';
import { ensureHRVoxels, initHrVoxelsLoading } from './volume-hr-voxels.js';
import { effectiveSliceSpacing } from './mpr-geometry.js';
import { setClipRange } from './state/viewer-commands.js';
import { endPerfTrace, hasPendingPerfTrace } from './perf-trace.js';
import { initOverlayVolumes } from './overlay-volumes.js';
import {
  getThreeRuntime,
  setThreePreviewShown,
  setThreeRuntimeMesh,
} from './runtime/viewer-runtime.js';
import { syncThreeSurfaceState as syncThreeSurfaceReadiness } from './runtime/three-surface-state.js';
import { syncViewerRuntimeSession } from './runtime/viewer-session.js';

let _renderVolumes = () => {};
let _hideHover = () => {};
let _is3dActive = () => false;
let _isMprActive = () => false;
let _drawMPR = () => {};
let _updateClipReadouts = () => {};
const _maskedHrCache = new Map();

function requestThreeRender(reason = 'update', burstMs = 0) {
  getThreeRuntime().requestRender?.(reason, burstMs);
}

export function syncThreeSurfaceState(series = state.manifest?.series?.[state.seriesIdx]) {
  return syncThreeSurfaceReadiness(series);
}

/** Wire orchestration callbacks from `viewer.js` after the shared viewer functions exist. */
export function initVolume3D(deps) {
  _renderVolumes = deps.renderVolumes;
  _hideHover = deps.hideHover;
  _is3dActive = deps.is3dActive;
  _isMprActive = deps.isMprActive;
  _drawMPR = deps.drawMPR;
  _updateClipReadouts = deps.updateClipReadouts;

  initEnsureVoxels({ renderVolumes: deps.renderVolumes });
  initVolume3DHover({ hideHover: deps.hideHover });
  initHrVoxelsLoading({
    is3dActive: deps.is3dActive,
    isMprActive: deps.isMprActive,
    drawMPR: deps.drawMPR,
    rebuildVolume: buildVolume,
  });
  initOverlayVolumes({
    onReady: () => {
      if (_isMprActive()) _drawMPR();
      if (_is3dActive()) buildVolume();
      _renderVolumes();
      syncThreeSurfaceState();
    },
  });
}

export { ensureVoxels, ensureHRVoxels };

// When scrubbing in 3D mode, cut the volume at the current slice (Z) so the
// slider dissects the brain depth-wise. Mirror also moves clipMax[2].
/** Mirror the 2D slice scrubber onto the 3D clip plane while 3D mode is active. */
export function sync3DScrubber() {
  if (!_is3dActive()) return;
  const series = state.manifest.series[state.seriesIdx];
  const cz = (state.sliceIdx + 1) / series.slices;
  setClipRange(state.clipMin, [
    state.clipMax[0],
    state.clipMax[1],
    Math.max(state.clipMin[2] + 0.001, Math.min(1, cz)),
  ]);
  requestThreeRender('slice-scrub', 120);
}

/** Push threshold, intensity, clip, and render-mode changes into the live raycast uniforms. */
export function updateUniforms() {
  const three = getThreeRuntime();
  if (!three.mesh) return;
  const u = three.mesh.material.uniforms;
  u.uLowT.value = state.lowT;
  u.uHighT.value = state.highT;
  u.uIntensity.value = state.intensity;
  u.uClipMin.value.fromArray(state.clipMin);
  u.uClipMax.value.fromArray(state.clipMax);
  if (u.uMode) {
    u.uMode.value = state.renderMode === 'mip' ? 1 : state.renderMode === 'minip' ? 2 : 0;
  }
  requestThreeRender('uniforms', 120);
}

/** Ensure the Three.js renderer shell exists before any volume upload begins. */
export function ensureThree() {
  ensureThreeRenderer({
    is3dActive: _is3dActive,
    hideHover: _hideHover,
  });
  requestThreeRender('ensure-three', 160);
}

/** Build or reuse the active 3D volume texture from PNG voxels or HR raw data. */
export async function buildVolume() {
  const three = getThreeRuntime();
  if (!three.renderer) return;
  const variant = state.useBrain ? 'brain' : 'base';
  const series = state.manifest.series[state.seriesIdx];
  const W = series.width, H = series.height, D = series.slices;

  // Optional small preview raw: show first, then replace with full-res from R2.
  if (series.hasPreview && series.previewDims && !three.previewShown) {
    try {
      const [pw, ph, pd] = series.previewDims;
      const r = await fetch(`./data/${series.slug}_preview.raw`);
      if (r.ok) {
        const buf = await r.arrayBuffer();
        const preview = new Uint8Array(buf);
        if (preview.length === pw * ph * pd) {
          uploadVolumeTexture(preview, THREE.UnsignedByteType, pw, ph, pd, series);
          setThreePreviewShown(true);
          // Continue to load full-res below (don't return)
        }
      }
    } catch { /* preview failed — fall through to full-res */ }
  }

  if (!ensureVoxels()) {
    syncThreeSurfaceState(series);
    return;
  }

  let volumeData = state.voxels;
  let textureType = THREE.UnsignedByteType;
  let dataKey = `vox:${state.voxelsKey}`;

  const hr = await ensureHRVoxels();
  if (hr) {
    const applyMask = state.useBrain && state.voxels && state.voxels.length === hr.length;
    if (applyMask) {
      const maskKey = `${series.slug}|${state.hrKey}|${state.voxelsKey}|brain`;
      let masked = _maskedHrCache.get(maskKey);
      if (!masked) {
        masked = new Float32Array(hr.length);
        const mask = state.voxels;
        for (let i = 0; i < hr.length; i++) masked[i] = mask[i] === 0 ? 0 : hr[i];
        _maskedHrCache.set(maskKey, masked);
      }
      volumeData = masked;
    } else {
      volumeData = hr;
    }
    textureType = THREE.FloatType;
    dataKey = `hr:${state.hrKey}`;
  }
  setThreePreviewShown(false); // full-res loaded, clear preview flag

  const nextDataKey = `${variant}|${dataKey}`;
  if (three.dataKey === nextDataKey && three.mesh) {
    updateLabelTexture();
    syncViewerRuntimeSession(series);
    syncThreeSurfaceState(series);
    requestThreeRender('reuse-volume', 120);
    return;
  }

  uploadVolumeTexture(volumeData, textureType, W, H, D, series, nextDataKey);
  syncThreeSurfaceState(series);
}

/** Upload a volume array as a 3D texture and create/replace the mesh. */
function uploadVolumeTexture(volumeData, textureType, W, H, D, series, dataKey = '') {
  const texture = new THREE.Data3DTexture(volumeData, W, H, D);
  texture.format = THREE.RedFormat;
  texture.type = textureType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  const sx = W * (series.pixelSpacing?.[1] || 1);
  const sy = H * (series.pixelSpacing?.[0] || 1);
  const sz = D * effectiveSliceSpacing(series);
  const m = Math.max(sx, sy, sz);

  const dummyLabel = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1);
  dummyLabel.format = THREE.RedFormat;
  dummyLabel.type = THREE.UnsignedByteType;
  dummyLabel.minFilter = THREE.NearestFilter;
  dummyLabel.magFilter = THREE.NearestFilter;
  dummyLabel.unpackAlignment = 1;
  dummyLabel.needsUpdate = true;

  const lutData = new Uint8Array(256 * 4);
  const lutTex = new THREE.DataTexture(
    lutData, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  lutTex.minFilter = THREE.NearestFilter;
  lutTex.magFilter = THREE.NearestFilter;
  lutTex.generateMipmaps = false;
  lutTex.needsUpdate = true;

  const material = createVolumeRaycastMaterial({
    texture,
    dummyLabel,
    lutTex,
    width: W,
    height: H,
    depth: D,
    lowT: state.lowT,
    highT: state.highT,
    intensity: state.intensity,
    clipMin: state.clipMin,
    clipMax: state.clipMax,
    renderMode: state.renderMode,
  });

  const three = getThreeRuntime();
  if (three.mesh) {
    three.scene.remove(three.mesh);
    three.mesh.geometry.dispose();
    const oldUni = three.mesh.material.uniforms;
    three.mesh.material.dispose();
    if (oldUni.uVolume   && oldUni.uVolume.value)   oldUni.uVolume.value.dispose();
    if (oldUni.uLabel    && oldUni.uLabel.value)    oldUni.uLabel.value.dispose();
    if (oldUni.uLabelLUT && oldUni.uLabelLUT.value) oldUni.uLabelLUT.value.dispose();
  }

  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geom, material);
  mesh.scale.set(sx / m, sy / m, sz / m);
  three.scene.add(mesh);
  setThreeRuntimeMesh(mesh, {
    seriesIdx: state.seriesIdx,
    variant: state.useBrain ? 'brain' : 'base',
    dataKey,
  });
  syncViewerRuntimeSession(series);
  sync3DScrubber();
  updateUniforms();
  updateLabelTexture();
  _updateClipReadouts();
  syncThreeSurfaceState(series);
  requestThreeRender('upload-volume', 220);
  if (hasPendingPerfTrace('enter-3d')) {
    endPerfTrace('enter-3d', { slug: series.slug, width: W, height: H, depth: D });
  }
}

export { updateLabelTexture };
