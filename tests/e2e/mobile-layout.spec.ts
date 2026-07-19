import { test, expect, type Page } from '@playwright/test';

/**
 * Mobile layout regression suite.
 *
 * The pre-existing mobile coverage only asserted that the hamburger is visible at 390px,
 * and the screenshot suite is skipped on CI — so nothing caught horizontal overflow, the
 * unreachable drawer, or the doubled header offset. Everything here is a DOM/geometry
 * assertion measured by the real layout engine, so it runs on CI like any other test.
 *
 * 320px is the narrowest viewport still in meaningful use (iPhone SE 1st gen / Android
 * small); 430px is the iPhone Pro Max class. Bugs cluster at the extremes, so all four
 * widths are exercised rather than the single 390px the old suite used.
 */
const VIEWPORTS = [
  { width: 320, height: 640, label: '320px (smallest supported)' },
  { width: 360, height: 740, label: '360px (common Android)' },
  { width: 390, height: 800, label: '390px (iPhone 14)' },
  { width: 430, height: 932, label: '430px (iPhone Pro Max)' }
];

const KEY_PAGES = [
  { path: '', name: 'home' },
  { path: 'reviews/', name: 'reviews index' },
  { path: 'rankings/', name: 'rankings' },
  { path: 'judges/', name: 'jury index' },
  { path: 'judges/alex/', name: 'judge detail' },
  { path: 'rankings/judges/alex/', name: 'judge rankings' },
  { path: 'methodology/', name: 'methodology' },
  { path: 'rubric/', name: 'rubric' },
  { path: 'about/', name: 'about' },
  { path: 'request-review/', name: 'request review' }
];

/** A raw GitHub URL with no break opportunity inside the path. */
const LONG_URL =
  'https://raw.githubusercontent.com/example-organization/extremely-long-repository-name-for-overflow-testing/refs/heads/main/packages/core/src/internal/configuration/DefaultConfigurationResolverFactory.generated.ts';

/** A single unbroken token — no hyphens, no slashes, nowhere legal to wrap. */
const LONG_TOKEN =
  'AbstractSingletonProxyConfigurationResolverFactoryBeanDelegateImplementationProviderRegistryToken0123456789';

const LONG_FILENAME =
  'DefaultConfigurationResolverFactoryImplementationProviderRegistry.integration.spec.snapshot.generated.ts';

const LONG_EVIDENCE_IDS =
  'EV-REPOSITORY-METADATA-0001, EV-REPOSITORY-METADATA-0002, EV-COMMUNITY-DISCUSSION-0003, EV-RUNTIME-OBSERVATION-0004';

/**
 * Reports the document's horizontal overflow, plus the elements responsible. Returning the
 * culprits makes a failure actionable instead of a bare "expected false".
 *
 * Elements inside a deliberate scroll container (the ranking / verdicts tables) are ignored:
 * their own overflow is intended and does not move the document.
 */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const overflowBy = doc.scrollWidth - doc.clientWidth;

    const isInsideScroller = (el: Element): boolean => {
      let node: Element | null = el.parentElement;
      while (node && node !== document.body) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') return true;
        node = node.parentElement;
      }
      return false;
    };

    const culprits: string[] = [];
    if (overflowBy > 0) {
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.right <= doc.clientWidth + 1) continue;
        if (isInsideScroller(el)) continue;
        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : '';
        culprits.push(
          `${el.tagName.toLowerCase()}${id}${cls} right=${Math.round(rect.right)} vw=${doc.clientWidth}`
        );
        if (culprits.length >= 6) break;
      }
    }

    return { overflowBy, culprits };
  });
}

async function expectNoHorizontalOverflow(page: Page, context: string) {
  const { overflowBy, culprits } = await horizontalOverflow(page);
  expect(
    overflowBy,
    `${context}: document overflows horizontally by ${overflowBy}px. Culprits: ${
      culprits.length ? culprits.join(' | ') : '(none isolated — check a scroll container)'
    }`
  ).toBeLessThanOrEqual(0);
}

