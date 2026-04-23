import { expect, test } from '@playwright/test';

function seriousMessage(consoleMessage) {
  if (consoleMessage.type() !== 'error') return null;

  // Example: Chromium may log a favicon miss that is unrelated to app health.
  const text = consoleMessage.text();
  if (text.includes('favicon.ico') && text.includes('404')) return null;
  if (text.includes('_asks.json') && text.includes('404')) return null;
  if (text.includes('_analysis.json') && text.includes('404')) return null;
  if (text === 'Failed to load resource: the server responded with a status of 404 (File not found)') return null;

  return `console.error: ${text}`;
}

async function waitForCanvasPaint(page, selector = '#view') {
  // Shape: { found: true, width: 768, height: 768, nonBlackPixels: 530074, maxChannel: 255 }.
  let lastStats = null;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    lastStats = await page.locator(selector).evaluate((canvas) => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        return {
          found: true,
          hasContext: false,
          width: canvas.width,
          height: canvas.height,
          nonTransparentPixels: 0,
          nonBlackPixels: 0,
          maxChannel: 0,
        };
      }

      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonTransparentPixels = 0;
      let nonBlackPixels = 0;
      let maxChannel = 0;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a !== 0) nonTransparentPixels += 1;
        if (r !== 0 || g !== 0 || b !== 0) nonBlackPixels += 1;
        maxChannel = Math.max(maxChannel, r, g, b);
      }

      return {
        found: true,
        hasContext: true,
        width: canvas.width,
        height: canvas.height,
        nonTransparentPixels,
        nonBlackPixels,
        maxChannel,
      };
    });

    if (lastStats.hasContext && lastStats.nonBlackPixels > 0 && lastStats.maxChannel > 0) {
      return lastStats;
    }

    await page.waitForTimeout(200);
  }

  return lastStats;
}

async function screenshotStats(page, selector) {
  const shot = await page.locator(selector).screenshot();
  return page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlackPixels = 0;
    let maxChannel = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      maxChannel = Math.max(maxChannel, r, g, b);
      if (r !== 0 || g !== 0 || b !== 0) nonBlackPixels += 1;
    }
    return { width: canvas.width, height: canvas.height, nonBlackPixels, maxChannel };
  }, `data:image/png;base64,${shot.toString('base64')}`);
}

