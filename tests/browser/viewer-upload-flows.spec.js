import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5WZ1AAAAAASUVORK5CYII=';

async function writeTinyNifti(path) {
  const buffer = Buffer.alloc(352 + 8);
  buffer.writeInt32LE(348, 0);
  buffer.writeInt16LE(3, 40);
  buffer.writeInt16LE(2, 42);
  buffer.writeInt16LE(2, 44);
  buffer.writeInt16LE(2, 46);
  buffer.writeInt16LE(2, 70);
  buffer.writeFloatLE(1, 76 + 4);
  buffer.writeFloatLE(1, 76 + 8);
  buffer.writeFloatLE(1, 76 + 12);
  buffer.writeFloatLE(352, 108);
  for (let index = 0; index < 8; index += 1) buffer[352 + index] = index * 16;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

function enhancedMetadataInstance() {
  return {
    '00080060': { vr: 'CS', Value: ['CT'] },
    '0020000E': { vr: 'UI', Value: ['1.2.series'] },
    '0020000D': { vr: 'UI', Value: ['1.2.study'] },
    '00080018': { vr: 'UI', Value: ['1.2.sop.1'] },
    '0008103E': { vr: 'LO', Value: ['DICOMweb CT'] },
    '00280008': { vr: 'IS', Value: [2] },
    '00280010': { vr: 'US', Value: [2] },
    '00280011': { vr: 'US', Value: [2] },
    '00280100': { vr: 'US', Value: [16] },
    '00280101': { vr: 'US', Value: [16] },
    '00200052': { vr: 'UI', Value: ['1.2.for'] },
    '00083002': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
    '52009229': {
      vr: 'SQ',
      Value: [{
        '00289110': { vr: 'SQ', Value: [{ '00280030': { vr: 'DS', Value: [0.5, 0.5] }, '00180050': { vr: 'DS', Value: [1.0] } }] },
        '00209116': { vr: 'SQ', Value: [{ '00200037': { vr: 'DS', Value: [1, 0, 0, 0, 1, 0] } }] },
      }],
    },
    '52009230': {
      vr: 'SQ',
      Value: [
        { '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 0] } }] } },
        { '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 1] } }] } },
      ],
    },
  };
}

async function routeConfig(page, override = {}) {
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
        ai: {
          enabled: true,
          provider: 'claude',
          ready: true,
          issues: [],
        },
        siteName: 'VoxelLab',
        disclaimer: 'Not for clinical use. For research and educational purposes only.',
        ...override,
        features: {
          cloudProcessing: true,
          aiAnalysis: true,
          ...(override.features || {}),
        },
      }),
    });
  });
}

async function routeManifest(page, manifest) {
  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(manifest),
    });
  });
}

async function routeTinyPngStack(page, slug, slices = 1) {
  const body = Buffer.from(TINY_PNG_BASE64, 'base64');
  await page.route(`**/data/${slug}/*.png`, async (route) => {
    const file = route.request().url().split('/').pop() || '';
    const index = Number.parseInt(file.replace('.png', ''), 10);
    if (!Number.isFinite(index) || index < 0 || index >= slices) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body,
    });
  });
}

async function openUploadModal(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#btn-upload')).toBeVisible();
  await page.waitForFunction(() => typeof document.getElementById('btn-upload')?.onclick === 'function');
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-modal .ask-title')).toHaveText('Open a study');
}

async function acceleratePolling(page) {
  await page.addInitScript(() => {
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms = 0, ...args) => realSetTimeout(fn, Math.min(Number(ms) || 0, 10), ...args);
  });
}

