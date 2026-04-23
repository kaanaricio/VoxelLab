// Oblique MPR — user-defined plane through the volume.
//
// The three orthogonal MPR views (axial / coronal / sagittal) are fixed
// to the DICOM acquisition axes. An oblique plane lets the user pick any
// orientation — useful for following structures that don't lie in a
// canonical plane (aorta, optic nerves, curved vertebrae, etc.).
//
// A plane is defined by:
//   · a point that sits on the plane (we use the MPR crosshair position)
//   · two orthogonal direction vectors spanning the plane (the "u" and
//     "v" axes in the output image)
//
// We parameterize the plane by two angles:
//   · yaw   — rotation around the superior-inferior axis
//   · pitch — tilt relative to the axial plane
//
// Starting from the identity orientation (u=+x, v=+y, normal=+z) we
// rotate u and v by (yaw, pitch) to produce any plane. Output pixel (u,v)
// maps to a volume voxel at
//   p = center + u * du + v * dv
// where du and dv are the unit u/v vectors scaled to voxel size.
//
// The sampling kernel is the same Lanczos-3 we use for orthogonal MPR —
// ensures the oblique view has the same sharpness profile as the others.

import { sampleLanczosZ } from './lanczos.js';
import { getFusedWLLut, getFusedWLU32 } from './colormap.js';
import { drawCompositeSlice } from './slice-compositor.js';
import { projectVolumeSample } from './mpr-projection.js';
import { dot3 } from './geometry.js';

// Rotate the (u, v, n) basis by yaw around z then pitch around the
// current u axis. Returns { u, v, n } as three-vectors in voxel space.
export function obliqueBasis(yawDeg, pitchDeg) {
  const yaw   = yawDeg   * Math.PI / 180;
  const pitch = pitchDeg * Math.PI / 180;
  const cy = Math.cos(yaw),   sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  // Start with u=+x, v=+y, n=+z. Apply yaw around +z.
  let u = [ cy, sy, 0];
  let v = [-sy, cy, 0];
  let n = [  0,  0, 1];

  // Then pitch around the (rotated) u axis — rotates v and n.
  const rotV = [
    v[0] * cp + n[0] * sp,
    v[1] * cp + n[1] * sp,
    v[2] * cp + n[2] * sp,
  ];
  const rotN = [
    -v[0] * sp + n[0] * cp,
    -v[1] * sp + n[1] * cp,
    -v[2] * sp + n[2] * cp,
  ];
  return { u, v: rotV, n: rotN };
}

