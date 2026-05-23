import type { PrismaClient, FormDefinition } from '@prisma/client'
import type { FormSummary, FormWithCurrentVersion } from './types.js'

// ── Input types ───────────────────────────────────────────────────────────────

export interface CreateFormInput {
  ownerAccountId: string
  title: string
  slug: string
  type: 'main' | 'dynamic'
}

export interface ListFormsInput {
  q?: string
  status?: 'active' | 'archived'
  limit?: number
  offset?: number
  /** @deprecated use status instead */
  includeArchived?: boolean
  /** @deprecated filter server-side; pass accountId only if ownership scoping is needed */
  accountId?: string
}

// ── Service ───────────────────────────────────────────────────────────────────

export class FormService {
  constructor(private readonly prisma: PrismaClient) {}

  async createForm(input: CreateFormInput): Promise<FormDefinition> {
    return this.prisma.formDefinition.create({
      data: {
        title: input.title,
        slug: input.slug,
        type: input.type,
        ownerAccountId: input.ownerAccountId,
        currentVersion: 0,
      },
    })
  }

  /**
   * Duplicate a form: copy metadata + the current published spec into a new
   * form_definitions row + form_versions row. Slug must be unique, so the
   * caller supplies the new one (or we derive `${slug}-copy`).
   *
   * Returns { duplicateId } — the caller should redirect to it.
   */
  async duplicateForm(input: {
    sourceFormIdOrSlug: string
    actorSub: string
    newSlug?: string
    newTitle?: string
  }): Promise<{ id: string; slug: string | null; sourceVersion: number | null }> {
    const source = await this.getFormWithCurrentVersion(input.sourceFormIdOrSlug)
    if (!source) {
      const err = new Error('Source form not found') as Error & { code?: string }
      err.code = 'source_not_found'
      throw err
    }

    const newSlug = (input.newSlug ?? `${source.slug ?? 'form'}-copy`).trim()
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(newSlug)) {
      const err = new Error('Slug must be lowercase alphanumeric with dashes') as Error & {
        code?: string
      }
      err.code = 'invalid_slug'
      throw err
    }
    const newTitle = input.newTitle?.trim() || `${source.title} (copy)`

    // Use a transaction so a slug collision leaves no orphaned form_definitions.
    return this.prisma.$transaction(async (tx) => {
      let dup: FormDefinition
      try {
        dup = await tx.formDefinition.create({
          data: {
            title: newTitle,
            slug: newSlug,
            type: source.type,
            ownerAccountId: input.actorSub,
            currentVersion: 0,
          },
        })
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          const err = new Error(`Slug "${newSlug}" already used`) as Error & { code?: string }
          err.code = 'slug_taken'
          throw err
        }
        throw e
      }

      let sourceVersion: number | null = null
      if (source.currentVersionRow) {
        const spec = source.currentVersionRow.specJson as object & {
          id?: string
          version?: number
        }
        // Re-stamp id/version in the cloned spec so downstream renderers see
        // the new form. The schema hash stays identical when those two fields
        // are excluded from canonical-json, but we don't recompute here —
        // version.service publishVersion will be the canonical entry point
        // for future republishes.
        const cleanedSpec = { ...spec, id: dup.id, version: 1 }

        const inserted = await tx.formVersion.create({
          data: {
            formId: dup.id,
            version: 1,
            specJson: cleanedSpec as object,
            schemaHash: source.currentVersionRow.schemaHash,
            publishedAt: new Date(),
            publishedBy: input.actorSub,
            isCurrent: true,
          },
        })
        await tx.formDefinition.update({
          where: { id: dup.id },
          data: { currentVersion: inserted.version },
        })
        sourceVersion = source.currentVersionRow.version
      }

      return { id: dup.id, slug: dup.slug, sourceVersion }
    })
  }

  async listForms(input: ListFormsInput): Promise<FormSummary[]> {
    const limit = input.limit ?? 50
    const offset = input.offset ?? 0

    // Determine archive filter
    let archivedFilter: { archivedAt: null } | { archivedAt: { not: null } } | {} = {}
    if (input.status === 'active' || (!input.status && !input.includeArchived)) {
      archivedFilter = { archivedAt: null }
    } else if (input.status === 'archived') {
      archivedFilter = { archivedAt: { not: null } }
    }

    // Text search filter
    const searchFilter = input.q
      ? {
          OR: [
            { title: { contains: input.q, mode: 'insensitive' as const } },
            { slug: { contains: input.q, mode: 'insensitive' as const } },
          ],
        }
      : {}

    // Ownership filter (optional)
    const ownerFilter = input.accountId ? { ownerAccountId: input.accountId } : {}

    return this.prisma.formDefinition.findMany({
      where: {
        ...archivedFilter,
        ...searchFilter,
        ...ownerFilter,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    })
  }

  async getForm(idOrSlug: string): Promise<FormDefinition | null> {
    // Try UUID lookup first, then slug fallback.
    const byId = await this.prisma.formDefinition.findUnique({ where: { id: idOrSlug } })
    if (byId) return byId
    return this.prisma.formDefinition.findUnique({ where: { slug: idOrSlug } })
  }

  async getFormWithCurrentVersion(idOrSlug: string): Promise<FormWithCurrentVersion | null> {
    const include = {
      versions: { where: { isCurrent: true }, take: 1 },
    } as const
    // Try id first; if not found, fall back to slug. Cheaper than a regex
    // discriminator and works with any id shape (UUID in prod, mock ids in tests).
    let form = await this.prisma.formDefinition
      .findUnique({ where: { id: idOrSlug }, include })
      .catch(() => null)

    if (!form) {
      form = await this.prisma.formDefinition.findUnique({
        where: { slug: idOrSlug },
        include,
      })
    }

    if (!form) return null

    const { versions, ...rest } = form as typeof form & {
      versions: NonNullable<FormWithCurrentVersion['currentVersionRow']>[]
    }

    return {
      ...rest,
      currentVersionRow: (versions[0] as FormWithCurrentVersion['currentVersionRow']) ?? null,
    } as FormWithCurrentVersion
  }

  async archiveForm(id: string, _actor: string): Promise<FormDefinition> {
    return this.prisma.formDefinition.update({
      where: { id },
      data: { archivedAt: new Date() },
    })
  }

  async unarchiveForm(id: string, _actor: string): Promise<FormDefinition> {
    return this.prisma.formDefinition.update({
      where: { id },
      data: { archivedAt: null },
    })
  }

  /** @deprecated retained for backwards compatibility in existing tests */
  async restoreForm(id: string): Promise<FormDefinition> {
    return this.unarchiveForm(id, 'system')
  }

  async deleteForm(id: string): Promise<void> {
    await this.prisma.formDefinition.delete({ where: { id } })
  }
}
