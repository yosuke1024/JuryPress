import { test, expect, type Page } from '@playwright/test';

/**
 * Request a Review page. The Turnstile script and the Worker API are both stubbed —
 * no real Turnstile, GitHub, or Cloudflare call is ever made.
 */

const TURNSTILE_STUB = `
  (function () {
    var token = 'XXXX.DUMMY.TOKEN.XXXX';
    function inject() {
      var widgets = document.querySelectorAll('.cf-turnstile');
      for (var i = 0; i < widgets.length; i++) {
        var widget = widgets[i];
        if (widget.querySelector('[name="cf-turnstile-response"]')) continue;
        var input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'cf-turnstile-response';
        input.value = token;
        widget.appendChild(input);
        widget.setAttribute('data-rendered', 'true');
      }
    }
    window.turnstile = {
      render: inject,
      reset: function () {},
      getResponse: function () { return token; }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', inject);
    } else {
      inject();
    }
  })();
`;

async function stubTurnstile(page: Page): Promise<void> {
  await page.route('**/turnstile/v0/api.js*', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: TURNSTILE_STUB
  }));
}

async function fillValidForm(page: Page): Promise<void> {
  await page.fill('#product_name', 'Great Tool');
  await page.fill('#canonical_repository_url', 'https://github.com/owner/great-tool');
  await page.fill('#purpose', 'A command-line tool that automates dependency updates safely.');
  await page.selectOption('#requester_relationship', 'user');
  await page.check('#consent_public_issue');
  await page.check('#consent_no_guarantee');
}

test.describe('Request a Review page', () => {
  test.beforeEach(async ({ page }) => {
    await stubTurnstile(page);
  });

  test('renders all required fields, consents, and the notice about public issues', async ({ page }) => {
    await page.goto('/request-review/');

    await expect(page.locator('h1')).toContainText('review');
    await expect(page.locator('#product_name')).toBeVisible();
    await expect(page.locator('#canonical_repository_url')).toBeVisible();
    await expect(page.locator('#purpose')).toBeVisible();
    await expect(page.locator('#requester_relationship')).toBeVisible();
    await expect(page.locator('#official_url')).toBeVisible();
    await expect(page.locator('#additional_official_urls')).toBeVisible();
    await expect(page.locator('#consent_public_issue')).toBeVisible();
    await expect(page.locator('#consent_no_guarantee')).toBeVisible();
    await expect(page.locator('#submit-button')).toBeEnabled();

    // The relationship options match the spec.
    const options = page.locator('#requester_relationship option');
    await expect(options).toHaveText(['Select…', 'Creator / Maintainer', 'Contributor', 'User', 'Other']);

    // The honeypot is not visible to a real user.
    await expect(page.locator('#website')).not.toBeInViewport();
  });

  test('client-side validation blocks bad input without calling the API', async ({ page }) => {
    let apiCalled = false;
    await page.route('**/api/review-requests', route => {
      apiCalled = true;
      return route.fulfill({ status: 500, body: '{}' });
    });

    await page.goto('/request-review/');
    await page.fill('#product_name', 'Great Tool');
    await page.fill('#canonical_repository_url', 'https://gitlab.com/owner/repo');
    await page.fill('#purpose', 'too short');
    await page.selectOption('#requester_relationship', 'user');
    await page.check('#consent_public_issue');
    await page.check('#consent_no_guarantee');
    await page.click('#submit-button');

    await expect(page.locator('[data-error-for="canonical_repository_url"]')).toBeVisible();
    await expect(page.locator('[data-error-for="purpose"]')).toBeVisible();
    expect(apiCalled).toBe(false);
  });

  test('a successful submission shows the issue number and link without redirecting', async ({ page }) => {
    await page.route('**/api/review-requests', async route => {
      const payload = route.request().postDataJSON();
      expect(payload.product_name).toBe('Great Tool');
      expect(payload.turnstile_token).toBe('XXXX.DUMMY.TOKEN.XXXX');
      expect(payload.website).toBe('');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          issueNumber: 123,
          issueUrl: 'https://github.com/yosuke1024/JuryPress/issues/123'
        })
      });
    });

    await page.goto('/request-review/');
    await fillValidForm(page);
    await page.click('#submit-button');

    await expect(page.locator('#success-heading')).toHaveText('Review request #123 has been created.');
    await expect(page.locator('#success-issue-link')).toHaveAttribute('href', 'https://github.com/yosuke1024/JuryPress/issues/123');
    await expect(page.locator('.success-note')).toContainText('source of truth');
    await expect(page.locator('#request-form')).toBeHidden();
    // No redirect: the reader opens the issue link themselves.
    expect(new URL(page.url()).pathname).toBe('/request-review/');
  });

  test('an API failure shows an error and keeps the form usable', async ({ page }) => {
    await page.route('**/api/review-requests', route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'service_unavailable', message: 'Review requests are temporarily unavailable.' })
    }));

    await page.goto('/request-review/');
    await fillValidForm(page);
    await page.click('#submit-button');

    await expect(page.locator('#form-error')).toBeVisible();
    await expect(page.locator('#request-form')).toBeVisible();
    await expect(page.locator('#submit-button')).toBeEnabled();
  });

  test('has no horizontal overflow at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/request-review/');
    await expect(page.locator('#request-form')).toBeVisible();

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
