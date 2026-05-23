/**
 * End-to-end smoke for prefill + replace submit behavior.
 *
 *   1. Publish a new version of form-1 with two fields and prefill enabled:
 *        - fld_keep:  prefill default-on (left implicit)
 *        - fld_fresh: prefill explicitly false
 *        prefill: { mode: last_submission, identity: authenticated, submit_behavior: replace }
 *
 *   2. Mint a user-session JWT for a fake account_id.
 *
 *   3. Submit #1 with both fields populated.
 *   4. Hit /public/forms/:slug/prefill with Bearer → expect prior payload
 *      filtered to fld_keep only (fld_fresh dropped because prefill: false).
 *   5. Submit #2 — prior row should be soft-deleted, new row inserted.
 *   6. /prefill again → returns submit #2's payload.
 *   7. Verify there's exactly one live row + one soft-deleted row for this account.
 *   8. Restore version 1 spec at the end so the rest of the harness keeps working.
 */
import 'dotenv/config'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { SignJWT } from 'jose'
import { issueSession } from '../src/core/auth/session.js'

const FORM_API = 'http://localhost:4200'
const SUB = process.env['FORMS_BOOTSTRAP_ADMIN_SUB']!
const SECRET = process.env['FORMS_JWT_SECRET']!

const prisma = new PrismaClient({
  adapter: new PrismaPg(
    new pg.Pool({ connectionString: process.env['DATABASE_URL']!, max: 5 }),
  ),
})

async function mintAdmin(): Promise<string> {
  return new SignJWT({ sub: SUB, sid: 'prefill-smoke', roles: ['super-admin'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(SECRET))
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${FORM_API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  return { status: res.status, body: parsed }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[smoke] FAIL — ${msg}`)
}

async function main() {
  const admin = await mintAdmin()

  // Resolve form-1 → uuid (versions endpoint expects an id, not a slug).
  const form = await prisma.formDefinition.findUnique({
    where: { slug: 'form-1' },
    select: { id: true },
  })
  if (!form) throw new Error('form-1 not found — seed it via the admin UI first')
  const formId = form.id

  // 1. Publish a new spec.
  const newSpec = {
    title: 'Form 1 (prefill smoke)',
    type: 'dynamic',
    access: { mode: 'public_anonymous', require_account: false },
    pages: [
      {
        id: 'pg_1',
        title: 'Page 1',
        fields: [
          { id: 'fld_keep', type: 'text', label: 'Sticky', required: true },
          {
            id: 'fld_fresh',
            type: 'text',
            label: 'This week',
            required: false,
            prefill: false,
          },
        ],
      },
    ],
    prefill: {
      mode: 'last_submission',
      identity: 'authenticated',
      submit_behavior: 'replace',
    },
  }
  const pub = await call('POST', `/admin/forms/${formId}/versions`, admin, {
    spec_json: newSpec,
  })
  assert(pub.status === 201, `publish ${pub.status}: ${JSON.stringify(pub.body)}`)
  console.log('[smoke] published smoke spec on form-1')

  // 2. Mint user session.
  const fakeSub = `00000000-0000-0000-0000-${Date.now().toString(16).padStart(12, '0')}`
  const userSession = await issueSession(prisma, {
    sub: fakeSub,
    roles: [],
    userAgent: 'prefill-smoke',
    ipHash: 'smoke',
  })
  const userToken = userSession.access_token
  console.log(`[smoke] minted user session for ${fakeSub.slice(0, 8)}…`)

  // 3. Submit #1.
  const submit1 = await call('POST', '/public/forms/form-1/submit', userToken, {
    payload: { fld_keep: 'sticky-1', fld_fresh: 'this-week-1' },
  })
  assert(submit1.status === 200, `submit1 ${submit1.status}`)
  console.log('[smoke] submit #1 → 200')

  // 4. Prefill returns prior submission filtered to keep field only.
  const prefill1 = await call('GET', '/public/forms/form-1/prefill', userToken)
  assert(prefill1.status === 200, `prefill1 ${prefill1.status}: ${JSON.stringify(prefill1.body)}`)
  const p1 = prefill1.body as { payload: Record<string, unknown> }
  console.log(`[smoke] prefill1 payload keys=${Object.keys(p1.payload).join(',')}`)
  assert(p1.payload.fld_keep === 'sticky-1', 'fld_keep should be in prefill payload')
  assert(
    !('fld_fresh' in p1.payload),
    'fld_fresh has prefill:false and should be excluded from prefill payload',
  )

  // 5. Submit #2 — replace behavior should soft-delete submit #1.
  const submit2 = await call('POST', '/public/forms/form-1/submit', userToken, {
    payload: { fld_keep: 'sticky-2', fld_fresh: 'this-week-2' },
  })
  assert(submit2.status === 200, `submit2 ${submit2.status}`)
  console.log('[smoke] submit #2 → 200')

  // 6. Prefill now returns submit #2.
  const prefill2 = await call('GET', '/public/forms/form-1/prefill', userToken)
  assert(prefill2.status === 200, `prefill2 ${prefill2.status}`)
  const p2 = prefill2.body as { payload: Record<string, unknown> }
  assert(p2.payload.fld_keep === 'sticky-2', `expected sticky-2 got ${p2.payload.fld_keep}`)
  console.log('[smoke] prefill2 reflects submit #2')

  // 7. Verify DB rows.
  const rows = await prisma.formSubmission.findMany({
    where: { accountId: fakeSub },
    orderBy: { submittedAt: 'asc' },
    select: { id: true, deletedAt: true, payloadJsonb: true },
  })
  const liveCount = rows.filter((r) => r.deletedAt === null).length
  const deletedCount = rows.filter((r) => r.deletedAt !== null).length
  console.log(
    `[smoke] db rows: live=${liveCount} deleted=${deletedCount} total=${rows.length}`,
  )
  assert(liveCount === 1, `expected 1 live row, got ${liveCount}`)
  assert(deletedCount === 1, `expected 1 soft-deleted row, got ${deletedCount}`)

  // 8. Counter-test: anonymous request gets no prefill (identity=authenticated).
  const anonRes = await fetch(`${FORM_API}/public/forms/form-1/prefill`)
  assert(
    anonRes.status === 204,
    `anonymous prefill expected 204 got ${anonRes.status}`,
  )
  console.log('[smoke] anonymous → 204')

  // 9. Restore an even simpler default spec so future smokes start clean.
  const restore = await call('POST', `/admin/forms/${formId}/versions`, admin, {
    spec_json: {
      title: 'Form 1',
      type: 'dynamic',
      access: { mode: 'public_anonymous', require_account: false },
      pages: [
        {
          id: 'pg_1',
          title: 'Page 1',
          fields: [
            {
              id: 'fld_0ab3df459daa',
              type: 'text',
              label: 'New text field',
              required: false,
            },
          ],
        },
      ],
    },
  })
  assert(restore.status === 201, `restore baseline ${restore.status}`)
  console.log('[smoke] restored baseline form-1 spec')

  console.log('[smoke] PASS')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
