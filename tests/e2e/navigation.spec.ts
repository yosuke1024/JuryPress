import { test, expect } from '@playwright/test';

test('Comprehensive navigation and metadata check', async ({ page }) => {
  // 1. Top Page
  await page.goto('');
  expect(await page.title()).toContain('JuryPress');
  
  // Header exists
  const header = page.locator('.site-header-context-nav');
  await expect(header).toBeVisible();

  // CSS loaded check (check background color or simple computed style)
  const bodyBg = await page.evaluate(() => {
    return window.getComputedStyle(document.body).backgroundColor;
  });
  expect(bodyBg).toBeDefined();

  // Mobile Menu check (if present, verify it can toggle)
  const menuButton = page.locator('.mobile-menu-toggle, .menu-toggle').first();
  if (await menuButton.isVisible()) {
    await menuButton.click();
    // Assuming clicking menu toggle reveals some link
    const navLink = page.locator('nav a').first();
    await expect(navLink).toBeVisible();
  }

  // 2. Rankings Page
  await page.goto('rankings/');
  await expect(page.locator('h1')).toContainText('Rankings');

  // Period switcher: All-time is the current scope, the period scopes are offered.
  const periodNav = page.locator('.ranking-period-nav');
  await expect(periodNav).toBeVisible();
  await expect(periodNav.locator('.scope-tab.is-active')).toHaveText('All-time');
  for (const scope of ['Annual', 'Monthly', 'Weekly']) {
    await expect(periodNav.getByText(scope, { exact: true })).toBeVisible();
  }

  // 3. The Jury (Judges list)
  await page.goto('judges/');
  await expect(page.locator('h1')).toContainText('Meet the Jury');

  // Meet the Jury Avatar check
  const avatar = page.locator('img, svg').first();
  await expect(avatar).toBeVisible();

  // 4. Alex Profile
  await page.goto('judges/alex/');
  await expect(page.locator('h1')).toContainText('Alex');

  // Judge Details check
  const details = page.locator('.judge-profile, .judge-details, main');
  await expect(details).toBeVisible();
  const detailsText = await details.textContent();
  expect(detailsText).toContain('Alex');

  // 5. Rubric
  await page.goto('rubric/');
  await expect(page.locator('h1')).toContainText('Rubric');

  // 6. Methodology
  await page.goto('methodology/');
  await expect(page.locator('h1')).toContainText('Methodology');

  // 7. About
  await page.goto('about/');
  await expect(page.locator('h1')).toContainText('About JuryPress');

  // PixApps Link / Judgie-AI Link validation
  const pixappsLink = page.locator('a[href*="pixapps.ai"]');
  const judgieLink = page.locator('a[href*="judgie"]');
  // At least one should be present on About page
  expect(await pixappsLink.count() + await judgieLink.count()).toBeGreaterThan(0);

  // 8. Privacy
  await page.goto('privacy/');
  await expect(page.locator('h1')).toContainText('Privacy');

  // 9. Fixture Review page
  await page.goto('reviews/fixture-product/');
  const reviewTitle = page.locator('h1');
  await expect(reviewTitle).toBeVisible();

  // Canonical check on Fixture page (Production URL)
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(canonical).toBe('https://pixapps.ai/reviews/fixture-product/');

  // OGP URL check
  const ogUrl = await page.locator('meta[property="og:url"]').getAttribute('content');
  expect(ogUrl).toBe('https://pixapps.ai/reviews/fixture-product/');

  // 10. RSS XML existence check
  const rssResponse = await page.goto('rss.xml');
  expect(rssResponse?.status()).toBe(200);
  const rssContentType = rssResponse?.headers()['content-type'];
  expect(rssContentType).toContain('xml');

  // 11. 404 page
  await page.goto('does-not-exist-page/');
  await expect(page.locator('h1')).toContainText('Verdict not found');
});
