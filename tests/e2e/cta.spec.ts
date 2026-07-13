import { test, expect } from '@playwright/test';

test('CTA URLs do not leak placeholder values', async ({ page }) => {
  // We navigate to the fixture review which has the CTA blocks in the layout and article
  await page.goto('/JuryPress/reviews/fixture-product');

  // If CTA links are rendered, they must not contain 'example.com' or 'undefined'
  const html = await page.content();
  
  // We check the raw HTML content because the CTA blocks might be fully suppressed (which is valid),
  // but if they are present, they should not be broken.
  expect(html).not.toContain('example.com');
  expect(html).not.toContain('undefined');
  expect(html).not.toContain('null?utm_');
});
