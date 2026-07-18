import { test, expect } from '@playwright/test';

/**
 * Request a Review page: an explainer that sends readers to the GitHub issue form.
 * No API and no Turnstile exist on this path — submission happens on GitHub with the
 * reader's own account.
 */

const NEW_ISSUE_URL = 'https://github.com/yosuke1024/JuryPress/issues/new?template=review-request.yml';

test.describe('Request a Review page', () => {
  test('explains the flow and links to the GitHub issue form', async ({ page }) => {
    await page.goto('/request-review/');

    await expect(page.locator('h1')).toContainText('review');
    const cta = page.locator('.request-cta-button');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', NEW_ISSUE_URL);
    await expect(page.locator('.request-cta-note')).toContainText('GitHub account');

    // The page states the guarantees that matter: public issue, same gate, no score
    // influence, no publication guarantee.
    const content = page.locator('.request-page');
    await expect(content).toContainText('public GitHub Issue');
    await expect(content).toContainText('same Eligibility Gate');
    await expect(content).toContainText('no effect on the Jury Score');
    await expect(content).toContainText('guarantees neither publication nor a favorable score');
  });

  test('lists the required request fields', async ({ page }) => {
    await page.goto('/request-review/');
    const list = page.locator('.request-section').first();
    await expect(list).toContainText('Product name');
    await expect(list).toContainText('Canonical public repository URL');
    await expect(list).toContainText('One-sentence purpose');
    await expect(list).toContainText('relationship');
  });

  test('has no horizontal overflow at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/request-review/');
    await expect(page.locator('.request-cta-button')).toBeVisible();

    const hasOverflow = await page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth > el.clientWidth;
    });
    expect(hasOverflow).toBe(false);
  });

  test('the reviews archive links to the request page', async ({ page }) => {
    await page.goto('/reviews/');
    const cta = page.locator('.header-request-cta a');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', '/request-review/');
  });
});
