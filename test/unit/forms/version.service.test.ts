/**
 * Unit tests for version.service.ts and the admin versions REST plugin.
 *
 * Uses an in-memory mock Prisma client. Covers:
 *  - publishVersion: first version gets version=1, isCurrent=true
 *  - publishVersion: second version flips first to isCurrent=false
 *  - listVersions: returns all versions ordered desc
 *  - getVersion: returns specific version by number
 *  - setCurrentVersion: rolls back to older version
 *  - setCurrentVersion: 404 on unknown version number
 *  - computeSchemaHash: returns deterministic 64-char hex
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { versionsAdminRoutes } from '../../../src/routes/admin/versions.js'
import { VersionService } from '../../../src/core/forms/version.service.js'
import { buildSuperAdminAbility } from '../../../src/core/auth/rbac.js'

// ── Spec fixtures ─────────────────────────────────────────────────────────────

function makeSpec(title = 'Test Form') {
  return {
    id: 'frm_test',
    version: 1,
    title,
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
}

// ── In-memory mock Prisma ─────────────────────────────────────────────────────

function buildMockPrisma(initialCurrentVersion = 0) {
  const forms: Record<string, any> = {
    form_1: {
      id: 'form_1',
      title: 'Test Form',
      slug: 'test-form',
      type: 'dynamic',
      ownerAccountId: 'owner_1',
      currentVersion: initialCurrentVersion,
      createdAt: new Date(),
      archivedAt: null,
    },
  }
  const versions: Record<string, any> = {}
  let versionSeq = 0

  const formDefinition = {
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
    findUniqueOrThrow: async ({ where, select: _s }: any) => {
      const f = forms[where.id]
      if (!f) throw new Error(`FormDefinition ${where.id} not found`)
      return f
    },
    update: async ({ where, data }: any) => {
      if (!forms[where.id]) throw new Error(`not found`)
      forms[where.id] = { ...forms[where.id], ...data }
      return forms[where.id]
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
    update: async ({ where, data }: any) => {
      const v = versions[where.id]
      if (!v) throw new Error(`FormVersion ${where.id} not found`)
      Object.assign(v, data)
      return v
    },
    updateMany: async ({ where, data }: any) => {
      for (const v of Object.values(versions) as any[]) {
        if (v.formId === where.formId && (!where.isCurrent || v.isCurrent === where.isCurrent)) {
          Object.assign(v, data)
        }
      }
    },
  }

  const $transaction = async (fn: (tx: any) => Promise<any>) =>
    fn({ formDefinition, formVersion })

  return { formDefinition, formVersion, $transaction, _forms: forms, _versions: versions }
}

// ── Build test app ────────────────────────────────────────────────────────────

const fakeAccount = {
  sub: 'actor_1',
  email: 'actor@test.com',
  name: 'Actor',
  roles: ['super-admin'],
  abilities: buildSuperAdminAbility(),
}

async function buildTestApp(prisma: ReturnType<typeof buildMockPrisma>) {
  const app = Fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.decorate('prisma', prisma)
  app.decorate('authenticate', async (req: any) => {
    req.session = { sub: fakeAccount.sub, roles: fakeAccount.roles, sid: 'test-session', iat: 0 }
  })
  await app.register(versionsAdminRoutes, )
  return app
}

// ── VersionService unit tests ─────────────────────────────────────────────────

describe('VersionService', () => {
  it('publishes first version with version=1 and isCurrent=true', async () => {
    const prisma = buildMockPrisma(0)
    const service = new VersionService(prisma as any)
    const v = await service.publishVersion({
      formId: 'form_1',
      spec: makeSpec(),
      publishedBy: 'actor_1',
    })
    expect(v.version).toBe(1)
    expect(v.isCurrent).toBe(true)
    expect(v.schemaHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('publishing second version flips first to isCurrent=false', async () => {
    const prisma = buildMockPrisma(0)
    const service = new VersionService(prisma as any)

    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V1'), publishedBy: 'a' })
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V2'), publishedBy: 'a' })

    const versions = await service.listVersions('form_1')
    const v1 = versions.find((v) => v.version === 1)
    const v2 = versions.find((v) => v.version === 2)
    expect(v2?.isCurrent).toBe(true)
    expect(v1?.isCurrent).toBe(false)
  })

  it('listVersions returns versions ordered descending', async () => {
    const prisma = buildMockPrisma(0)
    const service = new VersionService(prisma as any)
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V1'), publishedBy: 'a' })
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V2'), publishedBy: 'a' })
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V3'), publishedBy: 'a' })

    const versions = await service.listVersions('form_1')
    expect(versions[0]?.version).toBe(3)
    expect(versions[2]?.version).toBe(1)
  })

  it('getVersion returns the specific version', async () => {
    const prisma = buildMockPrisma(0)
    const service = new VersionService(prisma as any)
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V1'), publishedBy: 'a' })
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V2'), publishedBy: 'a' })

    const v1 = await service.getVersion('form_1', 1)
    expect(v1?.version).toBe(1)
    expect((v1?.specJson as any)?.title).toBe('V1')
  })

  it('setCurrentVersion switches the active version', async () => {
    const prisma = buildMockPrisma(0)
    const service = new VersionService(prisma as any)
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V1'), publishedBy: 'a' })
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V2'), publishedBy: 'a' })

    // Now roll back to v1
    const result = await service.setCurrentVersion('form_1', 1, 'actor_1')
    expect(result.version).toBe(1)
    expect(result.isCurrent).toBe(true)

    const versions = await service.listVersions('form_1')
    expect(versions.find((v) => v.version === 2)?.isCurrent).toBe(false)
  })

  it('setCurrentVersion throws for unknown version number', async () => {
    const prisma = buildMockPrisma(0)
    const service = new VersionService(prisma as any)
    await expect(
      service.setCurrentVersion('form_1', 99, 'actor_1'),
    ).rejects.toThrow('version_not_found')
  })

  it('computeSchemaHash returns 64-char hex string', () => {
    const prisma = buildMockPrisma(0)
    const service = new VersionService(prisma as any)
    const hash = service.computeSchemaHash(makeSpec() as any)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('computeSchemaHash is deterministic for the same spec', () => {
    const prisma = buildMockPrisma(0)
    const service = new VersionService(prisma as any)
    const spec = makeSpec()
    expect(service.computeSchemaHash(spec as any)).toBe(service.computeSchemaHash(spec as any))
  })

  it('computeSchemaHash differs for different specs', () => {
    const prisma = buildMockPrisma(0)
    const service = new VersionService(prisma as any)
    const h1 = service.computeSchemaHash(makeSpec('Title A') as any)
    const h2 = service.computeSchemaHash(makeSpec('Title B') as any)
    expect(h1).not.toBe(h2)
  })
})

// ── REST route integration ────────────────────────────────────────────────────

describe('Version admin routes', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>
  let prisma: ReturnType<typeof buildMockPrisma>

  beforeEach(async () => {
    prisma = buildMockPrisma(0)
    app = await buildTestApp(prisma)
  })

  it('POST /versions returns 201 with new version', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/forms/form_1/versions',
      payload: { spec_json: makeSpec() },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().version).toBe(1)
    expect(res.json().isCurrent).toBe(true)
  })

  it('GET /versions returns list of versions', async () => {
    // Publish two versions via the service directly
    const service = new VersionService(prisma as any)
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V1'), publishedBy: 'a' })
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V2'), publishedBy: 'a' })

    const res = await app.inject({ method: 'GET', url: '/admin/forms/form_1/versions' })
    expect(res.statusCode).toBe(200)
    const versions = res.json() as any[]
    expect(versions).toHaveLength(2)
    expect(versions[0]?.version).toBe(2) // descending order
  })

  it('GET /versions/:version returns specific version', async () => {
    const service = new VersionService(prisma as any)
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V1'), publishedBy: 'a' })

    const res = await app.inject({ method: 'GET', url: '/admin/forms/form_1/versions/1' })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toBe(1)
  })

  it('GET /versions/:version returns 404 for missing version', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/forms/form_1/versions/99' })
    expect(res.statusCode).toBe(404)
  })

  it('POST /versions/:version/set-current rolls back to older version', async () => {
    const service = new VersionService(prisma as any)
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V1'), publishedBy: 'a' })
    await service.publishVersion({ formId: 'form_1', spec: makeSpec('V2'), publishedBy: 'a' })

    const res = await app.inject({
      method: 'POST',
      url: '/admin/forms/form_1/versions/1/set-current',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().isCurrent).toBe(true)
    expect(res.json().version).toBe(1)
  })

  it('POST /versions/:version/set-current returns 404 for unknown version', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/forms/form_1/versions/99/set-current',
    })
    expect(res.statusCode).toBe(404)
  })
})
