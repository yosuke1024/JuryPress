import { test, expect, type Page } from '@playwright/test';

/**
 * JuryDiary in a real browser.
 *
 * The two properties worth measuring with a layout engine rather than a string match are the
 * ones the brief is specific about: both languages must be reachable on the page itself
 * (§18.3), and long Japanese titles must not push the page sideways on a phone — Japanese has
 * no spaces, so a long title is a single unbreakable token unless the CSS says otherwise.
 */

const VIEWPORTS = [
  { width: 320, height: 640, label: '320px' },
  { width: 390, height: 800, label: '390px' }
];

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
  });
  // One pixel of slack for sub-pixel rounding.
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe('JuryDiary', () => {
  test('navigates from the index to an entry', async ({ page }) => {
    await page.goto('diary/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Five jurors');

    await page.getByRole('link', { name: 'The Cold Joint' }).first().click();
    await expect(page).toHaveURL(/\/diary\/2026-08-02-david\/$/);
    await expect(page.getByRole('heading', { name: 'The Cold Joint', level: 1 })).toBeVisible();
  });

  test('shows both languages on the entry page, correctly tagged', async ({ page }) => {
    await page.goto('diary/2026-08-02-david/');

    const english = page.locator('#entry-en');
    const japanese = page.locator('#entry-ja');

    await expect(english).toBeVisible();
    await expect(japanese).toBeVisible();
    await expect(english).toHaveAttribute('lang', 'en');
    await expect(japanese).toHaveAttribute('lang', 'ja');

    await expect(english).toContainText('Agreement that fast usually means nobody checked');
    await expect(japanese).toContainText('あの速さの合意は');
  });

  test('keeps the entry readable with JavaScript disabled', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    await page.goto('diary/2026-08-02-david/');
    await expect(page.locator('#entry-en')).toContainText('Agreement that fast usually');
    await expect(page.locator('#entry-ja')).toContainText('あの速さの合意は');
    // The quote and permalink remain present as text, so sharing by hand still works.
    await expect(page.getByText('— David, JuryDiary').first()).toBeVisible();

    await context.close();
  });

  test('offers share controls once scripting is available', async ({ page }) => {
    await page.goto('diary/2026-08-02-david/');
    await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy quote' }).first()).toBeVisible();
  });

  test('links a work entry to the review behind it', async ({ page }) => {
    await page.goto('diary/2026-08-02-david/');
    const related = page.getByRole('link', { name: 'Fixture Product' });
    await expect(related).toBeVisible();
    await related.click();
    await expect(page).toHaveURL(/\/reviews\/fixture-product\/$/);
  });

  test('reaches a juror archive from an entry', async ({ page }) => {
    await page.goto('diary/2026-08-02-david/');
    await page.getByRole('link', { name: /All of David's entries/ }).click();
    await expect(page).toHaveURL(/\/diary\/jurors\/david\/$/);
    await expect(page.getByRole('heading', { name: 'David', level: 1 })).toBeVisible();
  });

  for (const viewport of VIEWPORTS) {
    test(`fits ${viewport.label} without horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const path of ['diary/', 'diary/2026-08-02-david/', 'diary/jurors/david/']) {
        await page.goto(path);
        await expectNoHorizontalOverflow(page);
      }
    });

    test(`wraps a long Japanese title at ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // Lisa's title is the longest Japanese heading in the fixture set.
      await page.goto('diary/2026-08-03-lisa/');
      await expect(page.locator('#entry-ja')).toContainText('また同じ角');
      await expectNoHorizontalOverflow(page);
    });
  }
});
