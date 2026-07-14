import { test, expect } from '@playwright/test';

test('CTA URLs do not leak placeholder values', async ({ page }) => {
  // We navigate to the fixture review which has the CTA blocks in the layout and article
  await page.goto('reviews/fixture-product/');

  // We check that actual anchor tags do not have broken URLs leaking placeholders
  const anchors = await page.locator('a').all();
  for (const anchor of anchors) {
    const href = await anchor.getAttribute('href');
    if (href) {
      // Skip mock evidence URLs in the fixture data
      if (href.includes('github.com/yosuke1024')) {
        continue;
      }
      expect(href).not.toContain('example.com');
      expect(href).not.toContain('undefined');
      expect(href).not.toContain('null?utm_');
    }
  }
});
