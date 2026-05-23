/**
 * Restore-submission smoke test.
 *
 *   1. Submit → soft-delete → restore → detail should be visible again.
 *   2. Second restore on the now-active row → 404.
 *   3. Audit log captures both submission.delete and submission.restore.
 */
import 'dotenv/config'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { SignJWT } from 'jose'

const FORM_API = 'http://localhost:4200'
const SUB = process.env['FORMS_BOOTSTRAP_ADMIN_SUB']!
const SECRET = process.env['FORMS_JWT_SECRET']!

const prisma = new PrismaClient({
  adapter: new PrismaPg(
    new pg.Pool({ connectionString: process.env['DATABASE_URL']!, max: 5 }),
  ),
})

async function mintAdmin(): Promise<string> {
  return new SignJWT({ sub: SUB, sid: 'restore-smoke', roles: ['super-admin'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(SECRET))
}

async function call(method: string, path: string, token: string) {
  const res = await fetch(`${FORM_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[smoke] FAIL — ${msg}`)
}

async function main() {
  const token = await mintAdmin()

  const submitRes = await fetch(`${FORM_API}/public/forms/form-1/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { fld_0ab3df459daa: 'restore smoke' } }),
  })
  const submit = (await submitRes.json()) as { submission_id: string }
  console.log(`[smoke] submitted ${submit.submission_id.slice(0, 8)}…`)

  const del = await call('DELETE', `/admin/submissions/${submit.submission_id}`, token)
  assert(del.status === 204, `delete ${del.status}`)

  const restore = await call(
    'POST',
    `/admin/submissions/${submit.submission_id}/restore`,
    token,
  )
  assert(restore.status === 204, `restore ${restore.status}: ${JSON.stringify(restore.body)}`)
  console.log('[smoke] restore → 204')

  // Detail is now visible without include_deleted
  const detail = await call('GET', `/admin/submissions/${submit.submission_id}`, token)
  assert(detail.status === 200, `detail after restore ${detail.status}`)
  const d = detail.body as { deleted_at: string | null }
  assert(d.deleted_at === null, 'deleted_at should be null after restore')
  console.log('[smoke] detail visible, deleted_at=null')

  // Second restore → 404 (row isn't deleted anymore)
  const second = await call(
    'POST',
    `/admin/submissions/${submit.submission_id}/restore`,
    token,
  )
  assert(second.status === 404, `double restore ${second.status}`)
  console.log('[smoke] second restore → 404')

  // Audit captured both events
  const audit = await prisma.auditLog.findMany({
    where: { subjectId: submit.submission_id },
    orderBy: { at: 'asc' },
    select: { action: true },
  })
  const actions = audit.map((r) => r.action).join(',')
  console.log(`[smoke] audit trail: ${actions}`)
  assert(actions.includes('submission.delete'), 'submission.delete missing from audit')
  assert(actions.includes('submission.restore'), 'submission.restore missing from audit')

  console.log('[smoke] PASS')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
