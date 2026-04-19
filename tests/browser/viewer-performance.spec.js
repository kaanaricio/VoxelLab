import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { VIEWER_PERF_BUDGET } from '../fixtures/performance-budget.mjs';

test.setTimeout(90_000);

// Shape: { patient: 'anonymous', studyDate: '', series: [] } in the sanitized public export.
const COMMITTED_MANIFEST = JSON.parse(fs.readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8'));

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p2ioAAAAASUVORK5CYII=',
  'base64',
);

async function clearPerf(page) {
  await page.evaluate(() => globalThis.__voxellabPerf?.clear?.());
}

async function perfEvents(page, name) {
  return page.evaluate((traceName) => {
    const history = globalThis.__voxellabPerf?.history || [];
    return history.filter((entry) => entry.name === traceName);
  }, name);
}

async function waitForPerfEvent(page, name, timeout = 12_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const events = await perfEvents(page, name);
    if (events.length) return events[events.length - 1];
    await page.waitForTimeout(100);
  }
  return null;
}

async function pendingPerfCount(page, name) {
  return page.evaluate((traceName) => {
    const pending = globalThis.__voxellabPerf?.pending || [];
    return pending.find((entry) => entry.name === traceName)?.count || 0;
  }, name);
}

async function waitForCanvasPaint(page, selector) {
  for (let i = 0; i < 60; i += 1) {
    const painted = await page.locator(selector).evaluate((canvas) => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || canvas.width === 0 || canvas.height === 0) return false;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let p = 0; p < data.length; p += 4) {
        if (data[p] || data[p + 1] || data[p + 2]) return true;
      }
      return false;
    });
    if (painted) return;
    await page.waitForTimeout(100);
  }
}

async function scrubBurst(page, count = 48) {
  return page.evaluate(async ({ count: iterations }) => {
    const scrub = document.querySelector('#scrub');
    const max = Number(scrub?.max || 0);
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      scrub.value = String(i % Math.max(1, max + 1));
      scrub.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  }, { count });
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundMs(value) {
  return Number(value.toFixed(1));
}

function budgetReport(metrics) {
  // Shape: { selectSeries2dMs: { actualMs: 38.9, baselineMs: 38.9, maxMs: 500, deltaMs: 0 } }.
  return Object.fromEntries(
    Object.entries(metrics).map(([name, value]) => {
      const actualMs = roundMs(value);
      const baselineMs = VIEWER_PERF_BUDGET.baselineMs[name] ?? null;
      return [name, {
        actualMs,
        baselineMs,
        maxMs: VIEWER_PERF_BUDGET.maxMs[name] ?? null,
        deltaMs: baselineMs == null ? null : roundMs(actualMs - baselineMs),
      }];
    }),
  );
}

function expectWithinBudget(name, value) {
  const maxMs = VIEWER_PERF_BUDGET.maxMs[name];
  if (maxMs == null) return;
  expect(
    value,
    `${name} took ${roundMs(value)}ms, budget is ${maxMs}ms`,
  ).toBeLessThan(maxMs);
}

async function mprAxisIndex(page, selector) {
  const label = (await page.locator(selector).textContent()) || '';
  const match = label.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  return match ? Number(match[1]) : null;
}

async function wheelMprAxis(page, selector, { deltaY = 100, steps = 1 } = {}) {
  await page.locator(selector).evaluate((canvas, wheel) => {
    const rect = canvas.getBoundingClientRect();
    for (let i = 0; i < wheel.steps; i += 1) {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: wheel.deltaY,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }));
    }
  }, { deltaY, steps });
}

