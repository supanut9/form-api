/**
 * Playwright global setup — waits for all three services to be reachable
 * before the test suite starts.
 *
 * The test runner DOES NOT start these services. They must already be running:
 *   - form-api   → http://localhost:4200  (healthz endpoint)
 *   - form-admin → http://localhost:4201  (Next.js dev / built)
 *   - form-web   → http://localhost:4202  (Next.js dev / built)
 *
 * In CI these are started by the `e2e` workflow job before this step runs.
 * Locally, start them manually (see playwright.config.ts header).
 */

import { chromium } from '@playwright/test';

const SERVICES: Array<{ name: string; url: string }> = [
  { name: 'form-api', url: 'http://localhost:4200/healthz' },
  { name: 'form-admin', url: 'http://localhost:4201' },
  { name: 'form-web', url: 'http://localhost:4202' },
];

const TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

async function waitForService(name: string, url: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (res.status < 500) {
        console.log(`[global-setup] ${name} ready (${res.status})`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `[global-setup] ${name} at ${url} did not become ready within ${TIMEOUT_MS}ms`,
  );
}

export default async function globalSetup(): Promise<void> {
  console.log('[global-setup] waiting for services…');
  await Promise.all(SERVICES.map(({ name, url }) => waitForService(name, url)));
  console.log('[global-setup] all services ready');

  // Launch a throwaway browser just to confirm Playwright+Chromium is usable
  const browser = await chromium.launch();
  await browser.close();
}
