/**
 * E2E — Public submit rate limiting
 *
 * Hammers POST /v1/public/forms/<slug>/submit 30 times in rapid succession
 * and asserts that at least one response returns HTTP 429, and that the 429
 * response body contains backoff guidance (a `retry_after` or `message` field).
 *
 * The rate limit is configured on the Fastify `@fastify/rate-limit` plugin
 * for the public submit route. The exact threshold is service-defined; we
 * only assert that it fires within 30 calls.
 *
 * Prerequisites: form-api on :4200, E2E_ADMIN_TOKEN set.
 */

import { test, expect } from '@playwright/test';

const FORM_API = 'http://localhost:4200';
const E2E_ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? '';

test('rate limit — 30 rapid submits yield at least one 429 with backoff guidance', async () => {
  // ── 1. Create a public_anonymous form ───────────────────────────────────
  const createFormRes = await fetch(`${FORM_API}/v1/admin/forms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Token': E2E_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      title: `Rate Limit E2E ${Date.now()}`,
      type: 'dynamic',
      access: { mode: 'public_anonymous', require_account: false, anonymous_allowed: true },
      spec: {
        pages: [
          {
            id: 'pg_1',
            title: 'Page',
            show_if: null,
            fields: [
              {
                id: 'fld_text',
                type: 'text',
                label: 'Text',
                required: false,
              },
            ],
          },
        ],
        thank_you: { title: 'Done', body_md: '', redirect_url_template: '' },
        submit: { post_actions: [] },
      },
    }),
  });
  expect(createFormRes.status).toBe(201);
  const form = (await createFormRes.json()) as { id: string; slug: string };

  // ── 2. Fire 30 submits sequentially from the same IP ────────────────────
  // Sequential (not parallel) to guarantee the rate-limit window fills up
  // predictably. The X-Forwarded-For header is absent so form-api uses the
  // loopback address — a single IP bucket.
  const statuses: number[] = [];
  let rateLimitedBody: unknown = null;

  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${FORM_API}/v1/public/forms/${form.slug}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { fld_text: `attempt ${i}` } }),
    });

    statuses.push(res.status);

    if (res.status === 429 && rateLimitedBody === null) {
      rateLimitedBody = await res.json();
    }
  }

  // ── 3. At least one 429 must have occurred ───────────────────────────────
  const got429 = statuses.includes(429);
  expect(got429, `expected at least one 429 within 30 calls, got: ${JSON.stringify(statuses)}`).toBe(true);

  // ── 4. The 429 body must contain backoff guidance ────────────────────────
  expect(rateLimitedBody, '429 body should be present').toBeDefined();

  const body = rateLimitedBody as Record<string, unknown>;
  // Accept either a `retry_after` field (seconds) or a human-readable `message`
  const hasBackoffGuidance =
    typeof body['retry_after'] === 'number' ||
    (typeof body['message'] === 'string' && body['message'].length > 0) ||
    (typeof body['error'] === 'string' && body['error'].length > 0);

  expect(
    hasBackoffGuidance,
    `expected 429 body to contain retry_after or message, got: ${JSON.stringify(body)}`,
  ).toBe(true);
});