test.describe('no horizontal overflow on key pages', () => {
  for (const viewport of VIEWPORTS) {
    for (const target of KEY_PAGES) {
      test(`${target.name} @ ${viewport.label}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(target.path);
        await page.waitForSelector('[data-global-header]');
        await expectNoHorizontalOverflow(page, `${target.name} @ ${viewport.width}px`);
      });
    }
  }
});

test.describe('no horizontal overflow on published review articles', () => {
  for (const viewport of VIEWPORTS) {
    test(`every published review @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('reviews/');

      const slugs = await page.evaluate(() =>
        Array.from(new Set(
          Array.from(document.querySelectorAll('a[href*="/reviews/"]'))
            .map(a => (a as HTMLAnchorElement).getAttribute('href') || '')
            .map(href => href.replace(/[#?].*$/, '').replace(/\/$/, '').split('/reviews/')[1])
            .filter((slug): slug is string => !!slug && !slug.includes('/'))
        ))
      );

      expect(slugs.length, 'expected at least one published review to check').toBeGreaterThan(0);

      for (const slug of slugs) {
        await page.goto(`reviews/${slug}/`);
        await page.waitForSelector('.article-hero');
        await expectNoHorizontalOverflow(page, `review ${slug} @ ${viewport.width}px`);
      }
    });
  }
});

test.describe('long URLs and unbroken tokens', () => {
  /**
   * Substitutes hostile strings into the exact containers named in the remediation —
   * article meta tags, criterion badges, evidence IDs, scorecard footer links, the
   * Recommended Next Step metadata and the selection URL — then re-measures. This drives
   * the real cascade at the real viewport, so it fails if any of those containers loses
   * its wrapping rules, regardless of what the published content happens to contain.
   */
  const INJECTIONS: Array<{ selector: string; text: string; what: string }> = [
    { selector: '.article-headline', text: LONG_TOKEN, what: 'headline / long product name' },
    { selector: '.meta-tag', text: LONG_TOKEN, what: 'article meta tag' },
    { selector: '.summary-url-link', text: LONG_URL, what: 'selection canonical URL' },
    { selector: '.criterion-pill', text: LONG_TOKEN, what: 'disagreement criterion badge' },
    { selector: '.criterion-id', text: LONG_TOKEN, what: 'criterion id' },
    { selector: '.evidence-tag', text: `Evidence: ${LONG_EVIDENCE_IDS}`, what: 'evidence ID list' },
    { selector: '.confidence-tag', text: LONG_TOKEN, what: 'confidence tag' },
    { selector: '.next-step-evidence', text: `Evidence: ${LONG_EVIDENCE_IDS}`, what: 'next step evidence' },
    { selector: '.next-step-criterion', text: `Criterion: ${LONG_TOKEN}`, what: 'next step criterion' },
    { selector: '.scorecard-footer-links a', text: `Meet ${LONG_TOKEN}`, what: 'scorecard footer link' },
    { selector: '.sources-list li', text: `${LONG_FILENAME} ${LONG_URL}`, what: 'evidence source entry' },
    { selector: '.classifications-list li', text: LONG_TOKEN, what: 'classification entry' },
    { selector: '.limitations-list li', text: LONG_FILENAME, what: 'limitations entry' },
    { selector: '.product-summary-block p', text: LONG_URL, what: 'product summary' }
  ];

  for (const viewport of VIEWPORTS) {
    test(`hostile tokens stay inside the viewport @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('reviews/fixture-product/');
      await page.waitForSelector('.article-hero');

      // Expand every <details> so the selection metadata and full scorecards are laid out.
      await page.evaluate(() => {
        document.querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
      });

      let injected = 0;
      for (const injection of INJECTIONS) {
        const applied = await page.evaluate(({ selector, text }) => {
          const nodes = Array.from(document.querySelectorAll(selector));
          nodes.forEach(node => { node.textContent = text; });
          return nodes.length;
        }, injection);

        if (applied > 0) {
          injected += 1;
          await expectNoHorizontalOverflow(
            page,
            `${injection.what} ("${injection.selector}") @ ${viewport.width}px`
          );
        }
      }

      // Guard against the selectors silently drifting away from the markup, which would
      // turn this into a test that asserts nothing.
      expect(injected, 'no injection selector matched — markup has drifted').toBeGreaterThanOrEqual(8);
    });
  }
});

test.describe('mobile drawer', () => {
  for (const viewport of VIEWPORTS) {
    test.describe(`@ ${viewport.label}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto('');
        await page.waitForSelector('[data-global-header]');
      });

      test('opens from the burger and closes from the explicit Close button', async ({ page }) => {
        const burger = page.locator('.global-header-burger');
        const drawer = page.locator('#global-header-drawer');
        const close = page.locator('#jp-drawer-close');

        await expect(burger).toBeVisible();
        await burger.click();

        await expect(drawer).toHaveClass(/open/);
        await expect(drawer).toHaveAttribute('aria-hidden', 'false');
        await expect(burger).toHaveAttribute('aria-expanded', 'true');
        await expect(close).toBeVisible();

        // Body scroll lock is engaged while the drawer is up.
        await expect(page.locator('body')).toHaveClass(/global-header-no-scroll/);

        await close.click();

        await expect(drawer).not.toHaveClass(/open/);
        await expect(drawer).toHaveAttribute('aria-hidden', 'true');
        await expect(burger).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('body')).not.toHaveClass(/global-header-no-scroll/);

        // Focus returns to the control that opened the drawer.
        await expect(burger).toBeFocused();
      });

      test('the Close button is not covered by the drawer content', async ({ page }) => {
        await page.locator('.global-header-burger').click();
        const close = page.locator('#jp-drawer-close');
        await expect(close).toBeVisible();

        // Whatever paints at the close button's centre must be the close button itself.
        // Polled because the drawer slides in over 0.3s — sampling mid-transition would
        // read a point that is still off-screen.
        await expect
          .poll(
            async () =>
              page.evaluate(() => {
                const button = document.getElementById('jp-drawer-close');
                if (!button) return 'missing';
                const rect = button.getBoundingClientRect();
                const el = document.elementFromPoint(
                  rect.x + rect.width / 2,
                  rect.y + rect.height / 2
                );
                if (!el) return 'none';
                return el.closest('#jp-drawer-close')
                  ? 'close'
                  : `${el.tagName.toLowerCase()}${el.className ? '.' + el.className : ''}`;
              }),
            { message: 'another element is painted over the drawer Close button' }
          )
          .toBe('close');
      });

      test('closes on Escape', async ({ page }) => {
        const drawer = page.locator('#global-header-drawer');
        await page.locator('.global-header-burger').click();
        await expect(drawer).toHaveClass(/open/);

        await page.keyboard.press('Escape');

        await expect(drawer).not.toHaveClass(/open/);
        await expect(page.locator('body')).not.toHaveClass(/global-header-no-scroll/);
      });

      test('closes when a menu link is selected', async ({ page }) => {
        const drawer = page.locator('#global-header-drawer');
        await page.locator('.global-header-burger').click();
        await expect(drawer).toHaveClass(/open/);

        // A JuryPress local link: same-origin navigation, drawer must not survive it.
        await drawer.locator('a[href*="/jurypress/reviews/"], a[href$="/reviews/"]').first().click();

        await expect(drawer).not.toHaveClass(/open/);
        await expect(page.locator('body')).not.toHaveClass(/global-header-no-scroll/);
      });

      test('burger and Close meet the 44x44 minimum target size', async ({ page }) => {
        const burger = page.locator('.global-header-burger');
        const burgerBox = (await burger.boundingBox())!;
        expect(burgerBox.width, 'burger width').toBeGreaterThanOrEqual(44);
        expect(burgerBox.height, 'burger height').toBeGreaterThanOrEqual(44);

        await burger.click();

        const closeBox = (await page.locator('#jp-drawer-close').boundingBox())!;
        expect(closeBox.width, 'close button width').toBeGreaterThanOrEqual(44);
        expect(closeBox.height, 'close button height').toBeGreaterThanOrEqual(44);
      });
    });
  }
});

