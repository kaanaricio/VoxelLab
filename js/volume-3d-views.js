import * as THREE from './vendor-three.js';

import { getThreeRuntime } from './runtime/viewer-runtime.js';

// All 6 cardinal views + oblique reset. Each positions the camera on a
// face of the bounding sphere looking at the origin. TrackballControls'
// internal state is fully reset so subsequent drags behave correctly.
const VIEW_PRESETS = {
  axial:    { pos: [0, 0, 1],     up: [0, 1, 0] },
  bottom:   { pos: [0, 0, -1],    up: [0, -1, 0] },
  coronal:  { pos: [0, -1, 0],    up: [0, 0, 1] },
  back:     { pos: [0, 1, 0],     up: [0, 0, 1] },
  sagittal: { pos: [1, 0, 0],     up: [0, 0, 1] },
  right:    { pos: [-1, 0, 0],    up: [0, 0, 1] },
  reset:    { pos: [0.55, 0.45, 0.55], up: [0, 1, 0] },
};

/**
 * Canonical 3D view presets. Called from the view-preset buttons in the
 * 3D tools panel and from the double-click handler on the renderer canvas.
 */
export function setThreeDView(view) {
  const runtime = getThreeRuntime();
  const { camera, controls } = runtime;
  if (!camera || !controls) return;
  const d = 2.4;

  if (view === 'flipH') {
    camera.position.applyAxisAngle(camera.up.clone().normalize(), Math.PI);
  } else if (view === 'flipV') {
    const right = new THREE.Vector3().crossVectors(camera.up, camera.position).normalize();
    camera.position.applyAxisAngle(right, Math.PI);
    camera.up.applyAxisAngle(right, Math.PI);
  } else {
    const preset = VIEW_PRESETS[view] || VIEW_PRESETS.reset;
    const len = Math.sqrt(preset.pos[0]**2 + preset.pos[1]**2 + preset.pos[2]**2);
    camera.position.set(
      preset.pos[0] / len * d,
      preset.pos[1] / len * d,
      preset.pos[2] / len * d,
    );
    camera.up.set(preset.up[0], preset.up[1], preset.up[2]);
  }

  camera.lookAt(0, 0, 0);

  if (controls.target) controls.target.set(0, 0, 0);
  if (controls.position0) controls.position0.copy(camera.position);
  if (controls.up0) controls.up0.copy(camera.up);
  if (controls.target0) controls.target0.set(0, 0, 0);
  runtime.requestRender?.('view-preset', 180);
}
