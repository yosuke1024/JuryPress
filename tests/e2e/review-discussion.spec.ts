import { test, expect } from '@playwright/test';

test.describe('Review Discussion (giscus) E2E tests', () => {
  test('Discussion section is visible on desktop with fallback link and no automatic comment posting', async ({ page }) => {
    // Block all outbound giscus network calls — this test never posts a real comment
    // and must not depend on GitHub/giscus availability.
    await page.route('**://giscus.app/**', route => route.abort());

    await page.goto('reviews/fixture-product/');

    const section = page.locator('[data-testid="review-discussion"]');
    await expect(section).toBeVisible();
    await expect(section.locator('.discussion-title')).toContainText('Discuss this review');
    await expect(section.locator('.discussion-note')).toContainText('do not automatically change the jury score');

    const fallbackLink = section.locator('.discussion-fallback-link');
    await expect(fallbackLink).toBeVisible();
    await expect(fallbackLink).toContainText('Open GitHub Discussions');
    await expect(fallbackLink).toHaveAttribute(
      'href',
      'https://github.com/yosuke1024/JuryPress/discussions/categories/review-comments'
    );
    await expect(fallbackLink).toHaveAttribute('target', '_blank');
  });

  test('Article body renders fully even when giscus fails to load', async ({ page }) => {
    await page.route('**://giscus.app/**', route => route.abort());

    await page.goto('reviews/fixture-product/');

    // Core article content is present regardless of the blocked embed.
    await expect(page.locator('h1.article-headline')).toBeVisible();
    await expect(page.locator('.evidence-section')).toBeVisible();
    await expect(page.locator('[data-testid="review-discussion"]')).toBeVisible();
  });

  test('Mobile viewport shows the discussion section without horizontal scroll', async ({ page }) => {
    await page.route('**://giscus.app/**', route => route.abort());
    await page.setViewportSize({ width: 375, height: 812 });

    await page.goto('reviews/fixture-product/');

    const section = page.locator('[data-testid="review-discussion"]');
    await expect(section).toBeVisible();

    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScroll).toBe(false);

    const sectionWidth = await section.evaluate(el => el.getBoundingClientRect().width);
    expect(sectionWidth).toBeLessThanOrEqual(375);
  });

  test('Fallback GitHub Discussions link is operable', async ({ page, context }) => {
    // Never depend on real GitHub/giscus availability: abort both, and only assert
    // the browser was told to navigate to the right URL — not that it loaded.
    await page.route('**://giscus.app/**', route => route.abort());
    await page.route('**://github.com/**', route => route.abort());
    await page.goto('reviews/fixture-product/');

    const fallbackLink = page.locator('.discussion-fallback-link');
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      fallbackLink.click(),
    ]);
    expect(popup.url()).toContain('github.com/yosuke1024/JuryPress/discussions/categories/review-comments');
    await popup.close();
  });
});
