import { COLORMAPS } from './colormap.js';
import { SEG_PALETTE, TISSUE_LABEL_COUNT } from './constants.js';

// Shape: { width: 512, height: 512, baseBytes: Uint8Array(262144), segBytes: null }.
//
// Shared 2D/compare compositor. Overlay-heavy redraws use one lazy WebGL2
// pass when available; the JS path stays as the correctness fallback for
// browsers/tests that cannot allocate the compositor context.

const REGION_LUT_SIZE = 256 * 4;
let _canvas = null;
let _gl = null;
let _program = null;
let _buffer = null;
let _uniforms = null;
let _textures = null;
let _regionLut = new Uint8Array(REGION_LUT_SIZE);
let _wlLut = new Uint8Array(REGION_LUT_SIZE);
let _hotLut = new Uint8Array(COLORMAPS.hot.lut);
let _cpuImage = null;
let _emptyByte = new Uint8Array([0]);

export const SLICE_COMPOSITOR_VERTEX_SHADER = `#version 300 es
    in vec2 aPosition;
    out vec2 vUv;
    void main() {
      vUv = vec2(aPosition.x * 0.5 + 0.5, 1.0 - (aPosition.y * 0.5 + 0.5));
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

function canUseWebGL2() {
  return typeof document !== 'undefined'
    && typeof WebGL2RenderingContext !== 'undefined';
}

function ensureCanvas(width, height) {
  if (!_canvas) _canvas = document.createElement('canvas');
  if (_canvas.width !== width) _canvas.width = width;
  if (_canvas.height !== height) _canvas.height = height;
  return _canvas;
}

function shader(gl, type, source) {
  const compiled = gl.createShader(type);
  gl.shaderSource(compiled, source);
  gl.compileShader(compiled);
  if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(compiled) || 'shader compile failed';
    gl.deleteShader(compiled);
    throw new Error(message);
  }
  return compiled;
}

function createProgram(gl) {
  const vert = shader(gl, gl.VERTEX_SHADER, SLICE_COMPOSITOR_VERTEX_SHADER);
  const frag = shader(gl, gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    precision highp sampler2D;
    in vec2 vUv;
    out vec4 outColor;

    uniform sampler2D uBase;
    uniform sampler2D uSeg;
    uniform sampler2D uSym;
    uniform sampler2D uRegions;
    uniform sampler2D uFusion;
    uniform sampler2D uGrayLut;
    uniform sampler2D uRegionLut;
    uniform sampler2D uHotLut;
    uniform float uRegionAlpha;
    uniform float uFusionAlpha;
    uniform int uHasSeg;
    uniform int uHasSym;
    uniform int uHasRegions;
    uniform int uHasFusion;

    vec3 sampleLut(sampler2D tex, float idx) {
      return texture(tex, vec2((idx + 0.5) / 256.0, 0.5)).rgb;
    }

    void main() {
      float base = floor(texture(uBase, vUv).r * 255.0 + 0.5);
      vec3 rgb = sampleLut(uGrayLut, base);

      if (uHasSeg == 1) {
        float seg = floor(texture(uSeg, vUv).r * 255.0 + 0.5);
        if (seg > 0.5 && seg < ${TISSUE_LABEL_COUNT}.0) {
          vec4 c = seg < 1.5 ? vec4(${SEG_PALETTE[1][0]}.0, ${SEG_PALETTE[1][1]}.0, ${SEG_PALETTE[1][2]}.0, ${SEG_PALETTE[1][3] / 255})
            : seg < 2.5 ? vec4(${SEG_PALETTE[2][0]}.0, ${SEG_PALETTE[2][1]}.0, ${SEG_PALETTE[2][2]}.0, ${SEG_PALETTE[2][3] / 255})
            : vec4(${SEG_PALETTE[3][0]}.0, ${SEG_PALETTE[3][1]}.0, ${SEG_PALETTE[3][2]}.0, ${SEG_PALETTE[3][3] / 255});
          rgb = mix(rgb, c.rgb / 255.0, c.a);
        }
      }

      if (uHasSym == 1) {
        float sym = floor(texture(uSym, vUv).r * 255.0 + 0.5);
        if (sym > 20.0) {
          float a = sym > 207.0 ? 0.65 : sym * 0.003137;
          rgb = mix(rgb, vec3(214.0, 118.0, 118.0) / 255.0, a);
        }
      }

      if (uHasRegions == 1) {
        float region = floor(texture(uRegions, vUv).r * 255.0 + 0.5);
        if (region > 0.5 && region < 255.0) {
          vec3 c = sampleLut(uRegionLut, region);
          if (c.r > 0.0 || c.g > 0.0 || c.b > 0.0) {
            rgb = mix(rgb, c, uRegionAlpha);
          }
        }
      }

      if (uHasFusion == 1) {
        float fusion = floor(texture(uFusion, vUv).r * 255.0 + 0.5);
        if (fusion >= 12.0) {
          vec3 c = sampleLut(uHotLut, fusion);
          rgb = mix(rgb, c, uFusionAlpha);
        }
      }

      outColor = vec4(rgb, 1.0);
    }
  `);
  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'program link failed';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function createTexture(gl, unit) {
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { texture, unit };
}

