/**
 * Smoke test for authenticated submissions.
 *
 * Issues a form-api user session (no roles) for a fake account_id, calls
 * /public/forms/form-1/submit with Authorization: Bearer, and verifies
 * the resulting FormSubmission row carries that account_id (and *not*
 * an anonymous_token).
 */
import 'dotenv/config'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { issueSession } from '../src/core/auth/session.js'

const FORM_API = 'http://localhost:4200'

const adapter = new PrismaPg(
  new pg.Pool({ connectionString: process.env['DATABASE_URL']!, max: 5 }),
)
const prisma = new PrismaClient({ adapter })

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[smoke] FAIL — ${msg}`)
}

async function main() {
  const fakeSub = `00000000-0000-0000-0000-${Date.now().toString(16).padStart(12, '0')}`
  const session = await issueSession(prisma, {
    sub: fakeSub,
    roles: [],
    userAgent: 'authed-submit-smoke',
    ipHash: 'smoke',
  })
  console.log(`[smoke] minted user session for ${fakeSub.slice(0, 8)}…`)

  const submitRes = await fetch(`${FORM_API}/public/forms/form-1/submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ payload: { fld_0ab3df459daa: 'authed value' } }),
  })
  const submitText = await submitRes.text()
  assert(submitRes.ok, `submit ${submitRes.status}: ${submitText}`)
  const submit = JSON.parse(submitText) as { submission_id: string }
  console.log(`[smoke] submission_id=${submit.submission_id}`)

  const row = await prisma.formSubmission.findUnique({
    where: { id: submit.submission_id },
  })
  assert(row, 'submission row missing')
  console.log(
    `[smoke] account_id=${row!.accountId ?? '(null)'} anonymous_token=${row!.anonymousToken ?? '(null)'}`,
  )
  assert(
    row!.accountId === fakeSub,
    `expected account_id=${fakeSub}, got ${row!.accountId}`,
  )
  assert(
    row!.anonymousToken === null,
    'authenticated submit should NOT set anonymous_token',
  )

  // Counter-test: same form, no auth → anonymous
  const anonRes = await fetch(`${FORM_API}/public/forms/form-1/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { fld_0ab3df459daa: 'anon value' } }),
  })
  assert(anonRes.ok, `anon submit ${anonRes.status}`)
  const anon = (await anonRes.json()) as { submission_id: string }
  const anonRow = await prisma.formSubmission.findUnique({
    where: { id: anon.submission_id },
  })
  assert(anonRow, 'anon submission missing')
  assert(anonRow!.accountId === null, 'anon submit should NOT set account_id')
  assert(anonRow!.anonymousToken, 'anon submit should set anonymous_token')
  console.log('[smoke] anon counter-test → account_id null, anonymous_token set')

  console.log('[smoke] PASS')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
