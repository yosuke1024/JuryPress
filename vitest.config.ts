import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.{test,spec}.ts', 'tests/integration/**/*.{test,spec}.ts'],
    exclude: ['tests/e2e/**/*'],
    environment: 'node',
    // Integration tests spawn scripts/run-daily.ts as a subprocess (tsx cold start ~5s each);
    // a case that chains generate + validate runs two, which can exceed the 5s default under
    // full-suite CPU contention. Raise the ceiling so these are not flaky.
    testTimeout: 30000,
  },
});