function ensureGl(width, height) {
  if (!canUseWebGL2()) return null;
  if (_gl) {
    ensureCanvas(width, height);
    _gl.viewport(0, 0, width, height);
    return _gl;
  }
  const canvas = ensureCanvas(width, height);
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) return null;
  try {
    const program = createProgram(gl);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1,
    ]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.useProgram(program);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    _gl = gl;
    _program = program;
    _buffer = buffer;
    _uniforms = {
      regionAlpha: gl.getUniformLocation(program, 'uRegionAlpha'),
      fusionAlpha: gl.getUniformLocation(program, 'uFusionAlpha'),
      hasSeg: gl.getUniformLocation(program, 'uHasSeg'),
      hasSym: gl.getUniformLocation(program, 'uHasSym'),
      hasRegions: gl.getUniformLocation(program, 'uHasRegions'),
      hasFusion: gl.getUniformLocation(program, 'uHasFusion'),
    };
    _textures = {
      base: createTexture(gl, 0),
      seg: createTexture(gl, 1),
      sym: createTexture(gl, 2),
      regions: createTexture(gl, 3),
      fusion: createTexture(gl, 4),
      grayLut: createTexture(gl, 5),
      regionLut: createTexture(gl, 6),
      hotLut: createTexture(gl, 7),
    };
    gl.uniform1i(gl.getUniformLocation(program, 'uBase'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uSeg'), 1);
    gl.uniform1i(gl.getUniformLocation(program, 'uSym'), 2);
    gl.uniform1i(gl.getUniformLocation(program, 'uRegions'), 3);
    gl.uniform1i(gl.getUniformLocation(program, 'uFusion'), 4);
    gl.uniform1i(gl.getUniformLocation(program, 'uGrayLut'), 5);
    gl.uniform1i(gl.getUniformLocation(program, 'uRegionLut'), 6);
    gl.uniform1i(gl.getUniformLocation(program, 'uHotLut'), 7);
    gl.viewport(0, 0, width, height);
    return gl;
  } catch (err) {
    console.warn('voxellab slice-compositor: WebGL2 disabled, using JS fallback', err);
    _gl = null;
    return null;
  }
}

function uploadRedTexture(gl, handle, width, height, data) {
  gl.activeTexture(gl.TEXTURE0 + handle.unit);
  gl.bindTexture(gl.TEXTURE_2D, handle.texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, data);
}

