import { test, expect } from '@playwright/test';

test.describe('JuryPress Global Header & ContextNavigation Validation', () => {
  test('DOM & E2E Validation', async ({ page }) => {
    await page.goto('');
    await page.waitForSelector('[data-global-header]');

    // [data-global-header] exists exactly once
    const header = page.locator('[data-global-header]');
    await expect(header).toHaveCount(1);

    // Locale switcher exists and is English only
    const langBtn = page.locator('.global-header-lang-btn, #globalLangToggle');
    await expect(langBtn).toHaveCount(1);
    await expect(langBtn).toContainText('English only');
    await expect(langBtn).toBeDisabled();

    // PixApps logo links to home page
    const logoLink = page.locator('header .global-header-brand').first();
    await expect(logoLink).toHaveAttribute('href', '/');

    // Logo image source is exactly /logo.png
    const logoImg = page.locator('header .global-header-logo-img').first();
    await expect(logoImg).toHaveAttribute('src', '/logo.png');

    // Global navigation is visible on desktop
    const desktopLinks = page.locator('.global-header-links');
    await expect(desktopLinks).toBeVisible();

    // JuryPress ContextNavigation is visible
    const contextNav = page.locator('.site-header');
    await expect(contextNav).toBeVisible();

    // PixApps brand link / divider / mobile menu are hidden in local nav
    const localBrandPrefix = contextNav.locator('.pixapps-link');
    await expect(localBrandPrefix).toBeHidden();
    const localDivider = contextNav.locator('.divider');
    await expect(localDivider).toBeHidden();
    const localBurger = contextNav.locator('.mobile-menu-container, .menu-trigger');
    await expect(localBurger).toBeHidden();

    // No horizontal scroll overflow
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(overflow).toBe(false);
  });

  test('Mobile Hamburger Menu validation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('');
    await page.waitForSelector('[data-global-header]');

    // Burger button is visible and unique
    const burger = page.locator('.global-header-burger');
    await expect(burger).toHaveCount(1);
    await expect(burger).toBeVisible();
  });
});

test.describe('JuryPress Visual Regression Validation', () => {
  const visualRoutes = [
    { path: '', name: 'jurypress_top' },
    { path: 'reviews/fixture-product/', name: 'jurypress_review_fixture' }
  ];

  const viewports = [
    { width: 1440, height: 900, name: 'desktop' },
    { width: 390, height: 800, name: 'mobile' }
  ];

  for (const route of visualRoutes) {
    for (const vp of viewports) {
      test(`Screenshot for ${route.path} (${vp.name})`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(route.path);
        await page.waitForTimeout(500); // Wait for layout to settle
        await expect(page).toHaveScreenshot(`${route.name}-${vp.name}.png`);
      });
    }
  }
});
