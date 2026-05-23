/**
 * E2E — Embedded SDK iframe flow
 *
 * Loads fixtures/embed-host.html (a static host page that creates an iframe
 * pointing at form-web /embed/<formId>), then verifies:
 *   1. The iframe loads the form renderer.
 *   2. The parent receives a `form-resize` postMessage from the child.
 *   3. After submitting, the parent receives a `form-submit` postMessage.
 *
 * The embed-host.html file stores all received postMessages in
 * `window.__postMessages` so Playwright can poll it via page.evaluate().
 *
 * Prerequisites:
 *   - form-web running on :4202 with /embed/:formId route implemented
 *   - form-api running on :4200
 *   - E2E_ADMIN_TOKEN set
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const FORM_API = 'http://localhost:4200';
const E2E_ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? '';

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

test('embed SDK — iframe loads, receives form-resize postMessage, then form-submit after submit', async ({
  page,
}) => {
  // ── 1. Create a simple public anonymous form ─────────────────────────────
  const createFormRes = await apiPost('/v1/admin/forms', {
    title: `Embed SDK E2E ${Date.now()}`,
    type: 'dynamic',
    access: { mode: 'public_anonymous', require_account: false, anonymous_allowed: true },
    spec: {
      pages: [
        {
          id: 'pg_1',
          title: 'Feedback',
          show_if: null,
          fields: [
            {
              id: 'fld_feedback',
              type: 'textarea',
              label: 'Your feedback',
              required: true,
            },
          ],
        },
      ],
      thank_you: { title: 'Thank you!', body_md: '', redirect_url_template: '' },
      submit: { post_actions: [] },
    },
  });
  expect(createFormRes.status).toBe(201);
  const form = (await createFormRes.json()) as { id: string };

  // ── 2. Load the embed host page with the form_id param ───────────────────
  const fixtureFile = path.resolve(__dirname, 'fixtures', 'embed-host.html');
  const fixtureUrl = `file://${fixtureFile}?form_id=${form.id}&form_web_base=http://localhost:4202`;

  await page.goto(fixtureUrl);

  // ── 3. Wait for the iframe to appear ────────────────────────────────────
  const iframe = page.locator('#form-iframe');
  await expect(iframe).toBeVisible({ timeout: 10_000 });

  // ── 4. Wait for form-resize postMessage ─────────────────────────────────
  // Poll window.__postMessages until a form-resize entry appears.
  await expect
    .poll(
      async () => {
        const messages = await page.evaluate(() => {
          return (window as unknown as { __postMessages: Array<{ type: string }> }).__postMessages ?? [];
        });
        return messages.some((m) => m.type === 'form-resize');
      },
      { timeout: 15_000, intervals: [500] },
    )
    .toBe(true);

  // ── 5. Fill the form inside the iframe and submit ────────────────────────
  const frameLocator = page.frameLocator('#form-iframe');
  await frameLocator.getByLabel('Your feedback').fill('Great service!');
  await frameLocator.getByRole('button', { name: /submit/i }).click();

  // ── 6. Wait for form-submit postMessage ─────────────────────────────────
  await expect
    .poll(
      async () => {
        const messages = await page.evaluate(() => {
          return (window as unknown as { __postMessages: Array<{ type: string }> }).__postMessages ?? [];
        });
        return messages.some((m) => m.type === 'form-submit');
      },
      { timeout: 15_000, intervals: [500] },
    )
    .toBe(true);

  // ── 7. Verify the form-submit message shape ──────────────────────────────
  const submitMessage = await page.evaluate(() => {
    const msgs = (window as unknown as { __postMessages: Array<{ type: string; submissionId?: string }> }).__postMessages ?? [];
    return msgs.find((m) => m.type === 'form-submit');
  });

  expect(submitMessage).toBeDefined();
  expect(submitMessage?.submissionId).toBeTruthy();
});
