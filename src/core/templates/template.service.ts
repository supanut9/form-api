/**
 * TemplateService — Phase 3A
 *
 * Owns CRUD for form_templates and the cloneTemplateIntoForm transaction
 * that materialises a template into a live FormDefinition + FormVersion.
 */

import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { PrismaClient } from '@prisma/client'
import { validateSpec } from '../forms/spec.validator.js'
import { canonicalJson } from '../forms/types.js'

// ── Input / output types ──────────────────────────────────────────────────────

export interface ListTemplatesInput {
  category?: string
  workspaceId?: string | null
  includePublic?: boolean
}

export interface CreateTemplateInput {
  slug: string
  title: string
  description?: string
  category: string
  specJson: unknown
  featuredOrder?: number
  createdBy?: string
  workspaceId?: string
}

export type UpdateTemplateInput = Partial<
  Omit<CreateTemplateInput, 'specJson'> & { specJson?: unknown }
>

export interface CloneTemplateInput {
  newSlug?: string
  newTitle?: string
  ownerAccountId: string
}

export interface CloneTemplateResult {
  id: string
  slug: string | null
}

// ── Service ───────────────────────────────────────────────────────────────────

export class TemplateService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * List templates, ordered by featuredOrder ASC NULLS LAST then createdAt DESC.
   *
   * Visibility rules:
   *   - If workspaceId is provided and includePublic is true, return rows where
   *     workspace_id = workspaceId OR workspace_id IS NULL.
   *   - If workspaceId is provided and includePublic is false/unset, return only
   *     workspace-scoped rows (workspace_id = workspaceId).
   *   - If workspaceId is null/undefined, return only public rows (workspace_id IS NULL).
   */
  async listTemplates(input: ListTemplatesInput = {}) {
    const { category, workspaceId, includePublic = true } = input

    // Build workspace filter
    let workspaceFilter: object
    if (workspaceId != null) {
      if (includePublic) {
        workspaceFilter = {
          OR: [{ workspaceId }, { workspaceId: null }],
        }
      } else {
        workspaceFilter = { workspaceId }
      }
    } else {
      workspaceFilter = { workspaceId: null }
    }

    const where = {
      ...workspaceFilter,
      ...(category ? { category } : {}),
    }

    // Prisma does not support NULLS LAST in orderBy natively for all providers,
    // but PostgreSQL via the Prisma 7 adapter supports { sort: 'asc', nulls: 'last' }.
    return this.prisma.formTemplate.findMany({
      where,
      orderBy: [
        { featuredOrder: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
    })
  }

  /**
   * Get a single template by UUID id or slug.
   */
  async getTemplate(idOrSlug: string) {
    // Try UUID lookup first, then slug fallback — mirrors FormService.getForm pattern.
    const byId = await this.prisma.formTemplate
      .findUnique({ where: { id: idOrSlug } })
      .catch(() => null)
    if (byId) return byId
    return this.prisma.formTemplate.findUnique({ where: { slug: idOrSlug } })
  }

  /**
   * Create a new template.
   * Validates specJson against formSpecSchema before persisting so we never
   * store a broken spec in form_templates.
   */
  async createTemplate(input: CreateTemplateInput) {
    // Throws FormSpecValidationError if the spec is invalid.
    await validateSpec(input.specJson)

    const data: Parameters<typeof this.prisma.formTemplate.create>[0]['data'] = {
      slug: input.slug,
      title: input.title,
      category: input.category,
      specJson: input.specJson as object,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.featuredOrder !== undefined ? { featuredOrder: input.featuredOrder } : {}),
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    }

    return this.prisma.formTemplate.create({ data })
  }

  /**
   * Partial update of a template.
   * Refuses to mutate specJson when any form_template_uses rows exist —
   * templates are immutable once they have been cloned.
   */
  async updateTemplate(id: string, patch: UpdateTemplateInput) {
    if (patch.specJson !== undefined) {
      const usesCount = await this.prisma.formTemplateUse.count({
        where: { templateId: id },
      })
      if (usesCount > 0) {
        const err = new Error(
          'Cannot mutate specJson: this template has already been cloned into one or more forms',
        ) as Error & { code: string }
        err.code = 'spec_immutable_after_use'
        throw err
      }
      // Validate the new spec before accepting it.
      await validateSpec(patch.specJson)
    }

    const data: Record<string, unknown> = {}
    if (patch.slug !== undefined) data['slug'] = patch.slug
    if (patch.title !== undefined) data['title'] = patch.title
    if (patch.description !== undefined) data['description'] = patch.description
    if (patch.category !== undefined) data['category'] = patch.category
    if (patch.specJson !== undefined) data['specJson'] = patch.specJson as object
    if (patch.featuredOrder !== undefined) data['featuredOrder'] = patch.featuredOrder
    if (patch.createdBy !== undefined) data['createdBy'] = patch.createdBy
    if (patch.workspaceId !== undefined) data['workspaceId'] = patch.workspaceId

    return this.prisma.formTemplate.update({
      where: { id },
      data,
    })
  }

  /**
   * Hard-delete a template.
   * Refuses when any form_template_uses rows exist to prevent orphaned audit trails.
   */
  async deleteTemplate(id: string): Promise<void> {
    const usesCount = await this.prisma.formTemplateUse.count({
      where: { templateId: id },
    })
    if (usesCount > 0) {
      const err = new Error(
        'Cannot delete template: it has been used to create one or more forms',
      ) as Error & { code: string }
      err.code = 'template_has_uses'
      throw err
    }
    await this.prisma.formTemplate.delete({ where: { id } })
  }

  /**
   * Clone a template into a brand-new FormDefinition + FormVersion.
   *
   * Transaction sequence:
   *   1. Load the template row (outside the transaction to fail fast).
   *   2. Open $transaction:
   *      a. Create FormDefinition with title = newTitle ?? template.title,
   *         slug = newSlug ?? `template-<nanoid(8)>`, type = 'dynamic',
   *         ownerAccountId = ownerAccountId, currentVersion = 0.
   *      b. Clone specJson; stamp id = new form id, version = 1.
   *      c. Compute schemaHash (SHA-256 of canonical JSON).
   *      d. Create FormVersion { version: 1, isCurrent: true, specJson,
   *         schemaHash, publishedAt: now, publishedBy: ownerAccountId }.
   *      e. Update FormDefinition.currentVersion = 1.
   *      f. Insert FormTemplateUse(templateId, formId = new form id).
   *   3. Return { id, slug } of the new form.
   */
  async cloneTemplateIntoForm(
    templateId: string,
    input: CloneTemplateInput,
  ): Promise<CloneTemplateResult> {
    // Load template outside the transaction — fail fast if not found.
    const template = await this.prisma.formTemplate.findUnique({
      where: { id: templateId },
    })
    if (!template) {
      const err = new Error('Template not found') as Error & { code: string }
      err.code = 'template_not_found'
      throw err
    }

    const newSlug = input.newSlug ?? `template-${nanoid(8)}`
    const newTitle = input.newTitle ?? template.title

    return this.prisma.$transaction(async (tx) => {
      // Step a: create FormDefinition.
      let formDef: Awaited<ReturnType<typeof tx.formDefinition.create>>
      try {
        formDef = await tx.formDefinition.create({
          data: {
            title: newTitle,
            slug: newSlug,
            type: 'dynamic',
            ownerAccountId: input.ownerAccountId,
            currentVersion: 0,
          },
        })
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          const err = new Error(`Slug "${newSlug}" is already in use`) as Error & { code: string }
          err.code = 'slug_taken'
          throw err
        }
        throw e
      }

      // Step b: clone specJson and re-stamp id + version.
      const rawSpec = template.specJson as Record<string, unknown>
      const clonedSpec: Record<string, unknown> = { ...rawSpec, id: formDef.id, version: 1 }

      // Step c: compute schemaHash.
      const schemaHash = createHash('sha256')
        .update(canonicalJson(clonedSpec))
        .digest('hex')

      // Step d: create FormVersion.
      const now = new Date()
      await tx.formVersion.create({
        data: {
          formId: formDef.id,
          version: 1,
          specJson: clonedSpec as object,
          schemaHash,
          publishedAt: now,
          publishedBy: input.ownerAccountId,
          isCurrent: true,
        },
      })

      // Step e: update FormDefinition.currentVersion = 1.
      await tx.formDefinition.update({
        where: { id: formDef.id },
        data: { currentVersion: 1 },
      })

      // Step f: record the template use.
      await tx.formTemplateUse.create({
        data: {
          templateId,
          formId: formDef.id,
        },
      })

      return { id: formDef.id, slug: formDef.slug }
    })
  }
}
