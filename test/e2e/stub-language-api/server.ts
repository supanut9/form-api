/**
 * stub-language-api/server.ts
 *
 * Minimal Node http server that simulates the receiving service
 * (language-api) in e2e integration testing.
 *
 * Endpoints:
 *   POST /internal/forms/language-profile/submit
 *     - Reads the HMAC-SHA256 signature from X-Form-Signature header
 *     - Verifies: t=<timestamp>,v1=<hex> against sha256(`${t}.${rawBody}`)
 *     - Returns 200 { ok: true } on valid signature
 *     - Returns 400 { error: 'invalid_signature' } on mismatch
 *
 * Start via:
 *   pnpm -F form-api e2e:stub-language-api
 *
 * Configuration (env vars):
 *   STUB_PORT           — listen port (default 4298)
 *   STUB_WEBHOOK_SECRET — shared secret to verify signatures
 *                         (default: "e2e-stub-webhook-secret")
 */

import * as http from 'http';
import * as crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

const PORT = parseInt(process.env.STUB_PORT ?? '4298', 10);
const WEBHOOK_SECRET = process.env.STUB_WEBHOOK_SECRET ?? 'e2e-stub-webhook-secret';

// ---------------------------------------------------------------------------
// HMAC-SHA256 signature verification
// Signature header format: t=<unix_timestamp_ms>,v1=<hex_digest>
// Signed content: `${t}.${rawBody}` (same as form-api signer.ts)
// ---------------------------------------------------------------------------
function verifySignature(
  rawBody: string,
  sigHeader: string | undefined,
  secret: string,
): boolean {
  if (!sigHeader) return false;

  const parts = Object.fromEntries(
    sigHeader.split(',').map((part) => {
      const [k, v] = part.split('=', 2);
      return [k, v];
    }),
  );

  const { t, v1 } = parts as { t?: string; v1?: string };
  if (!t || !v1) return false;

  // Reject stale timestamps (> 5 minutes)
  const ts = parseInt(t, 10);
  if (Math.abs(Date.now() - ts) > 5 * 60 * 1_000) {
    console.warn('[stub-language-api] stale timestamp in signature, rejecting');
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'));
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';
  const method = req.method ?? '';

  // Health check
  if (url === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url === '/internal/forms/language-profile/submit' && method === 'POST') {
    let rawBody = '';
    req.on('data', (chunk: Buffer) => { rawBody += chunk.toString(); });
    req.on('end', () => {
      const sigHeader = req.headers['x-form-signature'] as string | undefined;

      if (!verifySignature(rawBody, sigHeader, WEBHOOK_SECRET)) {
        console.error('[stub-language-api] signature verification failed');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_signature' }));
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_json' }));
        return;
      }

      console.log('[stub-language-api] received valid webhook:', JSON.stringify(payload, null, 2));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`[stub-language-api] listening on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