test.describe('header offset', () => {
  for (const viewport of VIEWPORTS) {
    test(`content clears the fixed header without a doubled gap @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('');
      await page.waitForSelector('[data-global-header]');

      const { headerBottom, mainTop } = await page.evaluate(() => {
        const header = document.querySelector('[data-global-header]')!;
        const main = document.querySelector('main')!;
        return {
          headerBottom: header.getBoundingClientRect().bottom,
          mainTop: main.getBoundingClientRect().top
        };
      });

      const gap = mainTop - headerBottom;
      // Must clear the fixed header ...
      expect(gap, 'content overlaps the fixed header').toBeGreaterThan(0);
      // ... without re-reserving the header height a second time.
      expect(gap, `expected roughly 16-24px below the header, measured ${gap}px`).toBeLessThanOrEqual(32);
    });
  }
});

test.describe('ranking order is 1 → 2 → 3 on mobile', () => {
  for (const viewport of VIEWPORTS) {
    for (const target of [
      { path: 'rankings/', name: 'overall rankings' },
      { path: 'rankings/judges/alex/', name: 'judge rankings' }
    ]) {
      test(`${target.name} @ ${viewport.label}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(target.path);

        const podium = page.locator('.podium-grid');
        const hasPodium = await podium.count();

        if (hasPodium === 0) {
          // Fewer than three ranked reviews: the board renders plain ranked cards, which
          // must still count upward from #1.
          const badges = await page.locator('.card-rank-badge').allTextContents();
          expect(badges).toEqual(badges.slice().sort());
          return;
        }

        // Source order must already be rank order — no CSS reversal.
        const domRanks = await page.locator('.podium-rank').allTextContents();
        expect(domRanks.map(t => t.trim())).toEqual(['1', '2', '3']);

        // ... and the painted order must agree with it, top to bottom.
        const tops = await page.locator('.podium-col').evaluateAll(cols =>
          cols.map(col => col.getBoundingClientRect().top)
        );
        expect(tops, 'podium is not stacked 1 → 2 → 3 top to bottom').toEqual(
          tops.slice().sort((a, b) => a - b)
        );
      });
    }
  }
});
