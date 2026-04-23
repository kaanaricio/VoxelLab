// Capture 2D / MPR / compare / 3D views as downloadable PNG.
import { state } from './state.js';
import { $ } from './dom.js';
import { getThreeRuntime } from './runtime/viewer-runtime.js';

async function compose2DScreenshot() {
  const src = $('view');
  const W = src.width;
  const H = src.height;

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);

  const svg = $('overlay-svg');
  if (svg && svg.children.length > 0) {
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', W);
    clone.setAttribute('height', H);
    clone.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const xml = new XMLSerializer().serializeToString(clone);
    const b64 = btoa(unescape(encodeURIComponent(xml)));
    const url = `data:image/svg+xml;base64,${b64}`;
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, W, H);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = url;
    });
  }

  return out.toDataURL('image/png');
}

export async function takeScreenshot() {
  const series = state.manifest.series[state.seriesIdx];
  const slug = series.slug;
  const mode = state.mode;
  let dataUrl = null;
  let suffix = '';
  const three = getThreeRuntime();

  if (mode === '3d' && three.renderer) {
    const r = three.renderer;
    r.render(three.scene, three.camera);
    dataUrl = r.domElement.toDataURL('image/png');
    suffix = '3d';
  } else if (mode === 'mpr') {
    const ax = $('mpr-ax');
    const co = $('mpr-co');
    const sa = $('mpr-sa');
    const H = Math.max(ax.height, co.height, sa.height);
    const W = ax.width + co.width + sa.width + 20;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const octx = out.getContext('2d');
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, W, H);
    octx.drawImage(ax, 0, (H - ax.height) / 2);
    octx.drawImage(co, ax.width + 10, (H - co.height) / 2);
    octx.drawImage(sa, ax.width + co.width + 20, (H - sa.height) / 2);
    const zFrac = state.mprZ / Math.max(1, series.slices - 1);
    drawScreenshotCrosshair(octx, 0, (H - ax.height) / 2, ax.width, ax.height, state.mprX, state.mprY);
    drawScreenshotCrosshair(octx, ax.width + 10, (H - co.height) / 2, co.width, co.height, state.mprX, (1 - zFrac) * (co.height - 1));
    drawScreenshotCrosshair(
      octx,
      ax.width + co.width + 20,
      (H - sa.height) / 2,
      sa.width,
      sa.height,
      state.mprY * (sa.width - 1) / Math.max(1, series.height - 1),
      (1 - zFrac) * (sa.height - 1),
    );
    dataUrl = out.toDataURL('image/png');
    suffix = `mpr_z${state.mprZ + 1}`;
  } else if (mode === 'cmp') {
    const cells = document.querySelectorAll('#cmp-grid canvas');
    if (!cells.length) return;
    let maxW = 0;
    let maxH = 0;
    cells.forEach((c) => {
      maxW = Math.max(maxW, c.width);
      maxH = Math.max(maxH, c.height);
    });
    const cols = 2;
    const rows = Math.ceil(cells.length / 2);
    const gap = 10;
    const out = document.createElement('canvas');
    out.width = cols * maxW + (cols - 1) * gap;
    out.height = rows * maxH + (rows - 1) * gap;
    const octx = out.getContext('2d');
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, out.width, out.height);
    cells.forEach((c, i) => {
      const r = Math.floor(i / cols);
      const col = i % cols;
      octx.drawImage(
        c,
        col * (maxW + gap) + (maxW - c.width) / 2,
        r * (maxH + gap) + (maxH - c.height) / 2,
      );
    });
    dataUrl = out.toDataURL('image/png');
    suffix = `compare_z${state.sliceIdx + 1}`;
  } else {
    dataUrl = await compose2DScreenshot();
    suffix = `z${state.sliceIdx + 1}`;
  }

  if (!dataUrl) return;
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${slug}_${suffix}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function drawScreenshotCrosshair(ctx, x, y, w, h, cx, cy) {
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y + cy + 0.5); ctx.lineTo(x + w, y + cy + 0.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + cx + 0.5, y); ctx.lineTo(x + cx + 0.5, y + h); ctx.stroke();
}