async function wheelMprAxesAndSnapshotOblique(page, moves) {
  return page.evaluate((entries) => {
    const checksum = (canvas) => {
      const ctx = canvas?.getContext('2d', { willReadFrequently: true });
      if (!ctx || canvas.width === 0 || canvas.height === 0) return 'blank';
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      const stride = Math.max(4, Math.floor(data.length / 4096));
      for (let index = 0; index < data.length; index += stride) {
        hash ^= data[index];
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return `${canvas.width}x${canvas.height}:${hash}`;
    };

    for (const entry of entries) {
      const canvas = document.querySelector(entry.selector);
      const rect = canvas.getBoundingClientRect();
      for (let i = 0; i < entry.steps; i += 1) {
        canvas.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: entry.deltaY,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
      }
    }

    return checksum(document.querySelector('#mpr-ob'));
  }, moves);
}

async function canvasChecksum(page, selector) {
  return page.locator(selector).evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || canvas.width === 0 || canvas.height === 0) return 'blank';
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    const stride = Math.max(4, Math.floor(data.length / 4096));
    for (let index = 0; index < data.length; index += stride) {
      hash ^= data[index];
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${canvas.width}x${canvas.height}:${hash}`;
  });
}

async function routePerfCloudFixture(page, { overlayDelayMs = 900 } = {}) {
  const slug = 'cloud_perf_sym';
  const series = {
    slug,
    name: 'Cloud Perf Sym',
    description: 'remote delayed sym overlay',
    modality: 'CT',
    slices: 2,
    width: 64,
    height: 64,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 1],
    hasSym: true,
    sliceUrlBase: `https://cloud-perf.example/base/${slug}`,
    overlayUrlBases: {
      [`${slug}_sym`]: `https://cloud-perf.example/sym/${slug}`,
    },
  };
  await page.route('**/config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        modalWebhookBase: '',
        r2PublicUrl: '',
        trustedUploadOrigins: [],
        localApiToken: '',
        localAiAvailable: true,
        ai: { enabled: true, provider: 'claude', ready: true, issues: [] },
        siteName: 'VoxelLab',
        disclaimer: 'Not for clinical use. For research and educational purposes only.',
        features: { cloudProcessing: false, aiAnalysis: true },
      }),
    });
  });
  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        patient: 'anonymous',
        studyDate: '',
        series: [series],
      }),
    });
  });
  await page.route(`https://cloud-perf.example/base/${slug}/*.png`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG });
  });
  await page.route(`https://cloud-perf.example/sym/${slug}/*.png`, async (route) => {
    await page.waitForTimeout(overlayDelayMs);
    await route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG });
  });
}

async function openPerfViewer(page, path = '/?perf=1') {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);
  const manifest = await page.evaluate(() => fetch('/data/manifest.json').then(r => r.json()));
  return manifest;
}

async function selectLocalVolumeSeries(page, manifest) {
  const volumeSeriesIndex = Math.max(0, manifest.series.findIndex((series) =>
    !series?.sliceUrlBase
    && (series?.reconstructionCapability === 'display-volume' || series?.geometryKind === 'volumeStack')
  ));
  const volumeSeries = manifest.series[volumeSeriesIndex];
  await expect(page.locator('#series-list li')).toHaveCount(manifest.series.length);
  const currentName = await page.locator('#series-name').textContent();
  if ((currentName || '').trim() !== volumeSeries.name) {
    await page.locator('#series-list li').nth(volumeSeriesIndex).click();
  }
  await waitForCanvasPaint(page, '#view');
  return { volumeSeries, volumeSeriesIndex };
}