function sampleByte(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function extentShape(extent) {
  if (typeof extent === 'number') return { widthMm: extent, heightMm: extent };
  const widthMm = Number(extent?.widthMm);
  const heightMm = Number(extent?.heightMm);
  return {
    widthMm: Number.isFinite(widthMm) && widthMm > 0 ? widthMm : 1,
    heightMm: Number.isFinite(heightMm) && heightMm > 0 ? heightMm : 1,
  };
}

// Shape: { widthMm: 192, heightMm: 176 } for the current oblique plane through the volume.
export function obliquePlaneExtentMm(dims, spacing, center, yaw, pitch) {
  const { W, H, D } = dims;
  const basis = obliqueBasis(yaw, pitch);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const z of [0, Math.max(0, D - 1)]) {
    for (const y of [0, Math.max(0, H - 1)]) {
      for (const x of [0, Math.max(0, W - 1)]) {
        const rel = [
          (x - center[0]) * spacing.col,
          (y - center[1]) * spacing.row,
          (z - center[2]) * spacing.slice,
        ];
        const u = dot3(rel, basis.u);
        const v = dot3(rel, basis.v);
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
  }
  const pad = 1.04;
  return {
    widthMm: Math.max(spacing.col, (maxU - minU) * pad),
    heightMm: Math.max(spacing.row, (maxV - minV) * pad),
  };
}

// Shape: { width: 820, height: 608 } chosen to fill the visible oblique stage.
export function fitObliqueCanvas(availableWidth, availableHeight, extent) {
  const width = Math.max(1, Math.round(availableWidth || 1));
  const height = Math.max(1, Math.round(availableHeight || 1));
  const safe = extentShape(extent);
  const aspect = safe.widthMm / safe.heightMm;
  if (!(aspect > 0)) return { width, height };
  const targetHeight = Math.min(height, Math.round(width / aspect));
  const targetWidth = Math.min(width, Math.round(targetHeight * aspect));
  return {
    width: Math.max(1, targetWidth),
    height: Math.max(1, targetHeight),
  };
}

function ensureObliqueBuffers(target, width, height, overlays) {
  const planeSize = width * height;
  const next = target?.width === width && target?.height === height
    ? target
    : { width, height };
  next.width = width;
  next.height = height;
  if (!next.baseBytes || next.baseBytes.length !== planeSize) next.baseBytes = new Uint8Array(planeSize);
  if (overlays.segVoxels) {
    if (!next.segBytes || next.segBytes.length !== planeSize) next.segBytes = new Uint8Array(planeSize);
  } else next.segBytes = null;
  if (overlays.regionVoxels) {
    if (!next.regionBytes || next.regionBytes.length !== planeSize) next.regionBytes = new Uint8Array(planeSize);
  } else next.regionBytes = null;
  if (overlays.symVoxels) {
    if (!next.symBytes || next.symBytes.length !== planeSize) next.symBytes = new Uint8Array(planeSize);
  } else next.symBytes = null;
  if (overlays.fusionVoxels) {
    if (!next.fusionBytes || next.fusionBytes.length !== planeSize) next.fusionBytes = new Uint8Array(planeSize);
  } else next.fusionBytes = null;
  return next;
}

// Shape: { width: 512, height: 512, baseBytes: Uint8Array(...), segBytes: null, regionBytes: null, symBytes: null, fusionBytes: null }.
export function sampleObliqueCompositeSlice(width, height, vox, voxScale, dims, spacing, center, yaw, pitch, extentMm, overlays = null, target = null, sampleVolume = sampleLanczosZ, projection = null) {
  const { W, H, D } = dims;
  const overlayState = overlays || {};
  const sampled = ensureObliqueBuffers(target, width, height, overlayState);
  const { baseBytes, segBytes, regionBytes, symBytes, fusionBytes } = sampled;
  const extent = extentShape(extentMm);
  const basis = obliqueBasis(yaw, pitch);
  const stepUMm = extent.widthMm / Math.max(1, width - 1);
  const stepVMm = extent.heightMm / Math.max(1, height - 1);
  const du = [basis.u[0] * stepUMm / spacing.col, basis.u[1] * stepUMm / spacing.row, basis.u[2] * stepUMm / spacing.slice];
  const dv = [basis.v[0] * stepVMm / spacing.col, basis.v[1] * stepVMm / spacing.row, basis.v[2] * stepVMm / spacing.slice];
  const halfW = (width - 1) / 2;
  const halfH = (height - 1) / 2;
  const maxVx = W - 1;
  const maxVy = H - 1;
  const maxVz = D - 1;
  const planeStride = W * H;
  const isThinProjection = !projection || projection.sampleCount <= 1 || projection.mode === 'thin';

  let sampleIndex = 0;
  for (let oy = 0; oy < height; oy++) {
    const rowX = center[0] + (oy - halfH) * dv[0] - halfW * du[0];
    const rowY = center[1] + (oy - halfH) * dv[1] - halfW * du[1];
    const rowZ = center[2] + (oy - halfH) * dv[2] - halfW * du[2];

    for (let ox = 0; ox < width; ox++, sampleIndex++) {
      const vx = rowX + ox * du[0];
      const vy = rowY + ox * du[1];
      const vz = rowZ + ox * du[2];

      if (vx < 0 || vx > maxVx || vy < 0 || vy > maxVy || vz < 0 || vz > maxVz) {
        baseBytes[sampleIndex] = 0;
        if (segBytes) segBytes[sampleIndex] = 0;
        if (regionBytes) regionBytes[sampleIndex] = 0;
        if (symBytes) symBytes[sampleIndex] = 0;
        if (fusionBytes) fusionBytes[sampleIndex] = 0;
        continue;
      }

      baseBytes[sampleIndex] = sampleByte(
        (isThinProjection
          ? sampleVolume(vox, vx, vy, vz, W, H, D)
          : projectVolumeSample(vox, vx, vy, vz, dims, sampleVolume, projection))
        * voxScale,
      );
      const ix = Math.max(0, Math.min(maxVx, Math.round(vx)));
      const iy = Math.max(0, Math.min(maxVy, Math.round(vy)));
      const iz = Math.max(0, Math.min(maxVz, Math.round(vz)));
      const volumeIndex = iz * planeStride + iy * W + ix;

      if (segBytes) segBytes[sampleIndex] = overlayState.segVoxels[volumeIndex];
      if (regionBytes) regionBytes[sampleIndex] = overlayState.regionVoxels[volumeIndex];
      if (symBytes) {
        symBytes[sampleIndex] = sampleByte(
          isThinProjection
            ? sampleVolume(overlayState.symVoxels, vx, vy, vz, W, H, D)
            : projectVolumeSample(overlayState.symVoxels, vx, vy, vz, dims, sampleVolume, projection),
        );
      }
      if (fusionBytes) {
        fusionBytes[sampleIndex] = sampleByte(
          isThinProjection
            ? sampleVolume(overlayState.fusionVoxels, vx, vy, vz, W, H, D)
            : projectVolumeSample(overlayState.fusionVoxels, vx, vy, vz, dims, sampleVolume, projection),
        );
      }
    }
  }
  return sampled;
}

// Draw an oblique reslice onto a 2D canvas.
//
//   canvas     — target HTMLCanvasElement
//   vox        — Uint8Array | Float32Array (row-major D,H,W)
//   voxScale   — multiply sampled value by this (1 for uint8, 255 for float)
//   dims       — { W, H, D }
//   spacing    — { px, py, sz } mm per voxel
//   center     — [x, y, z] voxel coordinate the plane passes through
//   yaw, pitch — plane orientation in degrees
//   extentMm   — physical size of the output window in mm (square)
//   lo, hi     — reserved (W/L + colormap come from state via fused LUTs)
//
// Output matches 2D / orthogonal MPR: same window/level and colormap as
// drawSlice (getFusedWLU32 / getFusedWLLut).
export function drawObliqueMPR(canvas, vox, voxScale, dims, spacing, center, yaw, pitch, extentMm, _lo, _hi, overlays = null, sampleVolume = sampleLanczosZ, projection = null) {
  const outW = canvas.width;
  const outH = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Shape: reusable sampled-byte planes for the current oblique canvas size.
  canvas._obliqueComposite = sampleObliqueCompositeSlice(
    outW,
    outH,
    vox,
    voxScale,
    dims,
    spacing,
    center,
    yaw,
    pitch,
    extentMm,
    overlays,
    canvas._obliqueComposite,
    sampleVolume,
    projection,
  );
  const sampled = canvas._obliqueComposite;
  const hasOverlays = !!(sampled.segBytes || sampled.regionBytes || sampled.symBytes || sampled.fusionBytes);

  if (!hasOverlays) {
    const imgData = canvas._obliqueImageData?.width === outW && canvas._obliqueImageData?.height === outH
      ? canvas._obliqueImageData
      : ctx.createImageData(outW, outH);
    canvas._obliqueImageData = imgData;
    const out32 = new Uint32Array(imgData.data.buffer);
    const fusedU32 = getFusedWLU32();
    for (let i = 0; i < sampled.baseBytes.length; i++) out32[i] = fusedU32[sampled.baseBytes[i]];
    ctx.putImageData(imgData, 0, 0);
    return;
  }

  drawCompositeSlice(ctx, outW, outH, {
    baseBytes: sampled.baseBytes,
    segBytes: sampled.segBytes,
    symBytes: sampled.symBytes,
    regionBytes: sampled.regionBytes,
    fusionBytes: sampled.fusionBytes,
    wlLut: getFusedWLLut(),
    regionColors: overlays?.regionColors || null,
    regionAlpha: overlays?.regionAlpha,
    fusionAlpha: overlays?.fusionAlpha,
    hotLut: overlays?.hotLut || null,
  });
}
