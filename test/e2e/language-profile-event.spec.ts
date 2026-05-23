/**
 * E2E — Language Profile event flow (§8 verification recipe steps 6–11)
 *
 * Auth is stubbed: instead of a real OIDC redirect we set a session cookie
 * directly using a JWT issued by `scripts/issue-test-session.ts`.
 *
 * Prerequisites (via global-setup + seed-e2e.ts):
 *   - form-api running on :4200
 *   - form-web running on :4202
 *   - Postgres seeded with admin account + e2e test-user account
 */

import { test, expect } from '@playwright/test';

const FORM_API = 'http://localhost:4200';
const E2E_ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? '';
const E2E_USER_SESSION = process.env.E2E_USER_SESSION ?? '';

// Helper: call form-api admin endpoints
async function apiPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${FORM_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Token': E2E_ADMIN_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

async function apiGet(path: string, sessionCookie?: string): Promise<Response> {
  return fetch(`${FORM_API}${path}`, {
    headers: {
      ...(sessionCookie ? { Cookie: `form_session=${sessionCookie}` } : {}),
    },
  });
}

test('language.profile.v1 — full redirect flow, fill, submit, status check', async ({ page }) => {
  // ── 1. Bootstrap: create "Language Profile" form via admin API ──────────────
  const createFormRes = await apiPost('/v1/admin/forms', {
    title: 'Language Profile',
    type: 'dynamic',
    access: { mode: 'private_oidc', require_account: true, anonymous_allowed: false },
    spec: {
      pages: [
        {
          id: 'pg_1',
          title: 'About you',
          show_if: null,
          fields: [
            {
              id: 'fld_languages',
              type: 'multiselect',
              label: 'Languages you speak',
              required: true,
              options: [
                { value: 'en', label: 'English' },
                { value: 'th', label: 'Thai' },
                { value: 'ja', label: 'Japanese' },
              ],
            },
          ],
        },
        {
          id: 'pg_2',
          title: 'Primary language',
          show_if: { '!!': [{ var: 'fld_languages' }] },
          fields: [
            {
              id: 'fld_primary_language',
              type: 'select',
              label: 'Primary language',
              required: true,
              options: [
                { value: 'en', label: 'English' },
                { value: 'th', label: 'Thai' },
                { value: 'ja', label: 'Japanese' },
              ],
            },
          ],
        },
      ],
      thank_you: {
        title: 'Thanks!',
        body_md: 'Your language profile is saved.',
        redirect_url_template: '{return_url}?event={event_key}&submission_id={submission_id}',
      },
      submit: { post_actions: ['mark_event_filled'] },
    },
  });

  expect(createFormRes.status, 'create form should succeed').toBe(201);
  const form = (await createFormRes.json()) as { id: string; slug: string };

  // ── 2. Create event bound to the form ──────────────────────────────────────
  const createEventRes = await apiPost('/v1/admin/events', {
    event_key: `language.profile.v1.e2e.${Date.now()}`,
    form_id: form.id,
    optional: false,
    description: 'E2E test event',
  });

  expect(createEventRes.status, 'create event should succeed').toBe(201);
  const event = (await createEventRes.json()) as { event_key: string };

  // ── 3. Visit /e/<event_key>?return_url=… as the test user ─────────────────
  // Inject the user session cookie before navigating so form-web treats the
  // user as authenticated (bypassing real OIDC).
  await page.context().addCookies([
    {
      name: 'form_session',
      value: E2E_USER_SESSION,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);

  const returnUrl = encodeURIComponent('http://localhost:3001/lesson');
  await page.goto(`/e/${event.event_key}?return_url=${returnUrl}`);

  // ── 4. Assert redirect to /f/<slug> ────────────────────────────────────────
  await expect(page).toHaveURL(new RegExp(`/f/${form.slug}`), { timeout: 10_000 });

  // ── 5. Fill page 1 ─────────────────────────────────────────────────────────
  // Multiselect for languages — implementation-agnostic: look for the field
  // by its label and interact with the options.
  await expect(page.getByText('Languages you speak')).toBeVisible();

  // Click each option in the multiselect (rendered as checkboxes or a Mantine
  // MultiSelect component — locate by accessible role).
  await page.getByLabel('English').check();
  await page.getByLabel('Thai').check();

  await page.getByRole('button', { name: /next/i }).click();

  // ── 6. Fill page 2 ─────────────────────────────────────────────────────────
  await expect(page.getByText('Primary language')).toBeVisible();
  await page.getByLabel('Primary language').selectOption('en');

  // ── 7. Submit ──────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /submit/i }).click();

  // ── 8. Thank-you page + redirect meta ─────────────────────────────────────
  await expect(page.getByText(/thanks/i)).toBeVisible({ timeout: 10_000 });

  // The redirect_url_template renders a <meta http-equiv="refresh"> or a
  // data attribute on the thank-you page — check for the return_url presence.
  const returnMeta = page.locator('[data-return-url]');
  await expect(returnMeta).toBeVisible();
  const returnUrlAttr = await returnMeta.getAttribute('data-return-url');
  expect(returnUrlAttr).toContain('event=');
  expect(returnUrlAttr).toContain(event.event_key);

  // ── 9. Status API confirms filled: true ───────────────────────────────────
  const statusRes = await apiGet(
    `/v1/public/events/${event.event_key}/status`,
    E2E_USER_SESSION,
  );
  expect(statusRes.status).toBe(200);
  const status = (await statusRes.json()) as { filled: boolean };
  expect(status.filled).toBe(true);
});
