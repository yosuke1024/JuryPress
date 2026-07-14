import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4321/JuryPress/',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'JURYPRESS_DATA_MODE=fixture npm run build && npm run preview',
    port: 4321,
    reuseExistingServer: !process.env.CI,
  },
});
