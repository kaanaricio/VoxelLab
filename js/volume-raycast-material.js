import * as THREE from './vendor-three.js';

import {
  VOLUME_RAYCAST_FRAGMENT_SHADER,
  VOLUME_RAYCAST_VERTEX_SHADER,
} from './volume-raycast-shaders.js';

/**
 * Raycast ShaderMaterial for Data3DTexture volume + label LUT. Uniforms match
 * volume-raycast-shaders.js; `renderMode` maps to uMode (0 transfer, 1 MIP, 2 minIP).
 */
export function createVolumeRaycastMaterial(opts) {
  const {
    texture,
    dummyLabel,
    lutTex,
    width: W,
    height: H,
    depth: D,
    lowT,
    highT,
    intensity,
    clipMin,
    clipMax,
    renderMode,
  } = opts;

  const uMode = renderMode === 'mip' ? 1 : renderMode === 'minip' ? 2 : 0;

  return new THREE.ShaderMaterial({
    uniforms: {
      uVolume:     { value: texture },
      uLabel:      { value: dummyLabel },
      uLabelMode:  { value: 0 },
      uLabelLUT:   { value: lutTex },
      uLabelAlpha: { value: 0.55 },
      uSteps:      { value: 512 },
      uLowT:       { value: lowT },
      uHighT:      { value: highT },
      uIntensity:  { value: intensity },
      uClipMin:    { value: new THREE.Vector3().fromArray(clipMin) },
      uClipMax:    { value: new THREE.Vector3().fromArray(clipMax) },
      uMode:       { value: uMode },
      uVolSize:    { value: new THREE.Vector3(W, H, D) },
      uLightDir:   { value: new THREE.Vector3(0.5, 0.5, 0.7).normalize() },
      uAmbient:    { value: 0.48 },
      uSpecular:   { value: 0.08 },
      uShininess:  { value: 40.0 },
      uGradBoost:  { value: 1.15 },
      uEdgeBoost:  { value: 0.18 },
      uDither:     { value: 0.006 },
    },
    vertexShader: VOLUME_RAYCAST_VERTEX_SHADER,
    fragmentShader: VOLUME_RAYCAST_FRAGMENT_SHADER,
    transparent: true,
    side: THREE.BackSide,
  });
}
