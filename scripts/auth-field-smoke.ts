/**
 * auth_field prefill smoke.
 *
 *   1. Publish a spec on form-1 with two fields:
 *        - fld_email: auth_field='email'
 *        - fld_note:  no auth_field
 *      prefill mode left at default ('none') so this exercises the
 *      auth-only fallback path.
 *
 *   2. Anonymous prefill → 204 (no session, no submissions).
 *
 *   3. Mint a user session carrying email='user@example.com' + name='Test User'.
 *      Hit prefill → expect 200 with payload.fld_email='user@example.com' and
 *      submission_id=null (auth-only).
 *
 *   4. Submit once with the user setting fld_email='custom@me.com'.
 *      Switch the spec to prefill.mode='last_submission' and re-publish.
 *      Hit prefill → expect prior submission's custom value to OVERRIDE the
 *      auth-derived email (user-edit wins).
 *
 *   5. Restore baseline spec.
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
  return new SignJWT({ sub: SUB, sid: 'auth-field-smoke', roles: ['super-admin'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(SECRET))
}

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${FORM_API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  return { status: res.status, body: parsed }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[smoke] FAIL — ${msg}`)
}

async function main() {
  const admin = await mintAdmin()

  const form = await prisma.formDefinition.findUnique({
    where: { slug: 'form-1' },
    select: { id: true },
  })
  if (!form) throw new Error('form-1 missing')
  const formId = form.id

  // 1. Publish auth-only spec.
  const authOnlySpec = {
    title: 'Form 1 (auth_field smoke)',
    type: 'dynamic',
    access: { mode: 'public_anonymous', require_account: false },
    pages: [
      {
        id: 'pg_1',
        title: 'Page 1',
        fields: [
          { id: 'fld_email', type: 'text', label: 'Email', required: false, auth_field: 'email' },
          { id: 'fld_note', type: 'text', label: 'Note', required: false },
        ],
      },
    ],
  }
  const pub = await call('POST', `/admin/forms/${formId}/versions`, admin, {
    spec_json: authOnlySpec,
  })
  assert(pub.status === 201, `publish auth-only ${pub.status}: ${JSON.stringify(pub.body)}`)
  console.log('[smoke] published auth-only spec')

  // 2. Anonymous prefill → 204.
  const anon = await call('GET', '/public/forms/form-1/prefill', null)
  assert(anon.status === 204, `anonymous prefill expected 204 got ${anon.status}`)
  console.log('[smoke] anonymous → 204')

  // 3. Mint user session with email + name.
  const fakeSub = `00000000-0000-0000-0000-${Date.now().toString(16).padStart(12, '0')}`
  const userSession = await issueSession(prisma, {
    sub: fakeSub,
    roles: [],
    email: 'user@example.com',
    name: 'Test User',
    userAgent: 'auth-field-smoke',
    ipHash: 'smoke',
  })
  const userToken = userSession.access_token
  console.log(`[smoke] minted session for ${fakeSub.slice(0, 8)}… (email=user@example.com)`)

  const authOnly = await call('GET', '/public/forms/form-1/prefill', userToken)
  assert(authOnly.status === 200, `auth-only prefill ${authOnly.status}: ${JSON.stringify(authOnly.body)}`)
  const a = authOnly.body as { payload: Record<string, unknown>; submission_id: string | null; sources?: { auth: string[]; prior_submission: string[] } }
  console.log(`[smoke] auth-only prefill payload=${JSON.stringify(a.payload)} sources=${JSON.stringify(a.sources)}`)
  assert(a.submission_id === null, 'auth-only response should have submission_id=null')
  assert(a.payload.fld_email === 'user@example.com', 'fld_email should be user@example.com from auth claim')
  assert(!('fld_note' in a.payload), 'fld_note has no auth_field — should not be in payload')

  // 4. User submits with a different email; switch spec to last_submission and re-check.
  const submit = await call('POST', '/public/forms/form-1/submit', userToken, {
    payload: { fld_email: 'custom@me.com', fld_note: 'first answer' },
  })
  assert(submit.status === 200, `submit ${submit.status}`)
  console.log('[smoke] user submitted custom@me.com')

  const replaceSpec = {
    ...authOnlySpec,
    prefill: { mode: 'last_submission', identity: 'authenticated', submit_behavior: 'append' },
  }
  const pub2 = await call('POST', `/admin/forms/${formId}/versions`, admin, {
    spec_json: replaceSpec,
  })
  assert(pub2.status === 201, `publish last_submission ${pub2.status}`)

  const layered = await call('GET', '/public/forms/form-1/prefill', userToken)
  assert(layered.status === 200, `layered prefill ${layered.status}`)
  const l = layered.body as { payload: Record<string, unknown>; submission_id: string | null }
  console.log(`[smoke] layered prefill payload=${JSON.stringify(l.payload)} submission_id=${l.submission_id?.slice(0,8)}…`)
  assert(
    l.payload.fld_email === 'custom@me.com',
    `prior submission value should override auth_field; got ${l.payload.fld_email}`,
  )
  assert(l.payload.fld_note === 'first answer', 'fld_note should be prefilled from prior submission')
  assert(l.submission_id !== null, 'last_submission mode should report submission_id')

  // 5. Restore baseline.
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
            { id: 'fld_0ab3df459daa', type: 'text', label: 'New text field', required: false },
          ],
        },
      ],
    },
  })
  assert(restore.status === 201, `restore baseline ${restore.status}`)
  console.log('[smoke] restored baseline')

  console.log('[smoke] PASS')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