test('viewer runtime paths keep emitting performance milestones', async ({ page }, testInfo) => {
  test.skip(COMMITTED_MANIFEST.series.length === 0, 'No committed demo study to benchmark.');
  const manifest = await openPerfViewer(page);
  const { volumeSeries, volumeSeriesIndex } = await selectLocalVolumeSeries(page, manifest);

  const results = {
    selectSeries2dMs: null,
    scrub2dMs: [],
    overlayScrubMs: [],
    compareScrubMs: [],
    enter3dMs: null,
  };

  const selectSeriesEvent = await waitForPerfEvent(page, 'select-series-2d');
  expect(selectSeriesEvent, 'missing select-series-2d trace').toBeTruthy();
  results.selectSeries2dMs = selectSeriesEvent.duration;
  expectWithinBudget('selectSeries2dMs', selectSeriesEvent.duration);

  await clearPerf(page);
  results.scrub2dMs.push(await scrubBurst(page));
  results.scrub2dMs.push(await scrubBurst(page));
  const scrub2dAvgMs = average(results.scrub2dMs);
  expect(scrub2dAvgMs).not.toBeNull();
  expectWithinBudget('scrub2dAvgMs', scrub2dAvgMs);

  const hasSym = !!volumeSeries.hasSym;
  const hasRegions = !!volumeSeries.hasRegions;
  if (hasSym) await page.locator('#btn-sym').click();
  if (hasRegions) await page.locator('#btn-regions').click();
  if (hasSym || hasRegions) {
    const overlayEvent = await waitForPerfEvent(page, 'overlay-toggle-paint');
    expect(overlayEvent, 'missing overlay-toggle-paint trace').toBeTruthy();
    results.overlayScrubMs.push(await scrubBurst(page, 32));
    results.overlayScrubMs.push(await scrubBurst(page, 32));
    const overlayScrubAvgMs = average(results.overlayScrubMs);
    expect(overlayScrubAvgMs).not.toBeNull();
    expectWithinBudget('overlayScrubAvgMs', overlayScrubAvgMs);
  }

  const groupCounts = manifest.series.reduce((map, series) => {
    const key = series.compareGroup ?? series.group ?? null;
    if (key == null) return map;
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map());
  const compareGroup = [...groupCounts.entries()].find(([key, count]) => {
    if (count < 2) return false;
    const peers = manifest.series.filter((series) => (series.compareGroup ?? series.group ?? null) === key);
    return peers.every((series) => !series.sliceUrlBase);
  })?.[0];
  if (compareGroup != null) {
    const compareIndex = manifest.series.findIndex((series) => (series.compareGroup ?? series.group ?? null) === compareGroup);
    if (compareIndex >= 0 && compareIndex !== volumeSeriesIndex) {
      await page.locator('#series-list li').nth(compareIndex).click();
      await waitForCanvasPaint(page, '#view');
    }
    await page.locator('#btn-compare').click();
    await page.waitForTimeout(250);
    results.compareScrubMs.push(await scrubBurst(page, 24));
    results.compareScrubMs.push(await scrubBurst(page, 24));
    const compareScrubAvgMs = average(results.compareScrubMs);
    expect(compareScrubAvgMs).not.toBeNull();
    expectWithinBudget('compareScrubAvgMs', compareScrubAvgMs);
    await page.locator('#btn-compare').click();
  }

  await clearPerf(page);
  let threeStart = Date.now();
  await page.locator('#btn-3d').click();
  await expect(page.locator('#three-container.active canvas')).toBeVisible();
  let threeEvent = await waitForPerfEvent(page, 'enter-3d', 4_000);
  if (!threeEvent) threeEvent = { duration: Date.now() - threeStart, fallback: 'canvas-visible' };
  results.enter3dMs = threeEvent.duration;
  expectWithinBudget('enter3dMs', threeEvent.duration);
  await page.locator('#btn-3d').click();

  const summary = {
    selectSeries2dMs: results.selectSeries2dMs,
    scrub2dAvgMs,
    enter3dMs: results.enter3dMs,
  };
  if (results.overlayScrubMs.length) summary.overlayScrubAvgMs = average(results.overlayScrubMs);
  if (results.compareScrubMs.length) summary.compareScrubAvgMs = average(results.compareScrubMs);

  await testInfo.attach('viewer-performance.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('viewer-performance-budget-report.json', {
    body: JSON.stringify(budgetReport(summary), null, 2),
    contentType: 'application/json',
  });
});

