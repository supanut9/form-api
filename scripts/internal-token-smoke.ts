/**
 * Smoke test for the service-token-gated internal endpoints.
 *
 *   1. Mints an api token with `events.read` scope directly via TokenService.
 *   2. Calls /internal/events/demo.signup.v1/status for the anonymous_token
 *      created in earlier smoke runs.
 *   3. Verifies 401 without a token and 403 with an under-scoped token.
 *
 * Pre-req: demo.signup.v1 already seeded by earlier event smoke run.
 */
import 'dotenv/config'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { TokenService } from '../src/core/tokens/token.service.js'

const FORM_API = process.env['FORMS_API_BASE_URL'] ?? 'http://localhost:4200'

const adapter = new PrismaPg(
  new pg.Pool({ connectionString: process.env['DATABASE_URL']!, max: 5 }),
)
const prisma = new PrismaClient({ adapter })

async function call(path: string, token?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${FORM_API}${path}`, { headers })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[smoke] FAIL — ${msg}`)
}

async function main() {
  const service = new TokenService(prisma)

  // ── No token ──────────────────────────────────────────────────────────────
  const noTok = await call('/internal/events/demo.signup.v1/status?account_id=x')
  assert(noTok.status === 401, `no-token expected 401 got ${noTok.status}`)
  console.log('[smoke] no token → 401')

  // ── Wrong scope ──────────────────────────────────────────────────────────
  const wrong = await service.issueToken({
    name: 'smoke wrong-scope',
    type: 'webhook_caller',
    scopes: ['webhooks.replay'],
  })
  const wrongRes = await call(
    '/internal/events/demo.signup.v1/status?account_id=x',
    wrong.token,
  )
  assert(wrongRes.status === 403, `wrong-scope expected 403 got ${wrongRes.status}`)
  console.log('[smoke] wrong-scope token → 403')

  // ── Right scope: known event + known anonymous_token (filled) ────────────
  const good = await service.issueToken({
    name: 'smoke events.read',
    type: 'public_read',
    scopes: ['events.read'],
  })

  // Find an anonymous_token that previously filled demo.signup.v1
  const fill = await prisma.formEventFill.findFirst({
    where: { eventKey: 'demo.signup.v1', anonymousToken: { not: null } },
    select: { anonymousToken: true },
  })
  if (!fill?.anonymousToken) {
    console.warn('[smoke] no anon fill for demo.signup.v1 — submitting one now')
    const submitRes = await fetch(`${FORM_API}/public/forms/form-1/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: { fld_0ab3df459daa: 'token smoke' },
        event_key: 'demo.signup.v1',
      }),
    })
    const cookieHeader = submitRes.headers.get('set-cookie') ?? ''
    const m = /form_anon=([^;]+)/.exec(cookieHeader)
    if (!m) throw new Error('no form_anon cookie returned')
    fill!.anonymousToken = m[1]!
  }

  const statusRes = await call(
    `/internal/events/demo.signup.v1/status?anonymous_token=${encodeURIComponent(fill!.anonymousToken!)}`,
    good.token,
  )
  assert(statusRes.status === 200, `status expected 200 got ${statusRes.status}: ${JSON.stringify(statusRes.body)}`)
  const status = statusRes.body as { filled: boolean; event_key: string; form_url: string }
  console.log(
    `[smoke] valid call → filled=${status.filled} form_url=${status.form_url}`,
  )
  assert(status.filled === true, 'expected filled=true for known anonymous token')

  // ── Unknown event ────────────────────────────────────────────────────────
  const unknown = await call(
    '/internal/events/nope.does_not_exist/status?account_id=x',
    good.token,
  )
  assert(unknown.status === 404, `unknown event expected 404 got ${unknown.status}`)
  console.log('[smoke] unknown event → 404')

  // ── Missing identity ─────────────────────────────────────────────────────
  const missingId = await call(
    '/internal/events/demo.signup.v1/status',
    good.token,
  )
  assert(missingId.status === 400, `missing identity expected 400 got ${missingId.status}`)
  console.log('[smoke] missing identity → 400')

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await service.deleteToken(wrong.row.id)
  await service.deleteToken(good.row.id)

  console.log('[smoke] PASS')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
