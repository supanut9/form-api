/**
 * Local admin-API smoke test.
 *
 * Mints a short-lived form-api session JWT for FORMS_BOOTSTRAP_ADMIN_SUB
 * and exercises every newly-built admin endpoint with it.
 *
 * Usage:
 *   pnpm tsx scripts/admin-smoke.ts
 */
import 'dotenv/config'
import { SignJWT } from 'jose'

const FORM_API = process.env['FORMS_API_BASE_URL'] ?? 'http://localhost:4200'
const SUB = process.env['FORMS_BOOTSTRAP_ADMIN_SUB']
const SECRET = process.env['FORMS_JWT_SECRET']

if (!SUB) throw new Error('FORMS_BOOTSTRAP_ADMIN_SUB env var required')
if (!SECRET || SECRET.length < 32) {
  throw new Error('FORMS_JWT_SECRET env var (≥32 chars) required')
}

async function mintToken(): Promise<string> {
  const key = new TextEncoder().encode(SECRET)
  return new SignJWT({ sub: SUB, sid: 'smoke-session', roles: ['super-admin'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key)
}

async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${FORM_API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    parsed = await res.text().catch(() => '')
  }
  return { status: res.status, body: parsed }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`[smoke] FAIL — ${msg}`)
  }
}

async function main() {
  const token = await mintToken()
  console.log('[smoke] minted bootstrap token')

  // ── /admin/permissions ────────────────────────────────────────────────────
  const permsRes = await call('GET', '/admin/permissions', token)
  assert(permsRes.status === 200, `permissions ${permsRes.status}`)
  const perms = permsRes.body as Array<{ key: string }>
  console.log(`[smoke] permissions catalog → ${perms.length} keys`)
  assert(perms.length > 0, 'no permissions in catalog')

  // ── /admin/roles list ─────────────────────────────────────────────────────
  const rolesRes = await call('GET', '/admin/roles', token)
  assert(rolesRes.status === 200, `list roles ${rolesRes.status}`)
  const roles = rolesRes.body as Array<{ name: string; is_system: boolean; id: string }>
  console.log(`[smoke] roles → ${roles.length} total`)
  assert(roles.some((r) => r.name === 'super-admin'), 'super-admin role missing')

  // ── Create custom role ────────────────────────────────────────────────────
  const newRoleName = `smoke_${Date.now().toString(36)}`
  const createRoleRes = await call('POST', '/admin/roles', token, {
    name: newRoleName,
    description: 'smoke test',
    permission_ids: ['read:Submission', 'read:Form'],
  })
  assert(createRoleRes.status === 201, `create role ${createRoleRes.status}: ${JSON.stringify(createRoleRes.body)}`)
  const created = createRoleRes.body as { id: string; name: string; permissions: unknown[] }
  console.log(`[smoke] created role ${created.name} (id=${created.id.slice(0, 8)}…)`)
  assert(created.permissions.length === 2, 'expected 2 permissions on new role')

  // ── Update + delete ───────────────────────────────────────────────────────
  const patchRes = await call('PATCH', `/admin/roles/${created.id}`, token, {
    description: 'updated description',
  })
  assert(patchRes.status === 200, `update role ${patchRes.status}`)
  const deleteRes = await call('DELETE', `/admin/roles/${created.id}`, token)
  assert(
    deleteRes.status === 204,
    `delete role ${deleteRes.status} body=${JSON.stringify(deleteRes.body)}`,
  )
  console.log('[smoke] role create/update/delete round-trip OK')

  // ── System-role guard ────────────────────────────────────────────────────
  const sysRole = roles.find((r) => r.name === 'super-admin')!
  const deleteSysRes = await call('DELETE', `/admin/roles/${sysRole.id}`, token)
  assert(
    deleteSysRes.status === 400,
    `expected 400 when deleting system role, got ${deleteSysRes.status}`,
  )
  console.log('[smoke] system-role delete refused (400)')

  // ── Tokens ────────────────────────────────────────────────────────────────
  const createTokRes = await call('POST', '/admin/tokens', token, {
    name: 'smoke token',
    type: 'webhook_caller',
    scopes: ['webhooks.receive'],
  })
  assert(createTokRes.status === 201, `create token ${createTokRes.status}: ${JSON.stringify(createTokRes.body)}`)
  const tokenResp = createTokRes.body as { token: string; row: { id: string; scopes_json: string[] } }
  assert(tokenResp.token.startsWith('fak_'), 'token prefix missing')
  console.log(`[smoke] token issued (id=${tokenResp.row.id.slice(0, 8)}…) prefix=${tokenResp.token.slice(0, 4)}`)

  const listTokRes = await call('GET', '/admin/tokens', token)
  assert(listTokRes.status === 200, `list tokens ${listTokRes.status}`)
  console.log(`[smoke] tokens list → ${(listTokRes.body as unknown[]).length} active`)

  const revokeRes = await call('POST', `/admin/tokens/${tokenResp.row.id}/revoke`, token)
  assert(revokeRes.status === 200, `revoke ${revokeRes.status}`)
  const revoked = revokeRes.body as { revoked_at: string | null }
  assert(revoked.revoked_at, 'token not marked revoked')
  console.log('[smoke] token revoked')

  // ── Account-role grants ───────────────────────────────────────────────────
  const editor = roles.find((r) => r.name === 'editor')!
  const grantSub = '00000000-0000-0000-0000-000000000001'
  const grantRes = await call('POST', '/admin/account-roles', token, {
    account_id: grantSub,
    role_id: editor.id,
  })
  assert(grantRes.status === 201, `grant ${grantRes.status}`)
  const listGrantsRes = await call(
    'GET',
    `/admin/account-roles?account_id=${grantSub}`,
    token,
  )
  assert(listGrantsRes.status === 200, `list grants ${listGrantsRes.status}`)
  assert(
    (listGrantsRes.body as Array<{ role: { name: string } }>).some((g) => g.role.name === 'editor'),
    'editor grant missing in list',
  )
  const revokeGrantRes = await call(
    'DELETE',
    `/admin/account-roles/${grantSub}/${editor.id}`,
    token,
  )
  assert(revokeGrantRes.status === 204, `revoke grant ${revokeGrantRes.status}`)
  console.log('[smoke] account-role grant/list/revoke OK')

  // ── Audit log ─────────────────────────────────────────────────────────────
  const auditRes = await call('GET', '/admin/audit?per_page=5', token)
  assert(auditRes.status === 200, `audit ${auditRes.status}`)
  const audit = auditRes.body as { total: number; data: Array<{ action: string }> }
  console.log(`[smoke] audit → total=${audit.total}, recent actions=${audit.data.map((d) => d.action).join(',')}`)
  assert(audit.total > 0, 'audit log has no entries — earlier mutations should have written rows')
  assert(audit.data.some((r) => r.action.startsWith('role.') || r.action.startsWith('token.')), 'recent role/token actions not in audit')

  console.log('[smoke] PASS')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
