/**
 * End-to-end smoke for POST /admin/forms/:id/duplicate.
 *
 *   1. Mints a bootstrap-admin session JWT.
 *   2. Calls duplicate with explicit slug/title.
 *   3. Verifies the new form exists with its own current published version
 *      pointing at the cloned spec.
 *   4. Tidies up: archives the duplicate (we can't hard-delete without
 *      super-admin path; archive is enough for smoke purposes).
 */
import 'dotenv/config'
import { SignJWT } from 'jose'

const FORM_API = 'http://localhost:4200'
const SUB = process.env['FORMS_BOOTSTRAP_ADMIN_SUB']!
const SECRET = process.env['FORMS_JWT_SECRET']!

if (!SUB || !SECRET) throw new Error('FORMS_BOOTSTRAP_ADMIN_SUB + FORMS_JWT_SECRET required')

async function mintToken(): Promise<string> {
  return new SignJWT({ sub: SUB, sid: 'dup-smoke', roles: ['super-admin'] })
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
  const parsed = await res.json().catch(() => null)
  return { status: res.status, body: parsed }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[smoke] FAIL — ${msg}`)
}

async function main() {
  const token = await mintToken()
  const newSlug = `dup-${Date.now().toString(36)}`
  const dup = await call('POST', '/admin/forms/form-1/duplicate', token, {
    slug: newSlug,
    title: `Duplicated ${newSlug}`,
  })
  assert(dup.status === 201, `duplicate ${dup.status}: ${JSON.stringify(dup.body)}`)
  const created = dup.body as { id: string; slug: string; sourceVersion: number | null }
  console.log(`[smoke] duplicated → ${created.id} slug=${created.slug} from v${created.sourceVersion}`)

  // Fetch the new form
  const getRes = await call('GET', `/admin/forms/${created.id}`, token)
  assert(getRes.status === 200, `get duplicate ${getRes.status}`)
  const def = getRes.body as { currentVersion?: number; title: string; slug: string }
  console.log(`[smoke] duplicate form: title="${def.title}" slug=${def.slug} v${def.currentVersion}`)
  assert(def.currentVersion === 1, `expected currentVersion=1, got ${def.currentVersion}`)

  // Fetch the version spec
  const verRes = await call('GET', `/admin/forms/${created.id}/versions/1`, token)
  assert(verRes.status === 200, `get duplicate version ${verRes.status}`)
  const ver = verRes.body as {
    specJson?: { id: string; version: number; pages: unknown[] }
    spec_json?: { id: string; version: number; pages: unknown[] }
  }
  const spec = ver.specJson ?? ver.spec_json
  if (!spec) throw new Error(`unexpected version shape: ${JSON.stringify(ver)}`)
  console.log(
    `[smoke] cloned spec: id=${spec.id.slice(0, 8)}… version=${spec.version} pages=${spec.pages.length}`,
  )
  assert(spec.id === created.id, 'cloned spec id was not re-stamped to new form id')
  assert(spec.version === 1, 'cloned spec version not 1')

  // Slug collision check
  const collision = await call('POST', '/admin/forms/form-1/duplicate', token, {
    slug: newSlug, // reuse same slug
  })
  assert(collision.status === 409, `slug collision expected 409 got ${collision.status}`)
  console.log('[smoke] slug collision → 409')

  // Bad slug
  const bad = await call('POST', '/admin/forms/form-1/duplicate', token, {
    slug: 'BadSlug',
  })
  assert(bad.status === 400, `bad slug expected 400 got ${bad.status}: ${JSON.stringify(bad.body)}`)
  console.log('[smoke] invalid slug → 400')

  // Cleanup: archive the duplicate
  const archive = await call('POST', `/admin/forms/${created.id}/archive`, token, {})
  assert(archive.status === 200, `archive ${archive.status}`)
  console.log('[smoke] PASS')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
