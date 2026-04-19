/**
 * Draw a binary mask as a transparent colored overlay on a canvas 2D context.
 */
export function overlayMask(ctx, result, opts = {}) {
  if (!result || !result.mask) return;
  const { mask, width, height } = result;
  const r = opts.r ?? 0;
  const g = opts.g ?? 180;
  const b = opts.b ?? 255;
  const a = Math.round((opts.a ?? 0.35) * 255);

  const imageData = ctx.getImageData(0, 0, width, height);
  const d = imageData.data;

  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      const p = i * 4;
      const srcA = a / 255;
      const invA = 1 - srcA;
      d[p]     = Math.round(d[p]     * invA + r * srcA);
      d[p + 1] = Math.round(d[p + 1] * invA + g * srcA);
      d[p + 2] = Math.round(d[p + 2] * invA + b * srcA);
    }
  }

  ctx.putImageData(imageData, 0, 0);
}
