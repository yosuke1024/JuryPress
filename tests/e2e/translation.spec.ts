import { test, expect } from '@playwright/test';

test('Homepage is structured for translation', async ({ page }) => {
  await page.goto('/JuryPress/');

  // Ensure html lang is set to en
  const htmlLang = await page.getAttribute('html', 'lang');
  expect(htmlLang).toBe('en');

  // Check that the main content is readable text, not canvas or shadow DOM
  const text = await page.textContent('main');
  expect(text).toContain('JuryPress');
  expect(text).toContain('Meet the Jury');

  // Verify no meta tags explicitly blocking translation
  const noTranslateMeta = await page.$('meta[name="google"][content="notranslate"]');
  expect(noTranslateMeta).toBeNull();
});

test('Methodology page exists and is translatable', async ({ page }) => {
  await page.goto('/JuryPress/methodology');
  const text = await page.textContent('main');
  expect(text).toContain('Methodology');
  expect(text).toContain('Hacker News Top');
});
