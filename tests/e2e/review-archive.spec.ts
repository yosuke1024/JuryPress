import { test, expect } from '@playwright/test';

test.describe('Review Archive E2E tests', () => {
  
  test('Archive list page displays correctly', async ({ page }) => {
    // Navigate to Reviews Archive
    await page.goto('reviews/');
    
    // Header check
    await expect(page.locator('h1')).toContainText('Every verdict, newest first.');
    
    // Check fixture item elements
    const item = page.locator('[data-review-item]').first();
    await expect(item).toBeVisible();
    await expect(item.locator('.product-title')).toContainText('Fixture Product');
    await expect(item.locator('.item-date')).toBeVisible();
    await expect(item.locator('.score-num')).toBeVisible();
    await expect(item.locator('.fixture-badge')).toContainText('DEMO FIXTURE');
  });

  test('Navigation links work correctly', async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.error(`[Browser Error] ${msg.text()}`);
      }
    });

    await page.goto('reviews/');

    // Global Header Brand should navigate to home page
    await page.locator('.global-header-brand').first().evaluate(el => (el as HTMLAnchorElement).click());
    await page.waitForURL('**/');
    await expect(page.locator('h1.hero-headline')).toBeVisible({ timeout: 10000 });

    // From home page, Header Reviews link should navigate back to archive
    await page.waitForTimeout(500);
    await page.locator('.site-header-context-nav a:has-text("Reviews")').first().evaluate(el => (el as HTMLAnchorElement).click());
    await expect(page).toHaveURL(/.*\/reviews\/.*/);

    // From home page, Footer Reviews link should navigate to archive
    await page.goto('');
    await page.locator('footer a:has-text("Reviews")').first().evaluate(el => (el as HTMLAnchorElement).click());
    await expect(page).toHaveURL(/.*\/reviews\/.*/);

    // From home page, 'View all reviews →' should navigate to archive
    await page.goto('');
    await page.locator('a:has-text("View all reviews")').first().evaluate(el => (el as HTMLAnchorElement).click());
    await expect(page).toHaveURL(/.*\/reviews\/.*/);

    // From archive, clicking fixture product should open detail page
    await page.goto('reviews/');
    await page.locator('.product-title a').first().evaluate(el => (el as HTMLAnchorElement).click());
    await expect(page).toHaveURL(/.*\/reviews\/fixture-product\/.*/);
  });

  test('Search functionality works correctly', async ({ page }) => {
    await page.goto('reviews/');

    // Perform search with lowercase
    const searchInput = page.locator('#review-search');
    await searchInput.fill('fixture');
    
    // Result count should update
    const resultCount = page.locator('#result-count');
    await expect(resultCount).toContainText('1 verdict found');

    // Perform search with uppercase
    await searchInput.fill('FIXTURE');
    await expect(resultCount).toContainText('1 verdict found');

    // Search for non-existent product
    await searchInput.fill('non-existent-product-name');
    await expect(resultCount).toContainText('0 verdicts found');

    // No results card should be shown
    const noResults = page.locator('#no-results');
    await expect(noResults).toBeVisible();
    await expect(noResults.locator('.query-term')).toContainText('non-existent-product-name');

    // Click "Clear search" on No Results card
    await page.locator('#no-results-clear-btn').click();
    await expect(searchInput).toHaveValue('');
    await expect(resultCount).toContainText('published'); // restored

    // Verify ?q= synchronization
    await searchInput.fill('fixture');
    await expect(page).toHaveURL(/.*q=fixture.*/);

    // Verify search state restoration from URL
    await page.goto('reviews/?q=fixture');
    await expect(searchInput).toHaveValue('fixture');
    await expect(resultCount).toContainText('1 verdict found');

    // Clear search using input clear button
    await page.locator('#search-clear').click();
    await expect(searchInput).toHaveValue('');
    await expect(page).not.toHaveURL(/\?q=/);
  });

  test('Accessibility and Keyboard Navigation', async ({ page }) => {
    await page.goto('reviews/');

    // Check search label associated with input
    const inputId = await page.locator('#review-search').getAttribute('id');
    const labelFor = await page.locator('label').getAttribute('for');
    expect(inputId).toBe(labelFor);

    // Focus and type using keyboard
    await page.focus('#review-search');
    await page.keyboard.type('fixture');
    await expect(page.locator('#result-count')).toContainText('1 verdict found');

    // Use Tab to focus clear button and trigger it
    await page.keyboard.press('Tab');
    const focusedElementId = await page.evaluate(() => document.activeElement?.id);
    // clear button has id 'search-clear'
    expect(focusedElementId).toBe('search-clear');
    await page.keyboard.press('Enter');
    await expect(page.locator('#review-search')).toHaveValue('');
  });

  test('Mobile viewport layout verification', async ({ page }) => {
    // Set mobile viewport (iPhone 11 style)
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('reviews/');

    // Verify elements are visible and search input is not cut off
    const searchInput = page.locator('#review-search');
    await expect(searchInput).toBeVisible();
    
    // Check width of input (should not exceed viewport)
    const inputWidth = await searchInput.evaluate((el) => el.getBoundingClientRect().width);
    expect(inputWidth).toBeLessThan(375);

    // Ensure no horizontal scroll is present on the page
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScroll).toBe(false);

    // Archive list item should show score correctly on mobile
    const scoreBox = page.locator('.score-box').first();
    await expect(scoreBox).toBeVisible();
  });
});
