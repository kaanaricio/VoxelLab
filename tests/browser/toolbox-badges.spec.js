import { test, expect } from '@playwright/test';

test('Tools / Overlays toolbox triggers only show dot when a panel tool is active', async ({ page }) => {
  await page.goto('/');
  const manifest = await page.evaluate(() => fetch('/data/manifest.json').then(r => r.json()));
  if (manifest.series.length > 0) {
    await page.waitForSelector('.controls--ready', { timeout: 20_000 });
  }

  const measure = page.locator('#toolbox-measure .toolbox-trigger');
  const overlays = page.locator('#toolbox-overlays .toolbox-trigger');
  await expect(measure).not.toHaveClass(/has-active/);
  await expect(overlays).not.toHaveClass(/has-active/);

  await page.reload();
  if (manifest.series.length > 0) {
    await page.waitForSelector('.controls--ready', { timeout: 20_000 });
  }
  await expect(measure).not.toHaveClass(/has-active/);
  await expect(overlays).not.toHaveClass(/has-active/);
});
