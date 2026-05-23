/**
 * Soft-delete smoke for submissions.
 *
 *   1. Submits a new form-1 row.
 *   2. DELETE /admin/submissions/:id → 204
 *   3. Verifies deletedAt is set in the DB.
 *   4. GET detail without include_deleted → 404.
 *   5. GET detail with include_deleted=true → 200 + deleted_at populated.
 *   6. GET list excludes the row by default; including → row visible.
 *   7. Second DELETE → 404 (already deleted).
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
  return new SignJWT({ sub: SUB, sid: 'soft-smoke', roles: ['super-admin'] })
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
  const body = text ? JSON.parse(text) : null
  return { status: res.status, body }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[smoke] FAIL — ${msg}`)
}

async function main() {
  const token = await mintAdmin()

  // 1. Submit a fresh row.
  const submitRes = await fetch(`${FORM_API}/public/forms/form-1/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { fld_0ab3df459daa: 'soft-delete smoke' } }),
  })
  const submit = (await submitRes.json()) as { submission_id: string }
  console.log(`[smoke] submitted ${submit.submission_id.slice(0, 8)}…`)

  // 2. Soft delete.
  const del = await call('DELETE', `/admin/submissions/${submit.submission_id}`, token)
  assert(del.status === 204, `delete ${del.status}: ${JSON.stringify(del.body)}`)
  console.log('[smoke] DELETE → 204')

  // 3. DB row stamped.
  const row = await prisma.formSubmission.findUnique({
    where: { id: submit.submission_id },
  })
  assert(row, 'row missing — should be soft-delete, not hard-delete')
  assert(row!.deletedAt instanceof Date, 'deletedAt not set')
  console.log(`[smoke] deletedAt=${row!.deletedAt!.toISOString()}`)

  // 4. Detail without include_deleted → 404.
  const detail = await call('GET', `/admin/submissions/${submit.submission_id}`, token)
  assert(detail.status === 404, `detail without include_deleted ${detail.status}`)
  console.log('[smoke] detail (default) → 404')

  // 5. Detail with include_deleted=true → 200.
  const detail2 = await call(
    'GET',
    `/admin/submissions/${submit.submission_id}?include_deleted=true`,
    token,
  )
  assert(detail2.status === 200, `detail include_deleted ${detail2.status}`)
  const d = detail2.body as { deleted_at: string | null }
  assert(d.deleted_at, 'detail include_deleted should expose deleted_at')
  console.log(`[smoke] detail (include_deleted) → deleted_at=${d.deleted_at}`)

  // 6. List excludes by default.
  const list = await call(
    'GET',
    `/admin/forms/form-1/submissions?limit=50`,
    token,
  )
  const ids = (list.body as { items: { id: string }[] }).items.map((x) => x.id)
  assert(!ids.includes(submit.submission_id), 'soft-deleted row leaked into default list')
  console.log('[smoke] list (default) excludes the row')

  const listAll = await call(
    'GET',
    `/admin/forms/form-1/submissions?limit=50&include_deleted=true`,
    token,
  )
  const idsAll = (listAll.body as { items: { id: string }[] }).items.map((x) => x.id)
  assert(idsAll.includes(submit.submission_id), 'list include_deleted should show the row')
  console.log('[smoke] list (include_deleted) shows the row')

  // 7. Second delete → 404.
  const del2 = await call('DELETE', `/admin/submissions/${submit.submission_id}`, token)
  assert(del2.status === 404, `double-delete ${del2.status}`)
  console.log('[smoke] second DELETE → 404')

  console.log('[smoke] PASS')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