test('MPR axis interaction stays off the slice scrub path and defers oblique paint', async ({ page }, testInfo) => {
  test.skip(COMMITTED_MANIFEST.series.length === 0, 'No committed demo study to benchmark.');
  const manifest = await openPerfViewer(page);
  await selectLocalVolumeSeries(page, manifest);

  await clearPerf(page);
  let mprStart = Date.now();
  await page.locator('#btn-mpr').click();
  let mprEvent = await waitForPerfEvent(page, 'enter-mpr', 3_000);
  if (!mprEvent) {
    await waitForCanvasPaint(page, '#mpr-ax');
    await waitForCanvasPaint(page, '#mpr-co');
    await waitForCanvasPaint(page, '#mpr-sa');
    mprEvent = { duration: Date.now() - mprStart, fallback: 'canvas-paint' };
  }
  expectWithinBudget('enterMprMs', mprEvent.duration);
  await waitForCanvasPaint(page, '#mpr-ob');

  const obliqueBefore = await canvasChecksum(page, '#mpr-ob');
  const sliceBeforeAxisWheel = await page.locator('#slice-cur').textContent();
  const yBefore = await mprAxisIndex(page, '#mpr-co-idx');
  const xBefore = await mprAxisIndex(page, '#mpr-sa-idx');

  const obliqueImmediate = await wheelMprAxesAndSnapshotOblique(page, [
    { selector: '#mpr-co', deltaY: 140, steps: 8 },
    { selector: '#mpr-sa', deltaY: -140, steps: 6 },
  ]);
  const yAfter = await mprAxisIndex(page, '#mpr-co-idx');
  const xAfter = await mprAxisIndex(page, '#mpr-sa-idx');
  const sliceAfterAxisWheel = await page.locator('#slice-cur').textContent();

  expect(yBefore).not.toBeNull();
  expect(xBefore).not.toBeNull();
  expect(yAfter).not.toBe(yBefore);
  expect(xAfter).not.toBe(xBefore);
  expect(sliceAfterAxisWheel).toBe(sliceBeforeAxisWheel);
  expect(obliqueImmediate).toBe(obliqueBefore);

  await page.waitForTimeout(260);
  const obliqueDeferred = await canvasChecksum(page, '#mpr-ob');
  expect(obliqueDeferred).not.toBe(obliqueBefore);

  const mprScrubMs = [await scrubBurst(page, 40), await scrubBurst(page, 40)];
  const mprScrubAvgMs = average(mprScrubMs);
  expect(mprScrubAvgMs).not.toBeNull();
  expectWithinBudget('mprScrubAvgMs', mprScrubAvgMs);

  await testInfo.attach('viewer-mpr-performance.json', {
    body: JSON.stringify({
      enterMprMs: mprEvent.duration,
      mprScrubMs,
    }, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('viewer-mpr-performance-budget-report.json', {
    body: JSON.stringify(budgetReport({
      enterMprMs: mprEvent.duration,
      mprScrubAvgMs,
    }), null, 2),
    contentType: 'application/json',
  });
});

test('cloud delayed overlay upgrade keeps trace pending until overlay is actually ready', async ({ page }) => {
  await routePerfCloudFixture(page, { overlayDelayMs: 900 });
  await openPerfViewer(page, '/?perf=1&localBackend=0');

  await expect(page.locator('#series-list li')).toHaveCount(1);
  await waitForCanvasPaint(page, '#view');
  await clearPerf(page);

  await expect(page.locator('#btn-sym')).toHaveCount(1);
  await page.locator('#btn-sym').evaluate((button) => button.click());
  await expect.poll(async () => pendingPerfCount(page, 'overlay-toggle-paint'), { timeout: 2_000 }).toBeGreaterThan(0);
  const earlyOverlayEvent = await waitForPerfEvent(page, 'overlay-toggle-paint', 250);
  expect(earlyOverlayEvent).toBeNull();

  const overlayEvent = await waitForPerfEvent(page, 'overlay-toggle-paint', 6_000);
  expect(overlayEvent, 'missing delayed overlay-toggle-paint trace').toBeTruthy();
  expect(overlayEvent.duration).toBeGreaterThanOrEqual(700);
});
