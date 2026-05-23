/**
 * Unit tests for TemplateService.
 *
 * Uses an in-memory mock Prisma client — no real database required.
 * Mirrors the mock-Prisma pattern from test/unit/forms/form.service.test.ts.
 *
 * Covers:
 *   - createTemplate validates spec before persisting
 *   - cloneTemplateIntoForm creates form + version + use row in one transaction
 *   - deleteTemplate blocks when uses exist
 *   - updateTemplate blocks specJson mutation after first use
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { TemplateService } from '../../../src/core/templates/template.service.js'
import { FormSpecValidationError } from '../../../src/core/forms/spec.validator.js'

// ── Minimal valid spec ────────────────────────────────────────────────────────

const minimalSpec = {
  title: 'NPS Survey',
  type: 'dynamic' as const,
  access: { mode: 'public_anonymous' as const },
  pages: [
    {
      id: 'pg_1',
      title: 'Page 1',
      fields: [{ id: 'fld_score', type: 'number' as const, label: 'Score', required: true }],
    },
  ],
}

const invalidSpec = {
  // missing required 'pages' field
  title: 'Bad',
  type: 'dynamic',
  access: { mode: 'public_anonymous' },
}

// ── In-memory mock Prisma ─────────────────────────────────────────────────────

function buildMockPrisma() {
  const templates: Record<string, any> = {}
  const forms: Record<string, any> = {}
  const versions: Record<string, any> = {}
  const templateUses: Array<{ templateId: string; formId: string; usedAt: Date }> = []

  let templateSeq = 0
  let formSeq = 0
  let versionSeq = 0

  const formTemplate = {
    create: async ({ data }: any) => {
      const id = `tmpl_${++templateSeq}`
      const row = { id, ...data, createdAt: new Date() }
      templates[id] = row
      return row
    },
    findMany: async ({ where, orderBy: _o }: any) => {
      let results = Object.values(templates) as any[]
      if (where?.OR) {
        // Simulate OR: workspaceId match OR workspaceId IS NULL
        results = Object.values(templates).filter((t: any) => {
          return where.OR.some((cond: any) => {
            // null means "IS NULL" — treat null and undefined as equivalent in mock
            if ('workspaceId' in cond && cond.workspaceId === null) return t.workspaceId == null
            if ('workspaceId' in cond) return t.workspaceId === cond.workspaceId
            return false
          })
        })
      } else if (where?.workspaceId === null) {
        // "IS NULL" — treat null and undefined as equivalent in mock
        results = results.filter((t) => t.workspaceId == null)
      } else if (where?.workspaceId !== undefined) {
        results = results.filter((t) => t.workspaceId === where.workspaceId)
      }
      if (where?.category) results = results.filter((t) => t.category === where.category)
      return results
    },
    findUnique: async ({ where }: any) => {
      if (where.id) return templates[where.id] ?? null
      if (where.slug) return Object.values(templates).find((t: any) => t.slug === where.slug) ?? null
      return null
    },
    update: async ({ where, data }: any) => {
      if (!templates[where.id]) throw new Error(`FormTemplate ${where.id} not found`)
      templates[where.id] = { ...templates[where.id], ...data }
      return templates[where.id]
    },
    delete: async ({ where }: any) => {
      if (!templates[where.id]) throw new Error(`FormTemplate ${where.id} not found`)
      const row = templates[where.id]
      delete templates[where.id]
      return row
    },
  }

  const formTemplateUse = {
    count: async ({ where }: any) => {
      return templateUses.filter((u) => u.templateId === where.templateId).length
    },
    create: async ({ data }: any) => {
      const row = { ...data, usedAt: new Date() }
      templateUses.push(row)
      return row
    },
  }

  const formDefinition = {
    create: async ({ data }: any) => {
      const id = `form_${++formSeq}`
      const row = { id, ...data, createdAt: new Date(), archivedAt: null }
      forms[id] = row
      return row
    },
    update: async ({ where, data }: any) => {
      if (!forms[where.id]) throw new Error(`FormDefinition ${where.id} not found`)
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
  }

  // $transaction executes the callback with a tx that exposes all mock models.
  const $transaction = async (fn: (tx: any) => Promise<any>) =>
    fn({ formDefinition, formVersion, formTemplateUse, formTemplate })

  return {
    formTemplate,
    formTemplateUse,
    formDefinition,
    formVersion,
    $transaction,
    // expose internals for assertions
    _state: { templates, forms, versions, templateUses },
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildService() {
  const mockPrisma = buildMockPrisma()
  const svc = new TemplateService(mockPrisma as any)
  return { svc, state: mockPrisma._state }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TemplateService', () => {
  // ── createTemplate validates spec ─────────────────────────────────────────

  describe('createTemplate', () => {
    it('persists a template when spec is valid', async () => {
      const { svc, state } = buildService()

      const tmpl = await svc.createTemplate({
        slug: 'nps-survey',
        title: 'NPS Survey',
        category: 'nps',
        specJson: minimalSpec,
      })

      expect(tmpl.id).toBeDefined()
      expect(tmpl.slug).toBe('nps-survey')
      expect(Object.keys(state.templates)).toHaveLength(1)
    })

    it('throws FormSpecValidationError when spec is invalid', async () => {
      const { svc } = buildService()

      await expect(
        svc.createTemplate({
          slug: 'bad-spec',
          title: 'Bad',
          category: 'other',
          specJson: invalidSpec,
        }),
      ).rejects.toBeInstanceOf(FormSpecValidationError)
    })

    it('does NOT persist the template when spec is invalid', async () => {
      const { svc, state } = buildService()

      await svc.createTemplate({
        slug: 'valid-first',
        title: 'Valid',
        category: 'survey',
        specJson: minimalSpec,
      }).catch(() => {})

      try {
        await svc.createTemplate({
          slug: 'bad-spec',
          title: 'Bad',
          category: 'other',
          specJson: invalidSpec,
        })
      } catch {
        // expected
      }

      // Only the valid template should be in state
      expect(Object.keys(state.templates)).toHaveLength(1)
    })
  })

  // ── cloneTemplateIntoForm ─────────────────────────────────────────────────

  describe('cloneTemplateIntoForm', () => {
    it('creates form + version + use row in one transaction', async () => {
      const { svc, state } = buildService()

      const tmpl = await svc.createTemplate({
        slug: 'contact-form',
        title: 'Contact',
        category: 'lead',
        specJson: minimalSpec,
      })

      const result = await svc.cloneTemplateIntoForm(tmpl.id, {
        ownerAccountId: 'account_abc',
        newSlug: 'my-contact-form',
        newTitle: 'My Contact Form',
      })

      // Returns id + slug of the new form.
      expect(result.id).toBeDefined()
      expect(result.slug).toBe('my-contact-form')

      // FormDefinition was created with currentVersion = 1 (after update).
      const form = state.forms[result.id]
      expect(form).toBeDefined()
      expect(form.currentVersion).toBe(1)
      expect(form.ownerAccountId).toBe('account_abc')

      // FormVersion was created with version = 1, isCurrent = true.
      const versionRows = Object.values(state.versions) as any[]
      expect(versionRows).toHaveLength(1)
      expect(versionRows[0].version).toBe(1)
      expect(versionRows[0].isCurrent).toBe(true)
      expect(versionRows[0].formId).toBe(result.id)
      expect(versionRows[0].publishedBy).toBe('account_abc')

      // FormTemplateUse row was created.
      expect(state.templateUses).toHaveLength(1)
      expect(state.templateUses[0].templateId).toBe(tmpl.id)
      expect(state.templateUses[0].formId).toBe(result.id)
    })

    it('re-stamps id and version in the cloned specJson', async () => {
      const { svc, state } = buildService()

      const tmpl = await svc.createTemplate({
        slug: 'rsvp',
        title: 'RSVP',
        category: 'rsvp',
        specJson: { ...minimalSpec, id: 'old-id', version: 99 },
      })

      const result = await svc.cloneTemplateIntoForm(tmpl.id, {
        ownerAccountId: 'account_xyz',
      })

      const versionRows = Object.values(state.versions) as any[]
      const spec = versionRows[0].specJson as any
      expect(spec.id).toBe(result.id)
      expect(spec.version).toBe(1)
    })

    it('throws template_not_found when template id does not exist', async () => {
      const { svc } = buildService()

      await expect(
        svc.cloneTemplateIntoForm('nonexistent-uuid', { ownerAccountId: 'account_1' }),
      ).rejects.toMatchObject({ code: 'template_not_found' })
    })

    it('uses template title when newTitle is omitted', async () => {
      const { svc, state } = buildService()

      const tmpl = await svc.createTemplate({
        slug: 'feedback',
        title: 'Feedback Form',
        category: 'feedback',
        specJson: minimalSpec,
      })

      const result = await svc.cloneTemplateIntoForm(tmpl.id, { ownerAccountId: 'account_1' })

      expect(state.forms[result.id].title).toBe('Feedback Form')
    })
  })

  // ── deleteTemplate blocks when uses exist ─────────────────────────────────

  describe('deleteTemplate', () => {
    it('deletes a template when no uses exist', async () => {
      const { svc, state } = buildService()

      const tmpl = await svc.createTemplate({
        slug: 'unused-template',
        title: 'Unused',
        category: 'survey',
        specJson: minimalSpec,
      })

      await svc.deleteTemplate(tmpl.id)
      expect(state.templates[tmpl.id]).toBeUndefined()
    })

    it('throws template_has_uses when uses exist', async () => {
      const { svc } = buildService()

      const tmpl = await svc.createTemplate({
        slug: 'used-template',
        title: 'Used',
        category: 'nps',
        specJson: minimalSpec,
      })

      await svc.cloneTemplateIntoForm(tmpl.id, { ownerAccountId: 'account_1' })

      await expect(svc.deleteTemplate(tmpl.id)).rejects.toMatchObject({
        code: 'template_has_uses',
      })
    })
  })

  // ── updateTemplate blocks specJson changes after first use ────────────────

  describe('updateTemplate', () => {
    it('allows patching non-spec fields after a clone', async () => {
      const { svc } = buildService()

      const tmpl = await svc.createTemplate({
        slug: 'patchable',
        title: 'Original Title',
        category: 'survey',
        specJson: minimalSpec,
      })

      await svc.cloneTemplateIntoForm(tmpl.id, { ownerAccountId: 'account_1' })

      // Should NOT throw — only title is being patched, not specJson.
      const updated = await svc.updateTemplate(tmpl.id, { title: 'Patched Title' })
      expect(updated.title).toBe('Patched Title')
    })

    it('throws spec_immutable_after_use when specJson is in the patch and uses > 0', async () => {
      const { svc } = buildService()

      const tmpl = await svc.createTemplate({
        slug: 'immutable-spec',
        title: 'Original',
        category: 'lead',
        specJson: minimalSpec,
      })

      await svc.cloneTemplateIntoForm(tmpl.id, { ownerAccountId: 'account_2' })

      await expect(
        svc.updateTemplate(tmpl.id, { specJson: minimalSpec }),
      ).rejects.toMatchObject({ code: 'spec_immutable_after_use' })
    })

    it('allows specJson update before any clone', async () => {
      const { svc } = buildService()

      const tmpl = await svc.createTemplate({
        slug: 'no-uses-yet',
        title: 'Original',
        category: 'feedback',
        specJson: minimalSpec,
      })

      // No clones yet — specJson update should succeed.
      await expect(
        svc.updateTemplate(tmpl.id, { specJson: minimalSpec }),
      ).resolves.toBeDefined()
    })

    it('throws FormSpecValidationError when the replacement specJson is invalid', async () => {
      const { svc } = buildService()

      const tmpl = await svc.createTemplate({
        slug: 'spec-validate-on-update',
        title: 'Test',
        category: 'survey',
        specJson: minimalSpec,
      })

      await expect(
        svc.updateTemplate(tmpl.id, { specJson: invalidSpec }),
      ).rejects.toBeInstanceOf(FormSpecValidationError)
    })
  })

  // ── listTemplates ─────────────────────────────────────────────────────────

  describe('listTemplates', () => {
    it('returns all public templates when no workspaceId is given', async () => {
      const { svc } = buildService()

      await svc.createTemplate({ slug: 't1', title: 'T1', category: 'nps', specJson: minimalSpec })
      await svc.createTemplate({ slug: 't2', title: 'T2', category: 'lead', specJson: minimalSpec })

      const results = await svc.listTemplates({})
      expect(results.length).toBeGreaterThanOrEqual(2)
    })

    it('filters by category', async () => {
      const { svc } = buildService()

      await svc.createTemplate({ slug: 'nps1', title: 'NPS', category: 'nps', specJson: minimalSpec })
      await svc.createTemplate({ slug: 'lead1', title: 'Lead', category: 'lead', specJson: minimalSpec })

      const results = await svc.listTemplates({ category: 'nps' })
      expect(results.every((t) => t.category === 'nps')).toBe(true)
    })
  })

  // ── getTemplate ───────────────────────────────────────────────────────────

  describe('getTemplate', () => {
    it('retrieves by id', async () => {
      const { svc } = buildService()

      const tmpl = await svc.createTemplate({
        slug: 'get-by-id',
        title: 'Test',
        category: 'survey',
        specJson: minimalSpec,
      })

      const found = await svc.getTemplate(tmpl.id)
      expect(found?.id).toBe(tmpl.id)
    })

    it('retrieves by slug', async () => {
      const { svc } = buildService()

      await svc.createTemplate({
        slug: 'get-by-slug',
        title: 'Test',
        category: 'survey',
        specJson: minimalSpec,
      })

      const found = await svc.getTemplate('get-by-slug')
      expect(found?.slug).toBe('get-by-slug')
    })

    it('returns null for unknown id/slug', async () => {
      const { svc } = buildService()
      const found = await svc.getTemplate('nonexistent')
      expect(found).toBeNull()
    })
  })
})
