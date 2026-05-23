/**
 * E2E smoke — submit a public anonymous form end-to-end.
 *
 * Flow:
 *   1. Confirm the seeded form is reachable at /f/e2e-smoke-form.
 *   2. Fill the required "Your name" text field.
 *   3. Submit and assert the thank-you page renders.
 *
 * The form is seeded by test/e2e/setup/seed-form.ts before this suite runs.
 * No OIDC session is needed — the form uses public_anonymous access.
 *
 * Skips automatically when DATABASE_URL is not set (local dev without a DB).
 */

import { test, expect } from '@playwright/test';

const SLUG = 'e2e-smoke-form';

test.describe('Public form submission smoke', () => {
  test.skip(
    !process.env.DATABASE_URL,
    'Skipping e2e smoke: DATABASE_URL not set',
  );

  test('navigate → fill → submit → thank-you renders', async ({ page }) => {
    // ── 1. Navigate to the public form URL ──────────────────────────────────
    await page.goto(`/f/${SLUG}`);

    // The renderer should show the first page title.
    await expect(page.getByText('Smoke test')).toBeVisible({ timeout: 15_000 });

    // ── 2. Fill the required text field ─────────────────────────────────────
    const nameField = page.getByLabel('Your name');
    await expect(nameField).toBeVisible({ timeout: 5_000 });
    await nameField.fill('CI Smoke Tester');

    // ── 3. Submit the form ───────────────────────────────────────────────────
    await page.getByRole('button', { name: /submit/i }).click();

    // ── 4. Assert thank-you page ─────────────────────────────────────────────
    await expect(page.getByText(/thank you/i)).toBeVisible({ timeout: 15_000 });
  });
});
