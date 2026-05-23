/**
 * issue-test-session.ts
 *
 * Utility script that issues a signed form-api session JWT (or admin API token)
 * for use in Playwright e2e tests. The JWT bypasses real OIDC by using the
 * same signing key that form-api uses internally.
 *
 * Usage:
 *   pnpm tsx scripts/issue-test-session.ts --sub <uuid>
 *   pnpm tsx scripts/issue-test-session.ts --sub <uuid> --admin
 *
 * Options:
 *   --sub <uuid>   Subject (account ID) to embed in the token
 *   --admin        Issue an admin API token (X-Api-Token header) instead of a
 *                  session cookie JWT. The token is printed as a plain string.
 *
 * Outputs a single line to stdout: the raw token value.
 * In e2e tests consume it as:
 *   E2E_USER_SESSION=$(pnpm tsx scripts/issue-test-session.ts --sub <uuid>)
 *   E2E_ADMIN_TOKEN=$(pnpm tsx scripts/issue-test-session.ts --sub <uuid> --admin)
 *
 * NOTE: This script must only be run in local dev or CI test environments.
 * It reads FORM_SESSION_SECRET from the environment.
 */

import { parseArgs } from 'node:util';
import { SignJWT } from 'jose';
import { v7 as uuidv7 } from 'uuid';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  options: {
    sub: { type: 'string' },
    admin: { type: 'boolean', default: false },
  },
});

if (!values.sub) {
  console.error('Usage: pnpm tsx scripts/issue-test-session.ts --sub <uuid> [--admin]');
  process.exit(1);
}

const sub = values.sub;
const isAdmin = values.admin ?? false;

// ---------------------------------------------------------------------------
// Read signing secret from env (same key form-api uses for sessions)
// ---------------------------------------------------------------------------
const sessionSecret = process.env.FORM_SESSION_SECRET;
if (!sessionSecret) {
  console.error('FORM_SESSION_SECRET environment variable is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Issue session JWT  (mirrors src/core/auth/session.ts signSession())
// ---------------------------------------------------------------------------
async function issueSessionJwt(accountId: string, secret: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(secret);
  const token = await new SignJWT({
    sub: accountId,
    role: 'user',
    iss: 'form-api',
    jti: uuidv7(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    // Long-lived for test use: 30 days
    .setExpirationTime('30d')
    .sign(keyBytes);
  return token;
}

// ---------------------------------------------------------------------------
// Issue admin API token  (mirrors src/core/tokens/api-token.service.ts shape)
// The token itself is a random opaque string; what we print is the raw token.
// In tests this is passed as X-Api-Token.  The seed-e2e.ts script must have
// already inserted the corresponding hash into form_api_tokens.
// ---------------------------------------------------------------------------
function issueAdminApiToken(accountId: string): string {
  // Deterministic for test seeding: sha256(E2E_ADMIN_TOKEN_SEED + accountId)
  const seed = process.env.E2E_ADMIN_TOKEN_SEED ?? 'e2e-admin-seed';
  return crypto
    .createHash('sha256')
    .update(`${seed}:${accountId}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const token = isAdmin
  ? issueAdminApiToken(sub)
  : await issueSessionJwt(sub, sessionSecret);

process.stdout.write(token + '\n');
