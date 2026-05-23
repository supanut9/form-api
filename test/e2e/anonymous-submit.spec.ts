/**
 * E2E — Anonymous form submission
 *
 * Creates a public_anonymous form, submits it without any session cookie,
 * and asserts:
 *   - The submission was accepted (201).
 *   - accountId is null on the submission record.
 *   - The `anonymous_token` cookie is set in the browser after submit.
 *
 * Prerequisites: form-api on :4200, form-web on :4202, E2E_ADMIN_TOKEN set.
 */

import { test, expect } from '@playwright/test';

const FORM_API = 'http://localhost:4200';
const E2E_ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? '';

async function apiPost(path: string, body: unknown, adminToken = E2E_ADMIN_TOKEN): Promise<Response> {
  return fetch(`${FORM_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Token': adminToken,
    },
    body: JSON.stringify(body),
  });
}

async function apiGet(path: string): Promise<Response> {
  return fetch(`${FORM_API}${path}`, {
    headers: { 'X-Api-Token': E2E_ADMIN_TOKEN },
  });
}

test('anonymous submit — accountId is null, anonymous_token cookie set', async ({
  page,
  context,
}) => {
  // ── 1. Create a public_anonymous form ───────────────────────────────────
  const createFormRes = await apiPost('/v1/admin/forms', {
    title: `Anon Submit E2E ${Date.now()}`,
    type: 'dynamic',
    access: { mode: 'public_anonymous', require_account: false, anonymous_allowed: true },
    spec: {
      pages: [
        {
          id: 'pg_1',
          title: 'Quick poll',
          show_if: null,
          fields: [
            {
              id: 'fld_rating',
              type: 'select',
              label: 'Rating',
              required: true,
              options: [
                { value: '1', label: '1 — Poor' },
                { value: '5', label: '5 — Excellent' },
              ],
            },
          ],
        },
      ],
      thank_you: { title: 'Thanks for rating!', body_md: '', redirect_url_template: '' },
      submit: { post_actions: [] },
    },
  });
  expect(createFormRes.status).toBe(201);
  const form = (await createFormRes.json()) as { id: string; slug: string };

  // ── 2. Clear all cookies to ensure no session is present ────────────────
  await context.clearCookies();

  // ── 3. Navigate to the form as an unauthenticated user ───────────────────
  await page.goto(`/f/${form.slug}`);
  await expect(page.getByText('Quick poll')).toBeVisible({ timeout: 10_000 });

  // ── 4. Fill and submit ───────────────────────────────────────────────────
  await page.getByLabel('Rating').selectOption('5');
  await page.getByRole('button', { name: /submit/i }).click();

  // ── 5. Thank-you page renders ────────────────────────────────────────────
  await expect(page.getByText(/thanks for rating/i)).toBeVisible({ timeout: 10_000 });

  // ── 6. anonymous_token cookie is set ─────────────────────────────────────
  const cookies = await context.cookies('http://localhost:4202');
  const anonCookie = cookies.find((c) => c.name === 'anonymous_token');
  expect(anonCookie, 'anonymous_token cookie should be set after submit').toBeDefined();
  expect(anonCookie?.value).toBeTruthy();

  // ── 7. Verify accountId is null on the submission via admin API ──────────
  const submissionsRes = await apiGet(`/v1/admin/forms/${form.id}/submissions?limit=1`);
  expect(submissionsRes.status).toBe(200);
  const body = (await submissionsRes.json()) as {
    items: Array<{ account_id: string | null; anonymous_token: string | null }>;
  };

  expect(body.items.length).toBeGreaterThanOrEqual(1);
  const submission = body.items[0];
  expect(submission.account_id).toBeNull();
  expect(submission.anonymous_token).toBeTruthy();
});