function uploadLutTexture(gl, handle, data) {
  gl.activeTexture(gl.TEXTURE0 + handle.unit);
  gl.bindTexture(gl.TEXTURE_2D, handle.texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
}

function ensureLuts({ wlLut, regionColors }) {
  for (let i = 0, p = 0; i < 256; i += 1, p += 4) {
    _wlLut[p] = wlLut.r[i];
    _wlLut[p + 1] = wlLut.g[i];
    _wlLut[p + 2] = wlLut.b[i];
    _wlLut[p + 3] = 255;
    const color = regionColors?.[i];
    _regionLut[p] = color?.[0] || 0;
    _regionLut[p + 1] = color?.[1] || 0;
    _regionLut[p + 2] = color?.[2] || 0;
    _regionLut[p + 3] = 255;
  }
}

function drawCpu(ctx, width, height, options) {
  const {
    baseBytes,
    segBytes,
    symBytes,
    regionBytes,
    fusionBytes,
    wlLut,
    regionColors,
    regionAlpha = 0.55,
    fusionAlpha = 0.55,
  } = options;
  if (!_cpuImage || _cpuImage.width !== width || _cpuImage.height !== height) {
    _cpuImage = ctx.createImageData(width, height);
  }
  const image = _cpuImage;
  const out = image.data;
  const hotLut = options.hotLut || _hotLut;
  for (let i = 0, p = 0; i < baseBytes.length; i += 1, p += 4) {
    const value = baseBytes[i];
    let r = wlLut.r[value];
    let g = wlLut.g[value];
    let b = wlLut.b[value];
    if (segBytes) {
      const label = segBytes[i];
      if (label > 0 && label < TISSUE_LABEL_COUNT) {
        const c = SEG_PALETTE[label];
        const a = c[3] / 255;
        r = r * (1 - a) + c[0] * a;
        g = g * (1 - a) + c[1] * a;
        b = b * (1 - a) + c[2] * a;
      }
    }
    if (symBytes) {
      const sym = symBytes[i];
      if (sym > 20) {
        const a = sym > 207 ? 0.65 : sym * 0.003137;
        r = r * (1 - a) + 214 * a;
        g = g * (1 - a) + 118 * a;
        b = b * (1 - a) + 118 * a;
      }
    }
    if (regionBytes) {
      const label = regionBytes[i];
      if (label > 0 && label < 255) {
        const c = regionColors?.[label];
        if (c) {
          r = r * (1 - regionAlpha) + c[0] * regionAlpha;
          g = g * (1 - regionAlpha) + c[1] * regionAlpha;
          b = b * (1 - regionAlpha) + c[2] * regionAlpha;
        }
      }
    }
    if (fusionBytes) {
      const fv = fusionBytes[i];
      if (fv >= 12) {
        const base = fv * 4;
        r = r * (1 - fusionAlpha) + hotLut[base] * fusionAlpha;
        g = g * (1 - fusionAlpha) + hotLut[base + 1] * fusionAlpha;
        b = b * (1 - fusionAlpha) + hotLut[base + 2] * fusionAlpha;
      }
    }
    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = b;
    out[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

export function drawCompositeSlice(ctx, width, height, options) {
  if (options.hotLut) _hotLut = options.hotLut;
  const gl = ensureGl(width, height);
  if (!gl) {
    drawCpu(ctx, width, height, options);
    return 'cpu';
  }
  ensureLuts(options);
  gl.useProgram(_program);
  gl.viewport(0, 0, width, height);
  gl.bindBuffer(gl.ARRAY_BUFFER, _buffer);
  uploadRedTexture(gl, _textures.base, width, height, options.baseBytes);
  uploadRedTexture(gl, _textures.seg, options.segBytes ? width : 1, options.segBytes ? height : 1, options.segBytes || _emptyByte);
  uploadRedTexture(gl, _textures.sym, options.symBytes ? width : 1, options.symBytes ? height : 1, options.symBytes || _emptyByte);
  uploadRedTexture(gl, _textures.regions, options.regionBytes ? width : 1, options.regionBytes ? height : 1, options.regionBytes || _emptyByte);
  uploadRedTexture(gl, _textures.fusion, options.fusionBytes ? width : 1, options.fusionBytes ? height : 1, options.fusionBytes || _emptyByte);
  uploadLutTexture(gl, _textures.grayLut, _wlLut);
  uploadLutTexture(gl, _textures.regionLut, _regionLut);
  uploadLutTexture(gl, _textures.hotLut, _hotLut);
  gl.uniform1f(_uniforms.regionAlpha, options.regionAlpha || 0);
  gl.uniform1f(_uniforms.fusionAlpha, options.fusionAlpha || 0);
  gl.uniform1i(_uniforms.hasSeg, options.segBytes ? 1 : 0);
  gl.uniform1i(_uniforms.hasSym, options.symBytes ? 1 : 0);
  gl.uniform1i(_uniforms.hasRegions, options.regionBytes ? 1 : 0);
  gl.uniform1i(_uniforms.hasFusion, options.fusionBytes ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  ctx.drawImage(_canvas, 0, 0, width, height);
  return 'webgl2';
}
