/**
 * End-to-end smoke for the publish guard (POST /admin/forms/:formId/versions).
 *
 * Bad-spec cases (all expect 422 with publish_guard_failed):
 *   1. Duplicate field id on the same page
 *   2. Duplicate page id
 *   3. Field id that doesn't match the pattern
 *   4. Empty page (no fields)
 *   5. show_if referencing an unknown field id
 *   6. Archived form — temporarily archive form-1, try to publish, restore
 *
 * Good-spec case:
 *   7. Valid spec → 201
 *
 * Cleanup:
 *   8. Restore the baseline form-1 spec (one text field, no prefill).
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { SignJWT } from 'jose'

const FORM_API = 'http://localhost:4200'
const SUB = process.env['FORMS_BOOTSTRAP_ADMIN_SUB']!
const SECRET = process.env['FORMS_JWT_SECRET']!

if (!SUB || !SECRET) throw new Error('FORMS_BOOTSTRAP_ADMIN_SUB + FORMS_JWT_SECRET required')

const prisma = new PrismaClient({
  adapter: new PrismaPg(
    new pg.Pool({ connectionString: process.env['DATABASE_URL']!, max: 5 }),
  ),
})

async function mintAdmin(): Promise<string> {
  return new SignJWT({ sub: SUB, sid: 'guard-smoke', roles: ['super-admin'] })
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
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  return { status: res.status, body: parsed }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[smoke] FAIL — ${msg}`)
}

function guardCode(res: { body: unknown }): string | undefined {
  const b = res.body as { error?: { code?: string; details?: Array<{ code?: string }> } }
  return b?.error?.details?.[0]?.code
}

// Minimal valid spec skeleton — used as the base for all test cases.
const base = {
  title: 'Form 1',
  type: 'dynamic' as const,
  access: { mode: 'public_anonymous' as const, require_account: false },
}

async function main() {
  const admin = await mintAdmin()

  const form = await prisma.formDefinition.findUnique({
    where: { slug: 'form-1' },
    select: { id: true },
  })
  if (!form) throw new Error('form-1 not found — seed it first')
  const formId = form.id
  const endpoint = `/admin/forms/${formId}/versions`

  // ── Case 1: duplicate field id ──────────────────────────────────────────────
  const r1 = await call('POST', endpoint, admin, {
    spec_json: {
      ...base,
      pages: [{
        id: 'pg_1',
        title: 'Page 1',
        fields: [
          { id: 'fld_a', type: 'text', label: 'Field A' },
          { id: 'fld_a', type: 'text', label: 'Field A again' },
        ],
      }],
    },
  })
  assert(r1.status === 422, `case1 expected 422 got ${r1.status}: ${JSON.stringify(r1.body)}`)
  assert(guardCode(r1) === 'duplicate_field_id', `case1 wrong code: ${guardCode(r1)}`)
  console.log('[smoke] case 1 duplicate_field_id → 422 ✓')

  // ── Case 2: duplicate page id ───────────────────────────────────────────────
  const r2 = await call('POST', endpoint, admin, {
    spec_json: {
      ...base,
      pages: [
        { id: 'pg_1', title: 'Page 1', fields: [{ id: 'fld_x', type: 'text', label: 'X' }] },
        { id: 'pg_1', title: 'Page 1 dupe', fields: [{ id: 'fld_y', type: 'text', label: 'Y' }] },
      ],
    },
  })
  assert(r2.status === 422, `case2 expected 422 got ${r2.status}: ${JSON.stringify(r2.body)}`)
  assert(guardCode(r2) === 'duplicate_page_id', `case2 wrong code: ${guardCode(r2)}`)
  console.log('[smoke] case 2 duplicate_page_id → 422 ✓')

  // ── Case 3: bad field id pattern ────────────────────────────────────────────
  const r3 = await call('POST', endpoint, admin, {
    spec_json: {
      ...base,
      pages: [{
        id: 'pg_1',
        title: 'Page 1',
        fields: [
          { id: 'bad-id', type: 'text', label: 'Bad' },
        ],
      }],
    },
  })
  assert(r3.status === 422, `case3 expected 422 got ${r3.status}: ${JSON.stringify(r3.body)}`)
  assert(guardCode(r3) === 'field_id_pattern', `case3 wrong code: ${guardCode(r3)}`)
  console.log('[smoke] case 3 field_id_pattern → 422 ✓')

  // ── Case 4: empty page ──────────────────────────────────────────────────────
  const r4 = await call('POST', endpoint, admin, {
    spec_json: {
      ...base,
      pages: [{ id: 'pg_1', title: 'Empty page', fields: [] }],
    },
  })
  assert(r4.status === 422, `case4 expected 422 got ${r4.status}: ${JSON.stringify(r4.body)}`)
  assert(guardCode(r4) === 'empty_page', `case4 wrong code: ${guardCode(r4)}`)
  console.log('[smoke] case 4 empty_page → 422 ✓')

  // ── Case 5: show_if referencing unknown field ───────────────────────────────
  const r5 = await call('POST', endpoint, admin, {
    spec_json: {
      ...base,
      pages: [{
        id: 'pg_1',
        title: 'Page 1',
        fields: [
          {
            id: 'fld_name',
            type: 'text',
            label: 'Name',
            show_if: { '==': [{ var: 'fld_ghost' }, 'yes'] },
          },
        ],
      }],
    },
  })
  assert(r5.status === 422, `case5 expected 422 got ${r5.status}: ${JSON.stringify(r5.body)}`)
  assert(guardCode(r5) === 'unknown_field_ref', `case5 wrong code: ${guardCode(r5)}`)
  console.log('[smoke] case 5 unknown_field_ref → 422 ✓')

  // ── Case 6: archived form ───────────────────────────────────────────────────
  // Temporarily mark form-1 as archived, attempt publish, then restore.
  await prisma.formDefinition.update({
    where: { id: formId },
    data: { archivedAt: new Date() },
  })
  try {
    const r6 = await call('POST', endpoint, admin, {
      spec_json: {
        ...base,
        pages: [{ id: 'pg_1', title: 'Page 1', fields: [{ id: 'fld_a', type: 'text', label: 'A' }] }],
      },
    })
    assert(r6.status === 422, `case6 expected 422 got ${r6.status}: ${JSON.stringify(r6.body)}`)
    assert(guardCode(r6) === 'archived_form', `case6 wrong code: ${guardCode(r6)}`)
    console.log('[smoke] case 6 archived_form → 422 ✓')
  } finally {
    // Always restore archived state.
    await prisma.formDefinition.update({
      where: { id: formId },
      data: { archivedAt: null },
    })
  }

  // ── Case 7: valid spec → 201 ────────────────────────────────────────────────
  const r7 = await call('POST', endpoint, admin, {
    spec_json: {
      ...base,
      pages: [{
        id: 'pg_1',
        title: 'Page 1',
        fields: [
          { id: 'fld_first', type: 'text', label: 'First Name', required: true },
          {
            id: 'fld_last',
            type: 'text',
            label: 'Last Name',
            show_if: { '==': [{ var: 'fld_first' }, 'show'] },
          },
        ],
      }],
    },
  })
  assert(r7.status === 201, `case7 expected 201 got ${r7.status}: ${JSON.stringify(r7.body)}`)
  console.log('[smoke] case 7 valid spec → 201 ✓')

  // ── Restore baseline spec ───────────────────────────────────────────────────
  const restore = await call('POST', endpoint, admin, {
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
  assert(restore.status === 201, `restore baseline ${restore.status}: ${JSON.stringify(restore.body)}`)
  console.log('[smoke] restored baseline form-1 spec')

  console.log('[smoke] PASS')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