async function routeDerivedDcmjsStub(page) {
  await page.route('https://cdn.jsdelivr.net/npm/dcmjs@0.33.0/build/dcmjs.es.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        const data = {
          DicomMetaDictionary: {
            naturalizeDataset(instance) {
              const embedded = instance?.['77770001']?.Value?.[0];
              if (embedded && typeof embedded === 'object') return embedded;
              const modality = instance?.['00080060']?.Value?.[0] || '';
              if (modality === 'RTDOSE') {
                return {
                  Modality: 'RTDOSE',
                  SeriesInstanceUID: instance?.['0020000E']?.Value?.[0] || '',
                  SOPInstanceUID: instance?.['00080018']?.Value?.[0] || '',
                  SeriesDescription: instance?.['0008103E']?.Value?.[0] || '',
                  Rows: instance?.['00280010']?.Value?.[0] || 0,
                  Columns: instance?.['00280011']?.Value?.[0] || 0,
                  NumberOfFrames: instance?.['00280008']?.Value?.[0] || 1,
                  DoseGridScaling: instance?.['3004000E']?.Value?.[0] || 0,
                  DoseUnits: instance?.['30040002']?.Value?.[0] || '',
                  DoseType: instance?.['30040004']?.Value?.[0] || '',
                  DoseSummationType: instance?.['3004000A']?.Value?.[0] || '',
                  FrameOfReferenceUID: instance?.['00200052']?.Value?.[0] || '',
                  ReferencedSeriesSequence: [{
                    SeriesInstanceUID: instance?.['00081115']?.Value?.[0]?.['0020000E']?.Value?.[0] || '',
                  }],
                };
              }
              return {};
            },
          },
        };
        export { data };
        export default { data };
      `,
    });
  });
}

async function waitForCanvasPaint(page, selector) {
  await expect.poll(async () => {
    return await page.locator(selector).evaluate((canvas) => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { width: canvas.width, height: canvas.height, nonBlackPixels: 0, maxChannel: 0 };
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlackPixels = 0;
      let maxChannel = 0;
      for (let index = 0; index < data.length; index += 4) {
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        maxChannel = Math.max(maxChannel, r, g, b);
        if (r !== 0 || g !== 0 || b !== 0) nonBlackPixels += 1;
      }
      return { width: canvas.width, height: canvas.height, nonBlackPixels, maxChannel };
    });
  }, { timeout: 10_000 }).toMatchObject({ nonBlackPixels: expect.any(Number), maxChannel: expect.any(Number) });
  await expect.poll(async () => {
    return await page.locator(selector).evaluate((canvas) => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return 0;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlackPixels = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) nonBlackPixels += 1;
      }
      return nonBlackPixels;
    });
  }, { timeout: 10_000 }).toBeGreaterThan(0);
}

async function waitForThreeSurface(page) {
  // Shape: { active: true, mounted: true, width: 448, height: 630, clientWidth: 448, clientHeight: 630 }
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const container = document.getElementById('three-container');
      const canvas = container?.querySelector('canvas');
      return {
        active: container?.classList.contains('active') || false,
        mounted: Boolean(canvas),
        width: canvas?.width || 0,
        height: canvas?.height || 0,
        clientWidth: canvas?.clientWidth || 0,
        clientHeight: canvas?.clientHeight || 0,
      };
    });
  }, { timeout: 10_000 }).toEqual({
    active: true,
    mounted: true,
    width: expect.any(Number),
    height: expect.any(Number),
    clientWidth: expect.any(Number),
    clientHeight: expect.any(Number),
  });
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const canvas = document.querySelector('#three-container canvas');
      return {
        width: canvas?.width || 0,
        height: canvas?.height || 0,
        clientWidth: canvas?.clientWidth || 0,
        clientHeight: canvas?.clientHeight || 0,
      };
    });
  }, { timeout: 10_000 }).toMatchObject({
    width: expect.any(Number),
    height: expect.any(Number),
    clientWidth: expect.any(Number),
    clientHeight: expect.any(Number),
  });
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const canvas = document.querySelector('#three-container canvas');
      return Math.min(
        canvas?.width || 0,
        canvas?.height || 0,
        canvas?.clientWidth || 0,
        canvas?.clientHeight || 0,
      );
    });
  }, { timeout: 10_000 }).toBeGreaterThan(0);
}

async function dropFile(page, selector, path, mimeType = 'application/octet-stream') {
  const bytes = Array.from(await readFile(path));
  const name = path.split('/').pop();
  const dataTransfer = await page.evaluateHandle(({ fileBytes, fileName, fileType }) => {
    const dt = new DataTransfer();
    const file = new File([new Uint8Array(fileBytes)], fileName, { type: fileType });
    dt.items.add(file);
    return dt;
  }, { fileBytes: bytes, fileName: name, fileType: mimeType });
  await page.locator(selector).dispatchEvent('drop', { dataTransfer });
}

test('upload modal only advertises DICOM files in the picker', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const accept = await page.locator('#upload-file-input').getAttribute('accept');
  expect(accept || '').toContain('.dcm');
  expect(accept || '').toContain('application/dicom');
  expect(accept || '').not.toContain('.nii');
  expect(accept || '').not.toContain('.nii.gz');
});

test('upload modal can drag-and-drop a local NIfTI file through 2D, MPR, and 3D rendering', async ({ page }, testInfo) => {
  const niftiPath = testInfo.outputPath('tiny-upload.nii');
  await writeTinyNifti(niftiPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFile(page, '#upload-zone', niftiPath);

  await expect(page.locator('#series-name')).toHaveText('tiny-upload');
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await waitForCanvasPaint(page, '#view');

  await page.locator('#btn-mpr').click();
  await expect(page.locator('#mpr-ax')).toBeVisible();
  await expect(page.locator('#mpr-co')).toBeVisible();
  await expect(page.locator('#mpr-sa')).toBeVisible();
  await waitForCanvasPaint(page, '#mpr-ax');
  await waitForCanvasPaint(page, '#mpr-co');
  await waitForCanvasPaint(page, '#mpr-sa');

  await page.locator('#btn-3d').click();
  await expect(page.locator('#btn-3d')).toHaveClass(/active/);
  await waitForThreeSurface(page);
});

test('persisted SEG overlays hydrate on the first series selection after reload', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '' });
  await routeManifest(page, {
    patient: 'anonymous',
    studyDate: '',
    series: [{
      slug: 'ct_chest_1',
      name: 'CT Chest 1',
      description: '1 slice',
      modality: 'CT',
      slices: 1,
      width: 1,
      height: 1,
      pixelSpacing: [1, 1],
      sliceThickness: 1,
    }],
  });
  await routeTinyPngStack(page, 'ct_chest_1', 1);
  await page.addInitScript(() => {
    // Shape: localStorage registry entry for a persisted SEG-derived labels overlay.
    localStorage.setItem('mri-viewer/derived-objects/v1', JSON.stringify({
      version: 1,
      entries: {
        'slug:ct_chest_1|obj:seg-test': {
          id: 'slug:ct_chest_1|obj:seg-test',
          objectUID: 'seg-test',
          name: 'Imported SEG',
          modality: 'SEG',
          importedAt: 1,
          binding: {
            derivedKind: 'seg',
            frameOfReferenceUID: '',
            sourceSeriesSlug: 'ct_chest_1',
            requiresRegistration: false,
            affineCompatibility: 'exact',
          },
          payload: {
            format: 'seg-overlay-v1',
            sparseSlices: [[0, 1]],
            regionMeta: {
              regions: { 1: { name: 'Imported SEG', source: 'dicom-seg' } },
              colors: { 1: [255, 0, 0] },
            },
          },
        },
      },
    }));
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#series-list li.active')).toBeVisible();
  await expect(page.locator('#series-name')).not.toHaveText('—');
  await expect(page.locator('#slice-cur')).not.toHaveText('');
  const sourceSeries = page.locator('#series-list li').filter({ hasText: 'CT Chest 1' });
  await expect(sourceSeries).toBeVisible();
  await sourceSeries.click();
  await expect(page.locator('#series-name')).toHaveText('CT Chest 1');
  await expect.poll(async () => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const series = state.manifest.series.find((item) => item.slug === 'ct_chest_1');
    const button = document.getElementById('btn-regions');
    return {
      hasRegions: !!series?.hasRegions,
      hasRegionMeta: !!state.regionMeta?.regions?.[1],
      buttonHidden: button?.classList.contains('hidden') || false,
    };
  }), { timeout: 10_000 }).toEqual({
    hasRegions: true,
    hasRegionMeta: true,
    buttonHidden: false,
  });
  await page.evaluate(() => document.getElementById('btn-regions')?.click());

  await expect.poll(async () => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return {
      useRegions: !!state.useRegions,
      hasRegionMeta: !!state.regionMeta?.regions?.[1],
      regionImageCount: state.regionImgs?.length || 0,
      firstRegionReady: !!state.regionImgs?.[0]?.complete,
      buttonActive: document.getElementById('btn-regions')?.classList.contains('active') || false,
    };
  }), { timeout: 10_000 }).toEqual({
    useRegions: true,
    hasRegionMeta: true,
    regionImageCount: 1,
    firstRegionReady: true,
    buttonActive: true,
  });
});

test('upload modal can discover and import a DICOMweb series through the real UI flow', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '' });
  await page.route('https://pacs.example/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === '/studies') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          '0020000D': { vr: 'UI', Value: ['1.2.study'] },
          '00100010': { vr: 'PN', Value: [{ Alphabetic: 'DOE^JANE' }] },
          '00080020': { vr: 'DA', Value: ['20260101'] },
          '00201206': { vr: 'IS', Value: [1] },
        }]),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          '0020000D': { vr: 'UI', Value: ['1.2.study'] },
          '0020000E': { vr: 'UI', Value: ['1.2.series'] },
          '00200011': { vr: 'IS', Value: [7] },
          '0008103E': { vr: 'LO', Value: ['DICOMweb CT'] },
          '00080060': { vr: 'CS', Value: ['CT'] },
          '00201209': { vr: 'IS', Value: [2] },
        }]),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.series/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([enhancedMetadataInstance()]),
      });
    }
    if (requestUrl.pathname.endsWith('/frames/1') || requestUrl.pathname.endsWith('/frames/2')) {
      const frame = requestUrl.pathname.endsWith('/frames/1') ? new Uint16Array([1, 2, 3, 4]) : new Uint16Array([5, 6, 7, 8]);
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: Buffer.from(frame.buffer),
      });
    }
    throw new Error(`Unhandled DICOMweb request: ${requestUrl.toString()}`);
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-query').fill('DOE*');
  await page.locator('#dicomweb-find-studies-btn').click();
  await expect(page.locator('#dicomweb-study')).toHaveValue('1.2.study');
  await page.locator('#dicomweb-find-series-btn').click();
  await expect(page.locator('#dicomweb-series')).toHaveValue('1.2.series');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#btn-mpr')).toBeVisible();
  await expect(page.locator('#btn-3d')).toBeVisible();
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-list')).toContainText('DICOMweb CT');
  await page.locator('#btn-mpr').click();
  await expect(page.locator('#mpr-ax')).toBeVisible();
  await expect(page.locator('#mpr-co')).toBeVisible();
  await expect(page.locator('#mpr-sa')).toBeVisible();
  await waitForCanvasPaint(page, '#mpr-ax');
  await waitForCanvasPaint(page, '#mpr-co');
  await waitForCanvasPaint(page, '#mpr-sa');
});

test('upload modal can bind a DICOMweb RT Dose series onto an already loaded source study', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '' });
  await routeDerivedDcmjsStub(page);
  await page.route('https://pacs.example/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.series/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([enhancedMetadataInstance()]),
      });
    }
    if (requestUrl.pathname.endsWith('/frames/1') || requestUrl.pathname.endsWith('/frames/2')) {
      const frame = requestUrl.pathname.endsWith('/frames/1') ? new Uint16Array([1, 2, 3, 4]) : new Uint16Array([5, 6, 7, 8]);
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: Buffer.from(frame.buffer),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.dose/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          '00080060': { vr: 'CS', Value: ['RTDOSE'] },
          '0020000E': { vr: 'UI', Value: ['1.2.dose'] },
          '00080018': { vr: 'UI', Value: ['1.2.dose.object'] },
          '0008103E': { vr: 'LO', Value: ['Dose Summary'] },
          '00280010': { vr: 'US', Value: [32] },
          '00280011': { vr: 'US', Value: [16] },
          '00280008': { vr: 'IS', Value: [4] },
          '00200052': { vr: 'UI', Value: ['1.2.for'] },
          '3004000E': { vr: 'DS', Value: ['0.001'] },
          '30040002': { vr: 'CS', Value: ['GY'] },
          '30040004': { vr: 'CS', Value: ['PHYSICAL'] },
          '3004000A': { vr: 'CS', Value: ['PLAN'] },
          '00081115': {
            vr: 'SQ',
            Value: [{ '0020000E': { vr: 'UI', Value: ['1.2.series'] } }],
          },
        }]),
      });
    }
    throw new Error(`Unhandled DICOMweb request: ${requestUrl.toString()}`);
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.series');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.dose');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container')).toContainText('Imported RTDOSE onto');
  const derivedRegistry = await page.evaluate(() => JSON.parse(localStorage.getItem('mri-viewer/derived-objects/v1') || '{"entries":{}}'));
  const doseEntry = Object.values(derivedRegistry.entries || {}).find((entry) => entry?.binding?.derivedKind === 'rtdose');
  expect(doseEntry).toMatchObject({
    modality: 'RTDOSE',
    payload: {
      format: 'rtdose-summary-v1',
      rows: 32,
      cols: 16,
      frames: 4,
      doseUnits: 'GY',
      doseType: 'PHYSICAL',
      doseSummationType: 'PLAN',
    },
  });
});

test('upload modal can bind DICOMweb RTSTRUCT and SR objects onto an already loaded source study', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '' });
  await routeDerivedDcmjsStub(page);
  let sourceSlug = '';

  await page.route('https://pacs.example/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.series/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([enhancedMetadataInstance()]),
      });
    }
    if (requestUrl.pathname.endsWith('/frames/1') || requestUrl.pathname.endsWith('/frames/2')) {
      const frame = requestUrl.pathname.endsWith('/frames/1') ? new Uint16Array([1, 2, 3, 4]) : new Uint16Array([5, 6, 7, 8]);
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: Buffer.from(frame.buffer),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.rtstruct/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          '00080060': { vr: 'CS', Value: ['RTSTRUCT'] },
          '77770001': {
            vr: 'UN',
            Value: [{
              Modality: 'RTSTRUCT',
              SeriesInstanceUID: '1.2.rtstruct',
              SOPInstanceUID: '1.2.rtstruct.object',
              SeriesDescription: 'Contours',
              ReferencedFrameOfReferenceSequence: [{
                RTReferencedStudySequence: [{
                  RTReferencedSeriesSequence: [{ SeriesInstanceUID: '1.2.series' }],
                }],
              }],
              StructureSetROISequence: [{ ROINumber: 1, ROIName: 'Lesion' }],
              ROIContourSequence: [{
                ReferencedROINumber: 1,
                ContourSequence: [{
                  ContourGeometricType: 'CLOSED_PLANAR',
                  ContourData: [
                    0, 0, 0,
                    1, 0, 0,
                    1, 1, 0,
                    0, 1, 0,
                  ],
                }],
              }],
            }],
          },
        }]),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.sr/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          '00080060': { vr: 'CS', Value: ['SR'] },
          '77770001': {
            vr: 'UN',
            Value: [{
              Modality: 'SR',
              SeriesInstanceUID: '1.2.sr',
              SOPInstanceUID: '1.2.sr.object',
              SeriesDescription: 'Measurements',
              ContentSequence: [{
                ValueType: 'CONTAINER',
                ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
                ContentSequence: [
                  {
                    ValueType: 'TEXT',
                    ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
                    TextValue: `${sourceSlug} slice 2`,
                  },
                  {
                    ValueType: 'NUM',
                    ConceptNameCodeSequence: [{ CodeMeaning: 'Length' }],
                    MeasuredValueSequence: [{ NumericValue: '12.5' }],
                  },
                  {
                    ValueType: 'TEXT',
                    ConceptNameCodeSequence: [{ CodeMeaning: 'Comment' }],
                    TextValue: 'Follow-up target',
                  },
                ],
              }],
            }],
          },
        }]),
      });
    }
    throw new Error(`Unhandled DICOMweb request: ${requestUrl.toString()}`);
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.series');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  sourceSlug = await page.locator('#series-list li.active').getAttribute('data-series-slug') || '';
  expect(sourceSlug).toBeTruthy();

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.rtstruct');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  const rois = await page.evaluate(() => JSON.parse(localStorage.getItem('mri-viewer/rois/v1') || '{}'));
  expect(rois[`${sourceSlug}|0`]?.[0]).toMatchObject({
    shape: 'polygon',
    text: 'Lesion',
  });

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.sr');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container')).toContainText(`Imported SR onto ${sourceSlug}.`);
  const annotations = await page.evaluate(() => JSON.parse(localStorage.getItem('mri-viewer/annotations/v1') || '{}'));
  expect(annotations[`${sourceSlug}|1`]?.[0]?.text || '').toContain('Length: 12.5');
  expect(annotations[`${sourceSlug}|1`]?.[0]?.text || '').toContain('Comment: Follow-up target');
  const derivedRegistry = await page.evaluate(() => JSON.parse(localStorage.getItem('mri-viewer/derived-objects/v1') || '{"entries":{}}'));
  const derivedKinds = Object.values(derivedRegistry.entries || {}).map((entry) => entry?.binding?.derivedKind).sort();
  expect(derivedKinds).toEqual(expect.arrayContaining(['rtstruct', 'sr']));
});

test('upload modal can start cloud processing through the local proxy path', async ({ page }, testInfo) => {
  const dicomPath = testInfo.outputPath('cloud-input.dcm');
  await writeFile(dicomPath, Buffer.from('dicom payload'));

  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  const seenProxyHeaders = [];
  const seenUploadHeaders = [];
  await page.route('**/api/cloud/get_upload_urls', async (route) => {
    seenProxyHeaders.push(route.request().headers()['x-voxellab-local-token']);
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        urls: Object.fromEntries((body.items || []).map((item) => [item.upload_id, 'https://upload.example/cloud-input.dcm'])),
      }),
    });
  });
  await page.route('**/api/cloud/start_processing', async (route) => {
    seenProxyHeaders.push(route.request().headers()['x-voxellab-local-token']);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    seenProxyHeaders.push(route.request().headers()['x-voxellab-local-token']);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          slug: 'cloud_job123',
          name: 'Cloud CT',
          description: '2 slices',
          slices: 2,
          width: 4,
          height: 4,
          pixelSpacing: [1, 1],
          sliceThickness: 1,
          hasRaw: true,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    seenUploadHeaders.push(route.request().headers()['x-voxellab-local-token']);
    await route.fulfill({ status: 200, body: '' });
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles(dicomPath);
  await expect(page.locator('#upload-cloud-btn')).toBeVisible();
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#series-name')).toHaveText('Cloud CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-list')).toContainText('Cloud CT');
  expect(seenProxyHeaders).toEqual(['local-token-123', 'local-token-123', 'local-token-123']);
  expect(seenUploadHeaders).toEqual([undefined]);
});

test('upload modal updates an existing cloud series instead of duplicating it', async ({ page }, testInfo) => {
  const dicomPath = testInfo.outputPath('cloud-repeat-input.dcm');
  await writeFile(dicomPath, Buffer.from('dicom payload'));

  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  let cloudRun = 0;
  await page.route('**/api/cloud/get_upload_urls', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        urls: Object.fromEntries((body.items || []).map((item) => [item.upload_id, 'https://upload.example/cloud-repeat-input.dcm'])),
      }),
    });
  });
  await page.route('**/api/cloud/start_processing', async (route) => {
    cloudRun += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          slug: 'cloud_job123',
          name: cloudRun === 1 ? 'Cloud CT' : 'Cloud CT Updated',
          description: cloudRun === 1 ? '2 slices' : '2 slices updated',
          slices: 2,
          width: 4,
          height: 4,
          pixelSpacing: [1, 1],
          sliceThickness: 1,
          hasRaw: true,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles(dicomPath);
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#series-name')).toHaveText('Cloud CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await page.locator('#upload-file-input').setInputFiles(dicomPath);
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#series-name')).toHaveText('Cloud CT Updated');
  await expect(page.locator('#series-desc')).toHaveText('2 slices updated');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-list')).toContainText('Cloud CT Updated');
});

test('upload modal keeps cloud job failures visible instead of pretending success', async ({ page }, testInfo) => {
  const dicomPath = testInfo.outputPath('cloud-error-input.dcm');
  await writeFile(dicomPath, Buffer.from('dicom payload'));

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  await page.route('**/api/cloud/get_upload_urls', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        urls: Object.fromEntries((body.items || []).map((item) => [item.upload_id, 'https://upload.example/cloud-error-input.dcm'])),
      }),
    });
  });
  await page.route('**/api/cloud/start_processing', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        error: 'GPU pipeline failed',
      }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });

  await openUploadModal(page);
  await page.locator('#upload-file-input').setInputFiles(dicomPath);
  await expect(page.locator('#upload-cloud-btn')).toBeVisible();
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('GPU pipeline failed');
  await expect(page.locator('#upload-cloud-btn')).toBeEnabled();
});