test('loads committed study UI and paints the main 2D canvas', async ({ page }) => {
  // Shape: ["console.error: ...", "pageerror: ..."].
  const seriousErrors = [];

  page.on('console', (message) => {
    const text = seriousMessage(message);
    if (text) seriousErrors.push(text);
  });
  page.on('pageerror', (error) => {
    seriousErrors.push(`pageerror: ${error.message}`);
  });

  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);

  const manifest = await page.evaluate(() => fetch('/data/manifest.json').then(r => r.json()));
  if (manifest.series.length === 0) {
    await expect(page.locator('#series-list li')).toHaveCount(0);
    await expect(page.locator('#canvas-wrap')).toHaveClass(/no-series/);
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('#empty-state')).toContainText('Drop files anywhere');
    await expect(page.locator('#series-name')).toHaveText('—');
    expect(seriousErrors, `serious browser errors:\n${seriousErrors.join('\n')}`).toEqual([]);
    return;
  }

  const primaryIndex = Math.max(0, manifest.series.findIndex((series) =>
    !series?.sliceUrlBase
    && (series?.reconstructionCapability === 'display-volume' || series?.geometryKind === 'volumeStack')
  ));
  const primarySeries = manifest.series[primaryIndex];

  await expect(page.locator('#series-list li').nth(primaryIndex)).toBeVisible();
  await page.locator('#series-list li').nth(primaryIndex).click();
  await expect(page.locator('#series-list .sname').nth(primaryIndex)).toHaveText(primarySeries.name);
  await expect(page.locator('#series-name')).toHaveText(primarySeries.name);
  await expect(page.locator('#slice-cur')).toHaveText('1');
  await expect(page.locator('#slice-tot')).toHaveText(String(primarySeries.slices));
  await expect(page.locator('#canvas-wrap')).toBeVisible();
  await expect(page.locator('#view')).toBeVisible();

  const stats = await waitForCanvasPaint(page);
  expect(stats.hasContext, `main canvas did not expose a 2D context: ${JSON.stringify(stats)}`).toBe(true);
  expect(stats.width, `main canvas width was unexpected: ${JSON.stringify(stats)}`).toBe(primarySeries.width);
  expect(stats.height, `main canvas height was unexpected: ${JSON.stringify(stats)}`).toBe(primarySeries.height);
  expect(stats.nonBlackPixels, `main canvas did not paint nonblack pixels in headless mode: ${JSON.stringify(stats)}`).toBeGreaterThan(0);
  expect(stats.maxChannel, `main canvas max channel stayed blank in headless mode: ${JSON.stringify(stats)}`).toBeGreaterThan(0);

  await page.locator('#btn-mpr').click();
  await expect(page.locator('#mpr-ax')).toBeVisible();
  await expect(page.locator('#mpr-ob')).toBeVisible();
  await expect(page.locator('#mpr-gpu-toggle')).toBeVisible();
  await page.locator('#scrub').evaluate(async (scrub) => {
    const max = Number(scrub.max || 0);
    for (let i = 0; i < 90; i += 1) {
      scrub.value = String(i % (max + 1));
      scrub.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  const axialMprStats = await waitForCanvasPaint(page, '#mpr-ax');
  expect(axialMprStats.nonBlackPixels, `axial MPR stayed blank after scrub burst: ${JSON.stringify(axialMprStats)}`).toBeGreaterThan(0);
  const coronalMprStats = await waitForCanvasPaint(page, '#mpr-co');
  const sagittalMprStats = await waitForCanvasPaint(page, '#mpr-sa');
  expect(coronalMprStats.nonBlackPixels, `coronal MPR stayed blank: ${JSON.stringify(coronalMprStats)}`).toBeGreaterThan(0);
  expect(sagittalMprStats.nonBlackPixels, `sagittal MPR stayed blank: ${JSON.stringify(sagittalMprStats)}`).toBeGreaterThan(0);
  const orthogonalMprDims = await page.evaluate(async (selectedSlug) => {
    const manifest = await fetch('/data/manifest.json').then(r => r.json());
    const series = manifest.series.find(item => item.slug === selectedSlug);
    const [fx, fy, fz] = series.firstIPP;
    const [lx, ly, lz] = series.lastIPP;
    const span = Math.hypot(lx - fx, ly - fy, lz - fz);
    const zSpacing = span / Math.max(1, series.slices - 1);
    return {
      coHeight: document.querySelector('#mpr-co').height,
      expectedCoHeight: Math.max(16, Math.min(2048, Math.round(series.slices * zSpacing / series.pixelSpacing[1]))),
      sagittalHeight: document.querySelector('#mpr-sa').height,
      expectedSagittalHeight: Math.max(16, Math.min(2048, Math.round(series.slices * zSpacing / series.pixelSpacing[0]))),
    };
  }, primarySeries.slug);
  expect(orthogonalMprDims.coHeight).toBe(orthogonalMprDims.expectedCoHeight);
  expect(orthogonalMprDims.sagittalHeight).toBe(orthogonalMprDims.expectedSagittalHeight);
  await page.waitForTimeout(250);
  const obliqueMprStats = await waitForCanvasPaint(page, '#mpr-ob');
  expect(obliqueMprStats.nonBlackPixels, `oblique MPR stayed blank after deferred redraw: ${JSON.stringify(obliqueMprStats)}`).toBeGreaterThan(0);
  await page.locator('#mpr-gpu-toggle').check();
  await expect(page.locator('#mpr-gpu-note')).toHaveText(/GPU|N\/A/);
  await page.waitForTimeout(200);
  const gpuObliqueStats = await waitForCanvasPaint(page, '#mpr-ob');
  expect(gpuObliqueStats.nonBlackPixels, `GPU MPR toggle blanked the oblique pane: ${JSON.stringify(gpuObliqueStats)}`).toBeGreaterThan(0);
  await page.locator('#btn-mpr').click();

  expect(seriousErrors, `serious browser errors:\n${seriousErrors.join('\n')}`).toEqual([]);

  await page.locator('#btn-3d').click();
  await expect(page.locator('#three-container.active canvas')).toBeVisible();
  await page.locator('#btn-3d').click();

  await page.waitForTimeout(250);
});

test('no-local-backend mode still loads committed static analysis sidecars', async ({ page }) => {
  const response = await page.goto('/?localBackend=0', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);

  const manifest = await page.evaluate(() => fetch('/data/manifest.json').then(r => r.json()));
  if (manifest.series.length === 0) {
    await expect(page.locator('#series-list li')).toHaveCount(0);
    await expect(page.locator('#canvas-wrap')).toHaveClass(/no-series/);
    await expect(page.locator('#empty-state')).toBeVisible();
    return;
  }

  const primarySeries = manifest.series[0];
  await expect(page.locator('#series-list li').first()).toBeVisible();
  await page.locator('#series-list li').first().click();
  await expect(page.locator('#series-name')).toHaveText(primarySeries.name);
  await expect(page.locator('#btn-upload')).toBeVisible();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#btn-ask')).toHaveClass(/hidden/);
  await expect(page.locator('#btn-consult')).toHaveClass(/hidden/);
  const findingsState = await page.locator('#findings').evaluate((host) => ({
    summary: host.querySelector('.f-summary')?.textContent?.trim() || '',
    findingCount: host.querySelectorAll('.finding').length,
    status: host.querySelector('#gen-status')?.textContent?.trim() || '',
  }));
  expect(
    findingsState.summary.includes(primarySeries.name)
      || findingsState.findingCount > 0
      || findingsState.status.includes('cached sidecars appear here when present'),
    `unexpected no-local-backend findings state: ${JSON.stringify(findingsState)}`,
  ).toBe(true);
});

test('config aiAnalysis=false hides local AI actions when the local backend is available', async ({ page }) => {
  await page.route('**/config.json', async (route) => {
    const upstream = await route.fetch();
    const base = await upstream.json().catch(() => ({}));
    // Shape: config override used only for this test run.
    const overridden = {
      ...base,
      localAiAvailable: false,
      features: {
        ...(base.features || {}),
        aiAnalysis: false,
      },
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overridden) });
  });

  try {
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);

    const manifest = await page.evaluate(() => fetch('/data/manifest.json').then(r => r.json()));
    if (manifest.series.length === 0) return;

    await expect(page.locator('#btn-ask')).toHaveClass(/hidden/);
    await expect(page.locator('#btn-consult')).toHaveClass(/hidden/);
    await expect(page.locator('#regen-analysis')).toHaveCount(0);

    const ctSeries = page.locator('#series-list li').filter({ hasText: 'CT Chest 2' });
    if (await ctSeries.count()) {
      await ctSeries.first().click();
      await expect(page.locator('#gen-current-analysis')).toHaveCount(0);
      await expect(page.locator('#gen-analysis')).toHaveCount(0);
      await expect(page.locator('#gen-status')).toContainText('AI analysis is disabled');
    }
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});
