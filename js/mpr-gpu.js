import * as THREE from './vendor-three.js';
export { planeForAxis, planeForOblique } from './mpr-projection.js';
import { TISSUE_LABEL_COUNT } from './constants.js';

// Shape: one shared offscreen WebGL MPR renderer reused for all panes.
const runtime = {
  canvas: null,
  renderer: null,
  scene: null,
  camera: null,
  material: null,
  mesh: null,
  textures: {},
  baseRef: null,
  baseBytes: null,
  dimsKey: '',
  // Shape: reusable 256x1 RGBA LUT byte planes + change counters for current GPU render state.
  lutCache: {
    grayBytes: new Uint8Array(256 * 4),
    regionBytes: new Uint8Array(256 * 4),
    hotBytes: new Uint8Array(256 * 4),
    grayR: null,
    grayG: null,
    grayB: null,
    regionRef: null,
    hotRef: null,
    grayVersion: 0,
    regionVersion: 0,
    hotVersion: 0,
  },
};

function createDataTexture3D(bytes, width, height, depth, filter = THREE.LinearFilter) {
  const texture = new THREE.Data3DTexture(bytes, width, height, depth);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = filter;
  texture.magFilter = filter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function createLutTexture(bytes) {
  const texture = new THREE.DataTexture(bytes, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function shaderMaterial() {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uBase: { value: null },
      uSeg: { value: null },
      uSym: { value: null },
      uRegions: { value: null },
      uFusion: { value: null },
      uGrayLut: { value: null },
      uRegionLut: { value: null },
      uHotLut: { value: null },
      uOrigin: { value: new THREE.Vector3() },
      uAxisU: { value: new THREE.Vector3() },
      uAxisV: { value: new THREE.Vector3() },
      uTexel: { value: new THREE.Vector3(1, 1, 1) },
      uCoordMax: { value: new THREE.Vector3() },
      uSlabStep: { value: new THREE.Vector3() },
      uRegionAlpha: { value: 0.55 },
      uFusionAlpha: { value: 0.55 },
      uProjectionMode: { value: 0 },
      uSampleCount: { value: 1 },
      uHasSeg: { value: 0 },
      uHasSym: { value: 0 },
      uHasRegions: { value: 0 },
      uHasFusion: { value: 0 },
    },
    vertexShader: `
      in vec3 position;
      in vec2 uv;
      out vec2 vUv;
      void main() {
        vUv = vec2(uv.x, 1.0 - uv.y);
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      precision highp sampler2D;
      precision highp sampler3D;

      in vec2 vUv;
      uniform sampler3D uBase;
      uniform sampler3D uSeg;
      uniform sampler3D uSym;
      uniform sampler3D uRegions;
      uniform sampler3D uFusion;
      uniform sampler2D uGrayLut;
      uniform sampler2D uRegionLut;
      uniform sampler2D uHotLut;
      uniform vec3 uOrigin;
      uniform vec3 uAxisU;
      uniform vec3 uAxisV;
      uniform vec3 uTexel;
      uniform vec3 uCoordMax;
      uniform vec3 uSlabStep;
      uniform float uRegionAlpha;
      uniform float uFusionAlpha;
      uniform int uProjectionMode;
      uniform int uSampleCount;
      uniform int uHasSeg;
      uniform int uHasSym;
      uniform int uHasRegions;
      uniform int uHasFusion;
      out vec4 outColor;
      const int MAX_SLAB_SAMPLES = 24;

      vec3 sampleLut(sampler2D tex, float idx) {
        return texture(tex, vec2((idx + 0.5) / 256.0, 0.5)).rgb;
      }

      bool inBounds(vec3 coord) {
        return all(greaterThanEqual(coord, vec3(0.0))) && all(lessThanEqual(coord, uCoordMax));
      }

      vec3 toTexCoord(vec3 coord) {
        return (coord + 0.5) * uTexel;
      }

      float sampleContinuous(sampler3D tex, vec3 coord) {
        if (!inBounds(coord)) return 0.0;
        return texture(tex, toTexCoord(coord)).r;
      }

      float sampleDiscrete(sampler3D tex, vec3 coord) {
        if (!inBounds(coord)) return 0.0;
        return texture(tex, toTexCoord(coord)).r;
      }

      float projectContinuous(sampler3D tex, vec3 coord) {
        if (uSampleCount <= 1 || uProjectionMode == 0) {
          return sampleContinuous(tex, coord);
        }
        float accum = 0.0;
        float best = uProjectionMode == 3 ? 1.0 : 0.0;
        float centerOffset = float(uSampleCount - 1) * 0.5;
        for (int i = 0; i < MAX_SLAB_SAMPLES; i++) {
          if (i >= uSampleCount) break;
          vec3 sampleCoord = coord + (float(i) - centerOffset) * uSlabStep;
          float value = sampleContinuous(tex, sampleCoord);
          if (uProjectionMode == 1) accum += value;
          else if (uProjectionMode == 2) best = max(best, value);
          else if (uProjectionMode == 3) best = min(best, value);
        }
        if (uProjectionMode == 1) return accum / float(uSampleCount);
        return best;
      }

      void main() {
        vec3 coord = uOrigin + vUv.x * uAxisU + vUv.y * uAxisV;
        float base = floor(projectContinuous(uBase, coord) * 255.0 + 0.5);
        vec3 rgb = sampleLut(uGrayLut, base);

        if (uHasSeg == 1) {
          float seg = floor(sampleDiscrete(uSeg, coord) * 255.0 + 0.5);
          if (seg > 0.5 && seg < ${TISSUE_LABEL_COUNT}.0) {
            vec4 c = seg < 1.5 ? vec4(53.0, 162.0, 235.0, 0.35)
              : seg < 2.5 ? vec4(86.0, 195.0, 109.0, 0.28)
              : vec4(255.0, 193.0, 7.0, 0.30);
            rgb = mix(rgb, c.rgb / 255.0, c.a);
          }
        }

        if (uHasSym == 1) {
          float sym = floor(projectContinuous(uSym, coord) * 255.0 + 0.5);
          if (sym > 20.0) {
            float a = sym > 207.0 ? 0.65 : sym * 0.003137;
            rgb = mix(rgb, vec3(214.0, 118.0, 118.0) / 255.0, a);
          }
        }

        if (uHasRegions == 1) {
          float region = floor(sampleDiscrete(uRegions, coord) * 255.0 + 0.5);
          if (region > 0.5 && region < 255.0) {
            vec3 c = sampleLut(uRegionLut, region);
            if (c.r > 0.0 || c.g > 0.0 || c.b > 0.0) {
              rgb = mix(rgb, c, uRegionAlpha);
            }
          }
        }

        if (uHasFusion == 1) {
          float fusion = floor(projectContinuous(uFusion, coord) * 255.0 + 0.5);
          if (fusion >= 12.0) {
            vec3 c = sampleLut(uHotLut, fusion);
            rgb = mix(rgb, c, uFusionAlpha);
          }
        }

        outColor = vec4(rgb, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

export function canUseGpuMpr() {
  return typeof document !== 'undefined'
    && typeof WebGL2RenderingContext !== 'undefined';
}

function ensureShell(width, height) {
  if (!canUseGpuMpr()) return null;
  if (!runtime.canvas) runtime.canvas = document.createElement('canvas');
  if (!runtime.renderer) {
    runtime.renderer = new THREE.WebGLRenderer({
      canvas: runtime.canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    runtime.renderer.setClearColor(0x000000, 1);
    runtime.scene = new THREE.Scene();
    runtime.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    runtime.camera.position.z = 1;
    runtime.camera.lookAt(0, 0, 0);
    runtime.material = shaderMaterial();
    runtime.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), runtime.material);
    runtime.mesh.frustumCulled = false;
    runtime.scene.add(runtime.mesh);
  }
  runtime.renderer.setPixelRatio(1);
  runtime.renderer.setSize(width, height, false);
  return runtime;
}

function bytesForBase(vox, dims) {
  if (vox instanceof Uint8Array) return vox;
  if (runtime.baseRef === vox && runtime.baseBytes && runtime.dimsKey === `${dims.W}x${dims.H}x${dims.D}`) {
    return runtime.baseBytes;
  }
  // Shape: Uint8Array(W * H * D) normalized from hrVoxels once per source volume.
  const out = new Uint8Array(vox.length);
  for (let i = 0; i < vox.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(vox[i] * 255)));
  runtime.baseRef = vox;
  runtime.baseBytes = out;
  runtime.dimsKey = `${dims.W}x${dims.H}x${dims.D}`;
  return out;
}

function replaceVolumeTexture(slot, ref, width, height, depth, filter) {
  const current = runtime.textures[slot];
  if (current?.ref === ref && current.width === width && current.height === height && current.depth === depth) {
    return current.texture;
  }
  current?.texture?.dispose?.();
  const texture = createDataTexture3D(ref, width, height, depth, filter);
  runtime.textures[slot] = { ref, width, height, depth, texture };
  return texture;
}

function ensureLutTexture(slot, key, bytes) {
  const current = runtime.textures[slot];
  if (current?.key === key) return current.texture;
  current?.texture?.dispose?.();
  const texture = createLutTexture(bytes);
  runtime.textures[slot] = { key, texture };
  return texture;
}

function fillLutBytes(target, colors, fallbackAlpha = 255) {
  for (let i = 0, p = 0; i < 256; i += 1, p += 4) {
    const color = colors?.[i];
    target[p] = color?.[0] || 0;
    target[p + 1] = color?.[1] || 0;
    target[p + 2] = color?.[2] || 0;
    target[p + 3] = fallbackAlpha;
  }
  return target;
}

function fillGrayLutBytes(target, wlLut) {
  for (let i = 0, p = 0; i < 256; i += 1, p += 4) {
    target[p] = wlLut.r[i];
    target[p + 1] = wlLut.g[i];
    target[p + 2] = wlLut.b[i];
    target[p + 3] = 255;
  }
  return target;
}

// Shape: { origin:[0,0,12], axisU:[255,0,0], axisV:[0,255,0] } in voxel coordinates.
export function drawGpuMprSlice(canvas, {
  plane,
  projection = null,
  dims,
  vox,
  wlLut,
  regionColors,
  regionAlpha = 0.55,
  fusionAlpha = 0.55,
  segVoxels = null,
  regionVoxels = null,
  symVoxels = null,
  fusionVoxels = null,
  hotLut = null,
} = {}) {
  const outW = canvas.width;
  const outH = canvas.height;
  try {
    const shell = ensureShell(outW, outH);
    if (!shell || !plane || !vox) return false;

    const baseBytes = bytesForBase(vox, dims);
    const empty = new Uint8Array([0]);
    const uniforms = shell.material.uniforms;

    uniforms.uBase.value = replaceVolumeTexture('base', baseBytes, dims.W, dims.H, dims.D, THREE.LinearFilter);
    uniforms.uSeg.value = replaceVolumeTexture('seg', segVoxels || empty, segVoxels ? dims.W : 1, segVoxels ? dims.H : 1, segVoxels ? dims.D : 1, THREE.NearestFilter);
    uniforms.uRegions.value = replaceVolumeTexture('regions', regionVoxels || empty, regionVoxels ? dims.W : 1, regionVoxels ? dims.H : 1, regionVoxels ? dims.D : 1, THREE.NearestFilter);
    uniforms.uSym.value = replaceVolumeTexture('sym', symVoxels || empty, symVoxels ? dims.W : 1, symVoxels ? dims.H : 1, symVoxels ? dims.D : 1, THREE.LinearFilter);
    uniforms.uFusion.value = replaceVolumeTexture('fusion', fusionVoxels || empty, fusionVoxels ? dims.W : 1, fusionVoxels ? dims.H : 1, fusionVoxels ? dims.D : 1, THREE.LinearFilter);

    const lutCache = runtime.lutCache;
    const hotSource = hotLut || null;
    if (lutCache.grayR !== wlLut.r || lutCache.grayG !== wlLut.g || lutCache.grayB !== wlLut.b) {
      fillGrayLutBytes(lutCache.grayBytes, wlLut);
      lutCache.grayR = wlLut.r;
      lutCache.grayG = wlLut.g;
      lutCache.grayB = wlLut.b;
      lutCache.grayVersion += 1;
    }
    if (lutCache.regionRef !== regionColors) {
      fillLutBytes(lutCache.regionBytes, regionColors);
      lutCache.regionRef = regionColors;
      lutCache.regionVersion += 1;
    }
    if (lutCache.hotRef !== hotSource) {
      if (hotSource) lutCache.hotBytes.set(hotSource);
      else lutCache.hotBytes.fill(0);
      lutCache.hotRef = hotSource;
      lutCache.hotVersion += 1;
    }
    uniforms.uGrayLut.value = ensureLutTexture('grayLut', `gray:${lutCache.grayVersion}`, lutCache.grayBytes);
    uniforms.uRegionLut.value = ensureLutTexture('regionLut', `region:${lutCache.regionVersion}`, lutCache.regionBytes);
    uniforms.uHotLut.value = ensureLutTexture('hotLut', `hot:${lutCache.hotVersion}`, lutCache.hotBytes);

    uniforms.uOrigin.value.fromArray(plane.origin);
    uniforms.uAxisU.value.fromArray(plane.axisU);
    uniforms.uAxisV.value.fromArray(plane.axisV);
    uniforms.uTexel.value.set(1 / dims.W, 1 / dims.H, 1 / dims.D);
    uniforms.uCoordMax.value.set(dims.W - 1, dims.H - 1, dims.D - 1);
    uniforms.uSlabStep.value.fromArray(projection?.slabStep || [0, 0, 0]);
    uniforms.uRegionAlpha.value = regionAlpha;
    uniforms.uFusionAlpha.value = fusionAlpha;
    uniforms.uProjectionMode.value = {
      thin: 0,
      avg: 1,
      mip: 2,
      minip: 3,
    }[projection?.mode || 'thin'] || 0;
    uniforms.uSampleCount.value = projection?.sampleCount || 1;
    uniforms.uHasSeg.value = segVoxels ? 1 : 0;
    uniforms.uHasRegions.value = regionVoxels ? 1 : 0;
    uniforms.uHasSym.value = symVoxels ? 1 : 0;
    uniforms.uHasFusion.value = fusionVoxels ? 1 : 0;

    shell.renderer.render(shell.scene, shell.camera);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(shell.canvas, 0, 0, outW, outH);
    return true;
  } catch (error) {
    console.warn('voxellab mpr-gpu: falling back to CPU reslice', error);
    return false;
  }
}
