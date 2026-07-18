import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4321/',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // PUBLIC_TURNSTILE_SITE_KEY is Cloudflare's official visible-widget testing sitekey
    // (always passes); it only enables the request-review form markup — e2e stubs the
    // Turnstile script and the API, so no real Turnstile call is ever made.
    command: 'DEPLOY_TARGET=cloudflare JURYPRESS_DATA_MODE=fixture JURYPRESS_SITE_URL=https://pixapps.ai PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA npm run build && DEPLOY_TARGET=cloudflare JURYPRESS_DATA_MODE=fixture JURYPRESS_SITE_URL=https://pixapps.ai npm run preview',
    port: 4321,
    reuseExistingServer: !process.env.CI,
  },
});
