import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e config for the form service.
 *
 * There is NO webServer block here — services must already be running before
 * this suite executes. Use global-setup.ts to wait for them to be ready.
 *
 * Local dev:
 *   docker compose up form-postgres form-minio redis
 *   pnpm -F form-api db:migrate
 *   pnpm -F form-api dev          # port 4200
 *   pnpm -F form-admin dev        # port 4201
 *   pnpm -F form-web dev          # port 4202
 *   pnpm tsx form-api/scripts/seed-e2e.ts
 *   pnpm -F form-api e2e
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['html'], ['list']],
  use: {
    baseURL: 'http://localhost:4202',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  outputDir: './playwright-results',
});
