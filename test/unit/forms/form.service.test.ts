/**
 * Unit tests for form.service.ts and the admin forms REST plugin.
 *
 * Uses an in-memory mock Prisma client — no real database required.
 * Covers: create, list (with search/filter), get by id/slug, archive, unarchive, delete.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { formsAdminRoutes } from '../../../src/routes/admin/forms.js'
import { versionsAdminRoutes } from '../../../src/routes/admin/versions.js'
import { requirePermission } from '../../../src/core/auth/rbac.js'
import { buildSuperAdminAbility } from '../../../src/core/auth/rbac.js'

// ── Minimal valid spec ────────────────────────────────────────────────────────

const minimalSpec = {
  id: 'frm_test',
  version: 1,
  title: 'Test Form',
  type: 'dynamic' as const,
  access: { mode: 'public_anonymous' as const, require_account: false, anonymous_allowed: true },
  pages: [
    {
      id: 'pg_1',
      title: 'Page 1',
      fields: [{ id: 'fld_name', type: 'text' as const, label: 'Name', required: true }],
    },
  ],
}

// ── In-memory mock Prisma ─────────────────────────────────────────────────────

function buildMockPrisma() {
  const forms: Record<string, any> = {}
  const versions: Record<string, any> = {}
  let formSeq = 0
  let versionSeq = 0

  const formDefinition = {
    create: async ({ data }: any) => {
      const id = `form_${++formSeq}`
      const row = { id, ...data, createdAt: new Date(), archivedAt: null }
      forms[id] = row
      return row
    },
    findMany: async ({ where, take, skip, orderBy: _o }: any) => {
      let results = Object.values(forms) as any[]
      if (where?.archivedAt === null) results = results.filter((f) => f.archivedAt === null)
      if (where?.archivedAt?.not !== undefined) results = results.filter((f) => f.archivedAt !== null)
      if (where?.ownerAccountId) results = results.filter((f) => f.ownerAccountId === where.ownerAccountId)
      if (where?.OR) {
        // basic text search simulation
        const q = where.OR[0]?.title?.contains?.toLowerCase()
        if (q) results = results.filter((f) => f.title.toLowerCase().includes(q) || f.slug.toLowerCase().includes(q))
      }
      // Pagination
      const offset = skip ?? 0
      const limit = take ?? results.length
      return results.slice(offset, offset + limit)
    },
    findUnique: async ({ where, include }: any) => {
      const f = where.id ? forms[where.id] : Object.values(forms).find((f: any) => f.slug === where.slug)
      if (!f) return null
      if (include?.versions) {
        const rows = Object.values(versions).filter(
          (v: any) =>
            v.formId === f.id &&
            (include.versions.where?.isCurrent == null ||
              v.isCurrent === include.versions.where.isCurrent),
        )
        return { ...f, versions: rows.slice(0, include.versions.take ?? rows.length) }
      }
      return f
    },
    findUniqueOrThrow: async ({ where }: any) => {
      const f = forms[where.id]
      if (!f) throw new Error(`FormDefinition ${where.id} not found`)
      return f
    },
    update: async ({ where, data }: any) => {
      if (!forms[where.id]) throw new Error(`FormDefinition ${where.id} not found`)
      forms[where.id] = { ...forms[where.id], ...data }
      return forms[where.id]
    },
    delete: async ({ where }: any) => {
      if (!forms[where.id]) throw new Error(`FormDefinition ${where.id} not found`)
      const row = forms[where.id]
      delete forms[where.id]
      return row
    },
  }

  const formVersion = {
    create: async ({ data }: any) => {
      const id = `ver_${++versionSeq}`
      const row = { id, ...data, publishedAt: data.publishedAt ?? new Date() }
      versions[id] = row
      return row
    },
    findMany: async ({ where, orderBy: _o }: any) => {
      return (Object.values(versions) as any[])
        .filter((v) => v.formId === where.formId)
        .sort((a, b) => b.version - a.version)
    },
    findFirst: async ({ where }: any) => {
      return (
        (Object.values(versions) as any[]).find((v) => {
          if (where.formId && v.formId !== where.formId) return false
          if (where.version != null && v.version !== where.version) return false
          if (where.isCurrent != null && v.isCurrent !== where.isCurrent) return false
          return true
        }) ?? null
      )
    },
    updateMany: async ({ where, data }: any) => {
      for (const v of Object.values(versions) as any[]) {
        if (v.formId === where.formId && (!where.isCurrent || v.isCurrent === where.isCurrent)) {
          Object.assign(v, data)
        }
      }
    },
    update: async ({ where, data }: any) => {
      const v = versions[where.id]
      if (!v) throw new Error(`FormVersion ${where.id} not found`)
      Object.assign(v, data)
      return v
    },
  }

  const $transaction = async (fn: (tx: any) => Promise<any>) =>
    fn({ formDefinition, formVersion })

  return { formDefinition, formVersion, $transaction }
}

// ── Build test app ────────────────────────────────────────────────────────────

const fakeAccount = {
  sub: 'account_admin_1',
  email: 'admin@test.com',
  name: 'Admin',
  roles: ['super-admin'],
  abilities: buildSuperAdminAbility(),
}

async function buildTestApp() {
  const mockPrisma = buildMockPrisma()
  const app = Fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  app.decorate('prisma', mockPrisma)
  // Stub auth decorators.
  app.decorate('authenticate', async (req: any) => {
    req.session = { sub: fakeAccount.sub, roles: fakeAccount.roles, sid: 'test-session', iat: 0 }
  })
  // requirePermission is the real function — it will use req.account we set above.

  await app.register(formsAdminRoutes, )
  await app.register(versionsAdminRoutes, )

  return app
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FormService via admin REST routes', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeEach(async () => {
    app = await buildTestApp()
  })

  // ── Create ──────────────────────────────────────────────────────────────────

  it('creates a form and returns 201 with id and currentVersion=0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'Language Profile', slug: 'language-profile', type: 'dynamic' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBeDefined()
    expect(body.currentVersion).toBe(0)
  })

  it('creates a form with auto-generated slug when not provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'My Auto Slug Form', type: 'dynamic' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.slug).toMatch(/^[a-z0-9-]+$/)
  })

  it('creates a form and publishes version 1 when spec_json is provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'With Spec', type: 'dynamic', spec_json: minimalSpec },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    // currentVersionRow should be populated
    expect(body.currentVersionRow).toBeDefined()
    expect(body.currentVersionRow.version).toBe(1)
    expect(body.currentVersionRow.isCurrent).toBe(true)
  })

  // ── List ────────────────────────────────────────────────────────────────────

  it('lists forms and returns an array', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'Form A', slug: 'form-a', type: 'dynamic' },
    })
    const res = await app.inject({ method: 'GET', url: '/admin/forms' })
    expect(res.statusCode).toBe(200)
    const list = res.json() as any[]
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list[0]).toHaveProperty('id')
    expect(list[0]).toHaveProperty('slug')
  })

  it('includes only active forms by default', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'Will Archive', slug: 'will-archive', type: 'dynamic' },
    })
    const { id } = create.json()

    // Archive it
    await app.inject({ method: 'POST', url: `/admin/forms/${id}/archive` })

    const list = await app.inject({ method: 'GET', url: '/admin/forms' })
    const forms = list.json() as any[]
    expect(forms.some((f) => f.id === id)).toBe(false)
  })

  it('includes archived forms with ?status=archived', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'Archived Form', slug: 'archived-one', type: 'dynamic' },
    })
    const { id } = create.json()
    await app.inject({ method: 'POST', url: `/admin/forms/${id}/archive` })

    const list = await app.inject({ method: 'GET', url: '/admin/forms?status=archived' })
    const forms = list.json() as any[]
    expect(forms.some((f) => f.id === id)).toBe(true)
  })

  // ── Get by id / slug ────────────────────────────────────────────────────────

  it('retrieves a form by id with current version', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'Get By Id', slug: 'get-by-id', type: 'dynamic' },
    })
    const { id } = create.json()

    const res = await app.inject({ method: 'GET', url: `/admin/forms/${id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(id)
    expect(body).toHaveProperty('currentVersionRow')
  })

  it('retrieves a form by slug', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'Slug Lookup', slug: 'slug-lookup', type: 'dynamic' },
    })

    const res = await app.inject({ method: 'GET', url: '/admin/forms/slug-lookup' })
    expect(res.statusCode).toBe(200)
    expect(res.json().slug).toBe('slug-lookup')
  })

  it('returns 404 for unknown id/slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/forms/nonexistent-slug-xyz' })
    expect(res.statusCode).toBe(404)
  })

  // ── Archive / Unarchive ─────────────────────────────────────────────────────

  it('archives a form via POST /archive', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'To Archive', slug: 'to-archive', type: 'dynamic' },
    })
    const { id } = create.json()

    const res = await app.inject({ method: 'POST', url: `/admin/forms/${id}/archive` })
    expect(res.statusCode).toBe(200)
    expect(res.json().archivedAt).not.toBeNull()
  })

  it('unarchives a form via POST /unarchive', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'To Unarchive', slug: 'to-unarchive', type: 'dynamic' },
    })
    const { id } = create.json()

    await app.inject({ method: 'POST', url: `/admin/forms/${id}/archive` })
    const res = await app.inject({ method: 'POST', url: `/admin/forms/${id}/unarchive` })
    expect(res.statusCode).toBe(200)
    expect(res.json().archivedAt).toBeNull()
  })

  // ── PUT (metadata update) ──────────────────────────────────────────────────

  it('updates title via PUT', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'Old Title', slug: 'old-title', type: 'dynamic' },
    })
    const { id } = create.json()

    const res = await app.inject({
      method: 'PUT',
      url: `/admin/forms/${id}`,
      payload: { title: 'New Title' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().title).toBe('New Title')
  })

  // ── Hard delete (super-admin) ───────────────────────────────────────────────

  it('hard deletes a form via DELETE returning 204', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/admin/forms',
      payload: { title: 'Delete Me', slug: 'delete-me', type: 'dynamic' },
    })
    const { id } = create.json()

    const res = await app.inject({ method: 'DELETE', url: `/admin/forms/${id}` })
    expect(res.statusCode).toBe(204)

    // Should 404 afterward
    const get = await app.inject({ method: 'GET', url: `/admin/forms/${id}` })
    expect(get.statusCode).toBe(404)
  })
})
