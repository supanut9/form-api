/**
 * E2E — Webhook delivery + retry flow
 *
 * Spins up a local HTTP echo server on port 4299 that returns 500 on the
 * first call and 200 thereafter. Verifies BullMQ retries and that the admin
 * deliveries endpoint shows both attempts.
 *
 * Prerequisites: form-api on :4200, seeded admin token in E2E_ADMIN_TOKEN.
 */

import { test, expect } from '@playwright/test';
import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';

const FORM_API = 'http://localhost:4200';
const ECHO_PORT = 4299;
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

async function apiGet(path: string): Promise<Response> {
  return fetch(`${FORM_API}${path}`, {
    headers: { 'X-Api-Token': E2E_ADMIN_TOKEN },
  });
}

test('webhook retry — first attempt 500, second attempt 200, deliveries shows both', async () => {
  // ── Spin up local echo server ───────────────────────────────────────────────
  let callCount = 0;
  const receivedBodies: string[] = [];

  const echoServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      callCount++;
      receivedBodies.push(body);
      if (callCount === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated failure' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });

  await new Promise<void>((resolve) => echoServer.listen(ECHO_PORT, resolve));

  try {
    // ── Create a form + webhook ──────────────────────────────────────────────
    const createFormRes = await apiPost('/v1/admin/forms', {
      title: `Webhook Retry Test ${Date.now()}`,
      type: 'dynamic',
      access: { mode: 'public_anonymous', require_account: false, anonymous_allowed: true },
      spec: {
        pages: [
          {
            id: 'pg_1',
            title: 'Page 1',
            show_if: null,
            fields: [
              {
                id: 'fld_name',
                type: 'text',
                label: 'Name',
                required: true,
              },
            ],
          },
        ],
        thank_you: { title: 'Done', body_md: '', redirect_url_template: '' },
        submit: { post_actions: [] },
      },
    });
    expect(createFormRes.status).toBe(201);
    const form = (await createFormRes.json()) as { id: string; slug: string };

    const createWebhookRes = await apiPost('/v1/admin/webhooks', {
      form_id: form.id,
      url: `http://localhost:${ECHO_PORT}/webhook`,
      events: ['submitted'],
      secret_ref: 'E2E_WEBHOOK_SECRET',
    });
    expect(createWebhookRes.status).toBe(201);
    const webhook = (await createWebhookRes.json()) as { id: string };

    // ── Submit the form (anonymous) ──────────────────────────────────────────
    const submitRes = await fetch(`${FORM_API}/v1/public/forms/${form.slug}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { fld_name: 'E2E Tester' } }),
    });
    expect(submitRes.status).toBe(201);

    // ── Wait for BullMQ to retry (poll deliveries until 2 attempts appear) ──
    const deadline = Date.now() + 30_000;
    let deliveries: Array<{ attempt: number; status: string; response_code: number }> = [];

    while (Date.now() < deadline) {
      const deliveriesRes = await apiGet(`/v1/admin/webhooks/${webhook.id}/deliveries`);
      if (deliveriesRes.ok) {
        const body = (await deliveriesRes.json()) as {
          items: Array<{ attempt: number; status: string; response_code: number }>;
        };
        deliveries = body.items ?? [];
        if (deliveries.length >= 2) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    // ── Assert: two delivery attempts ────────────────────────────────────────
    expect(deliveries.length, 'expected at least 2 delivery attempts').toBeGreaterThanOrEqual(2);

    const firstAttempt = deliveries.find((d) => d.attempt === 1);
    expect(firstAttempt, 'first attempt should exist').toBeDefined();
    expect(firstAttempt?.response_code).toBe(500);
    expect(firstAttempt?.status).toBe('failed');

    const secondAttempt = deliveries.find((d) => d.attempt === 2);
    expect(secondAttempt, 'second attempt should exist').toBeDefined();
    expect(secondAttempt?.response_code).toBe(200);
    expect(secondAttempt?.status).toBe('delivered');

    // ── Assert: echo server received two calls ────────────────────────────────
    expect(callCount).toBeGreaterThanOrEqual(2);
  } finally {
    await new Promise<void>((resolve) => echoServer.close(() => resolve()));
  }
});
