// GLSL for Data3D volume raycasting (used by volume-raycast-material.js).
export const VOLUME_RAYCAST_VERTEX_SHADER = /* glsl */`
      varying vec3 vOrigin;
      varying vec3 vDir;
      void main() {
        vec3 camObj = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
        vOrigin = camObj + vec3(0.5);
        vDir = position - camObj;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

export const VOLUME_RAYCAST_FRAGMENT_SHADER = /* glsl */`
      precision highp float;
      precision highp sampler3D;
      uniform sampler3D uVolume;
      uniform sampler3D uLabel;
      uniform int       uLabelMode;           // 0 off, 1 tissue seg, 2 regions
      uniform sampler2D uLabelLUT;            // 256×1 RGBA: rgb=color, a=opacity
      uniform float     uLabelAlpha;
      uniform float uSteps;
      uniform float uLowT;
      uniform float uHighT;
      uniform float uIntensity;
      uniform vec3  uClipMin;
      uniform vec3  uClipMax;
      uniform int   uMode;
      uniform vec3  uVolSize;
      uniform vec3  uLightDir;
      uniform float uAmbient;
      uniform float uSpecular;
      uniform float uShininess;
      uniform float uGradBoost;
      uniform float uEdgeBoost;
      uniform float uDither;
      varying vec3 vOrigin;
      varying vec3 vDir;

      // Ray–axis-aligned-box intersection
      vec2 hitBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
        vec3 invR = 1.0 / rd;
        vec3 tMin = (bmin - ro) * invR;
        vec3 tMax = (bmax - ro) * invR;
        vec3 t1 = min(tMin, tMax);
        vec3 t2 = max(tMin, tMax);
        return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
      }

      // Hash → [0,1) per-pixel random, for ray jitter (prevents banding
      // artifacts visible when the step count is low relative to volume
      // resolution — shifts each ray's first sample by a fraction of a step).
      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      // Central-difference gradient of the intensity field. Used as a
      // surface normal for simple Phong shading — this is what gives the
      // volume its depth / plasticity look instead of flat silhouettes.
      vec3 gradient(vec3 p) {
        vec3 e = 1.0 / uVolSize;
        float dx = texture(uVolume, p + vec3(e.x, 0.0, 0.0)).r
                 - texture(uVolume, p - vec3(e.x, 0.0, 0.0)).r;
        float dy = texture(uVolume, p + vec3(0.0, e.y, 0.0)).r
                 - texture(uVolume, p - vec3(0.0, e.y, 0.0)).r;
        float dz = texture(uVolume, p + vec3(0.0, 0.0, e.z)).r
                 - texture(uVolume, p - vec3(0.0, 0.0, e.z)).r;
        return vec3(dx, dy, dz);
      }

      // Sample the 256-entry label LUT. Each texel is (r, g, b, opacity)
      // with values in [0, 1]. Index 0 is the "no label" slot and is
      // always (0, 0, 0, 1). Sampling at the center of texel idx:
      //    u = (idx + 0.5) / 256
      vec4 labelLUT(int idx) {
        if (idx <= 0 || idx > 255) return vec4(0.0, 0.0, 0.0, 1.0);
        float u = (float(idx) + 0.5) / 256.0;
        return texture(uLabelLUT, vec2(u, 0.5));
      }

      void main() {
        vec3 rd = normalize(vDir);
        vec2 t = hitBox(vOrigin, rd, uClipMin, uClipMax);
        if (t.x >= t.y) discard;
        t.x = max(t.x, 0.0);

        float dt = (t.y - t.x) / uSteps;
        // Per-pixel jitter along the ray: shifts the first sample position
        // by [0, dt) so neighboring pixels don't land on the same voxel
        // plane. Kills the concentric-ring banding.
        float jitter = hash12(gl_FragCoord.xy);
        vec3 p = vOrigin + (t.x + jitter * dt) * rd;

        if (uMode == 0) {
          // Alpha-composited volume render with gradient lighting,
          // per-tissue opacity, edge enhancement, and anti-banding dither.
          vec4 acc = vec4(0.0);
          // Accumulate a secondary dither source so each sample is offset
          // by a small noise value — this dismantles the thin quantization
          // contours you see on 8-bit volumes even with good interpolation.
          float dseed = hash12(gl_FragCoord.xy + 17.3);
          for (float i = 0.0; i < 1024.0; i++) {
            if (i >= uSteps) break;
            float raw = texture(uVolume, p).r;
            // Dither the raw sample by ±uDither so adjacent pixels on flat
            // regions land on different threshold sides — banding breaks up.
            raw += (fract(dseed + i * 0.6180339) - 0.5) * uDither;

            // Skip near-zero voxels regardless of lowT — prevents the
            // entire background from rendering as a solid black shell
            // when the user drags the low threshold to 0%.
            if (raw < 0.003) { p += rd * dt; continue; }

            if (raw >= uLowT && raw <= uHighT) {
              float s = (raw - uLowT) / max(1e-4, uHighT - uLowT);
              s *= uIntensity;
              float a = 1.0 - exp(-s * 1.5);

              // Per-label transfer: pick up label color AND an opacity
              // multiplier. For tissue seg this makes CSF (label 1) almost
              // transparent and WM (label 3) the most opaque, so the
              // volume reads as nested anatomy (cortex → deep white
              // matter → ventricles).
              vec3 base = vec3(s);
              if (uLabelMode > 0) {
                int lbl = int(texture(uLabel, p).r * 255.0 + 0.5);
                vec4 lut = labelLUT(lbl);
                if (lut.r + lut.g + lut.b > 0.001) {
                  base = mix(vec3(s), lut.rgb, uLabelAlpha);
                }
                a *= lut.a;
              }

              // Gradient: needed for both lighting and edge enhancement.
              vec3 grad = gradient(p);
              float gmag = length(grad);

              // Gradient-based Phong lighting. Flat regions get a near-1.0
              // brightness floor so homogeneous tissue isn't dimmed, only
              // actual surfaces get directional shading.
              if (gmag > 1e-4) {
                vec3 n = -grad / gmag;
                float ndl = max(dot(n, uLightDir), 0.0);
                vec3 view = -rd;
                vec3 half_ = normalize(uLightDir + view);
                float spec = pow(max(dot(n, half_), 0.0), uShininess) * uSpecular;
                float diff = ndl * (1.0 - uAmbient);
                float lit  = uAmbient + diff * uGradBoost;
                base = base * lit + vec3(spec);
              } else {
                // Flat region: preserve brightness (was 0.6, too dim).
                base *= uAmbient + (1.0 - uAmbient) * 0.95;
              }

              // Edge enhancement: darken pixels where the gradient is
              // strong. Produces a scientific-illustration look — clear
              // anatomical delineation without modifying the underlying
              // data. uEdgeBoost controls how much.
              float edge = clamp(gmag * 8.0, 0.0, 1.0);
              base *= mix(1.0, 1.0 - uEdgeBoost * 0.7, edge);
              // Also boost alpha at strong edges so the edges stay visible
              // through the alpha compositing.
              a = min(1.0, a + edge * 0.2);

              acc.rgb += (1.0 - acc.a) * a * base;
              acc.a   += (1.0 - acc.a) * a;
              if (acc.a >= 0.985) break;
            }
            p += rd * dt;
          }
          if (acc.a < 0.01) discard;
          gl_FragColor = vec4(acc.rgb, acc.a);
        } else if (uMode == 1) {
          // Maximum intensity projection. Return the brightest voxel along
          // the ray inside the window. Great for vessels on SWI / MRA.
          float maxV = 0.0;
          int maxLbl = 0;
          for (float i = 0.0; i < 1024.0; i++) {
            if (i >= uSteps) break;
            float raw = texture(uVolume, p).r;
            if (raw >= uLowT && raw <= uHighT && raw > maxV) {
              maxV = raw;
              if (uLabelMode > 0) {
                maxLbl = int(texture(uLabel, p).r * 255.0 + 0.5);
              }
            }
            p += rd * dt;
          }
          if (maxV <= uLowT + 0.001) discard;
          float s = (maxV - uLowT) / max(1e-4, uHighT - uLowT);
          s = clamp(s * uIntensity, 0.0, 1.0);
          vec3 col = vec3(s);
          if (uLabelMode > 0 && maxLbl > 0) {
            vec4 lut = labelLUT(maxLbl);
            if (lut.r + lut.g + lut.b > 0.001) col = mix(col, lut.rgb, uLabelAlpha);
          }
          gl_FragColor = vec4(col, 1.0);
        } else {
          // Minimum intensity projection. Returns the darkest voxel along
          // the ray. Useful for vessels / microbleeds / calcium on SWI
          // (they're dark on susceptibility-weighted imaging).
          float minV = 1.0;
          bool any = false;
          for (float i = 0.0; i < 1024.0; i++) {
            if (i >= uSteps) break;
            float raw = texture(uVolume, p).r;
            if (raw >= uLowT && raw <= uHighT) {
              if (raw < minV) minV = raw;
              any = true;
            }
            p += rd * dt;
          }
          if (!any) discard;
          float s = 1.0 - (minV - uLowT) / max(1e-4, uHighT - uLowT);
          s = clamp(s * uIntensity, 0.0, 1.0);
          gl_FragColor = vec4(vec3(s), 1.0);
        }
      }
    `;
