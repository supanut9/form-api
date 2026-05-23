import { createHash } from 'node:crypto'
import type { PrismaClient, FormVersion } from '@prisma/client'
import { canonicalJson, type FormSpec } from './types.js'
import { validateSpec, deepValidateSpec } from './spec.validator.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PublishVersionInput {
  formId: string
  spec: unknown
  publishedBy: string
}

// ── Service ───────────────────────────────────────────────────────────────────

export class VersionService {
  constructor(private readonly prisma: PrismaClient) {}

  async publishVersion(input: PublishVersionInput): Promise<FormVersion> {
    // Validate spec structurally + semantically + rule shape. Both validators
    // throw FormSpecValidationError on failure (see spec.validator.ts); we let
    // the throw propagate to the route handler which maps it to a 400.
    await validateSpec(input.spec)
    const validSpec: FormSpec = await deepValidateSpec(input.spec)

    const schemaHash = createHash('sha256')
      .update(canonicalJson(validSpec))
      .digest('hex')

    // All mutations in a single transaction:
    //   1. Read current form to get next version number.
    //   2. Flip all existing isCurrent=true versions to false.
    //   3. Insert new FormVersion with isCurrent=true.
    //   4. Update FormDefinition.currentVersion.
    //
    // Lane 4 Prisma column names assumed for form_versions:
    //   id, formId, version, specJson, schemaHash, publishedAt, publishedBy, isCurrent
    return this.prisma.$transaction(async (tx) => {
      const form = await tx.formDefinition.findUniqueOrThrow({
        where: { id: input.formId },
        select: { currentVersion: true },
      })

      const nextVersion = form.currentVersion + 1

      // Mark all prior versions no longer current.
      await tx.formVersion.updateMany({
        where: { formId: input.formId, isCurrent: true },
        data: { isCurrent: false },
      })

      // Insert new version.
      const newVersion = await tx.formVersion.create({
        data: {
          formId: input.formId,
          version: nextVersion,
          specJson: validSpec as object,
          schemaHash,
          publishedAt: new Date(),
          publishedBy: input.publishedBy,
          isCurrent: true,
        },
      })

      // Update the form's currentVersion counter.
      await tx.formDefinition.update({
        where: { id: input.formId },
        data: { currentVersion: nextVersion },
      })

      return newVersion
    })
  }

  async listVersions(formId: string): Promise<FormVersion[]> {
    return this.prisma.formVersion.findMany({
      where: { formId },
      orderBy: { version: 'desc' },
    })
  }

  async getVersion(formId: string, version: number): Promise<FormVersion | null> {
    return this.prisma.formVersion.findFirst({
      where: { formId, version },
    })
  }

  async getCurrentVersion(formId: string): Promise<FormVersion | null> {
    return this.prisma.formVersion.findFirst({
      where: { formId, isCurrent: true },
    })
  }

  /**
   * Computes SHA-256 of the canonical JSON representation of a spec.
   * Returns a lowercase hex string.
   */
  computeSchemaHash(spec: FormSpec): string {
    return createHash('sha256').update(canonicalJson(spec)).digest('hex')
  }

  /**
   * Switches the active version to the requested version number.
   * Useful for rolling back to an older version without data loss.
   * Atomic: flips the old current to false, new one to true, updates form counter.
   */
  async setCurrentVersion(
    formId: string,
    version: number,
    _actor: string,
  ): Promise<FormVersion> {
    return this.prisma.$transaction(async (tx) => {
      const targetVersion = await tx.formVersion.findFirst({
        where: { formId, version },
      })

      if (!targetVersion) {
        const err = new Error('version_not_found') as Error & { statusCode: number }
        err.statusCode = 404
        throw err
      }

      // Flip all isCurrent to false, then set the target to true.
      await tx.formVersion.updateMany({
        where: { formId, isCurrent: true },
        data: { isCurrent: false },
      })

      const updated = await tx.formVersion.update({
        where: { id: targetVersion.id },
        data: { isCurrent: true },
      })

      await tx.formDefinition.update({
        where: { id: formId },
        data: { currentVersion: version },
      })

      return updated
    })
  }

  /**
   * Returns a spec ready for a new draft edit, based on the requested version
   * (or the current version when fromVersion is omitted).
   *
   * Drafts are NOT stored as DB rows in Phase 1 — the admin keeps draft state
   * in zustand; only published versions live here.
   */
  async cloneToDraft(formId: string, fromVersion?: number): Promise<FormSpec> {
    const row = fromVersion != null
      ? await this.getVersion(formId, fromVersion)
      : await this.getCurrentVersion(formId)

    if (!row) {
      throw new Error(
        fromVersion != null
          ? `Version ${fromVersion} not found for form ${formId}`
          : `No current version found for form ${formId}`,
      )
    }

    // Strip the id + version so the returned spec reads as a fresh draft.
    const { id: _id, version: _ver, ...rest } = row.specJson as FormSpec & Record<string, unknown>
    return rest as unknown as FormSpec
  }
}
