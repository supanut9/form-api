/**
 * ExperimentService — A/B experiment lifecycle management.
 *
 * All persistence is Postgres-only (via Prisma). No external dependencies.
 *
 * Domain errors are plain Error objects with a `code` string property so the
 * route layer can map them to appropriate HTTP status codes.
 */

import type { PrismaClient } from '@prisma/client'
import { assignVariant } from './assignment.js'

// ── Domain error helper ───────────────────────────────────────────────────────

function domainError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

// ── Input types ───────────────────────────────────────────────────────────────

export interface CreateVariantInput {
  label: string
  versionId: string
  weightBps: number
}

export interface CreateExperimentInput {
  formId: string
  name: string
  hypothesis?: string
  primaryMetric: 'submit_rate' | 'completion_rate' | 'payment_conversion'
  variants: CreateVariantInput[]
}

export interface RecordExposureInput {
  experimentId: string
  anonymousToken: string
  accountId?: string
}

// ── Service ───────────────────────────────────────────────────────────────────

export class ExperimentService {
  constructor(private readonly prisma: PrismaClient) {}

  // ── listForForm ─────────────────────────────────────────────────────────────

  async listForForm(formId: string) {
    return this.prisma.formExperiment.findMany({
      where: { formId },
      include: { variants: true },
      orderBy: { createdAt: 'desc' },
    })
  }

  // ── getExperiment ───────────────────────────────────────────────────────────

  async getExperiment(id: string) {
    const experiment = await this.prisma.formExperiment.findUnique({
      where: { id },
      include: {
        variants: true,
      },
    })

    if (!experiment) return null

    // Attach 30-day exposure counts per variant
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    const exposureCounts = await this.prisma.formExperimentExposure.groupBy({
      by: ['variantId'],
      where: {
        experimentId: id,
        exposedAt: { gte: thirtyDaysAgo },
      },
      _count: { id: true },
    })

    const countByVariant = new Map(
      exposureCounts.map((row) => [row.variantId, row._count.id]),
    )

    return {
      ...experiment,
      variants: experiment.variants.map((v) => ({
        ...v,
        exposureCount30d: countByVariant.get(v.id) ?? 0,
      })),
    }
  }

  // ── createExperiment ────────────────────────────────────────────────────────

  async createExperiment(input: CreateExperimentInput) {
    const { formId, name, hypothesis, primaryMetric, variants } = input

    // Validation
    if (variants.length < 2) {
      throw domainError('validation_error', 'An experiment must have at least 2 variants')
    }

    const totalWeight = variants.reduce((sum, v) => sum + v.weightBps, 0)
    if (totalWeight !== 10_000) {
      throw domainError(
        'validation_error',
        `Variant weights must sum to 10000 basis points; got ${totalWeight}`,
      )
    }

    for (const v of variants) {
      if (v.weightBps <= 0) {
        throw domainError('validation_error', `All variant weights must be > 0`)
      }
    }

    // Verify all versionIds belong to this formId
    const versionIds = variants.map((v) => v.versionId)
    const versions = await this.prisma.formVersion.findMany({
      where: { id: { in: versionIds }, formId },
      select: { id: true },
    })
    const foundIds = new Set(versions.map((v) => v.id))
    for (const vid of versionIds) {
      if (!foundIds.has(vid)) {
        throw domainError(
          'validation_error',
          `Version ${vid} does not belong to form ${formId}`,
        )
      }
    }

    return this.prisma.formExperiment.create({
      data: {
        formId,
        name,
        hypothesis,
        primaryMetric,
        status: 'draft',
        variants: {
          create: variants.map((v) => ({
            label: v.label,
            versionId: v.versionId,
            weightBps: v.weightBps,
          })),
        },
      },
      include: { variants: true },
    })
  }

  // ── startExperiment ─────────────────────────────────────────────────────────

  async startExperiment(id: string) {
    // Verify exists
    const exp = await this.prisma.formExperiment.findUnique({ where: { id } })
    if (!exp) throw domainError('not_found', 'Experiment not found')

    try {
      return await this.prisma.formExperiment.update({
        where: { id },
        data: { status: 'running', startedAt: new Date() },
        include: { variants: true },
      })
    } catch (err) {
      // P2002 = Prisma unique constraint violation.
      // The partial unique index "form_experiments_one_running_per_form"
      // fires when status='running' and there's already a running experiment
      // for this form_id. We catch it and re-throw as our domain error so the
      // route layer can return 409 Conflict instead of a generic 500.
      if ((err as { code?: string }).code === 'P2002') {
        throw domainError(
          'another_experiment_running',
          'Another experiment for this form is already running. Stop it before starting a new one.',
        )
      }
      throw err
    }
  }

  // ── recordExposure ──────────────────────────────────────────────────────────

  async recordExposure(
    input: RecordExposureInput,
  ): Promise<{ variantId: string; isNew: boolean }> {
    const { experimentId, anonymousToken, accountId } = input

    // Check for an existing exposure first (fast read path)
    const existing = await this.prisma.formExperimentExposure.findUnique({
      where: {
        experimentId_anonymousToken: { experimentId, anonymousToken },
      },
      select: { variantId: true },
    })

    if (existing) {
      return { variantId: existing.variantId, isNew: false }
    }

    // New visitor: load variants and assign deterministically
    const variants = await this.prisma.formExperimentVariant.findMany({
      where: { experimentId },
      select: { id: true, weightBps: true },
      orderBy: { createdAt: 'asc' },
    })

    if (variants.length === 0) {
      throw domainError('experiment_no_variants', 'Experiment has no variants')
    }

    const variantId = assignVariant(experimentId, variants, anonymousToken)

    // Upsert handles the race where two concurrent requests try to insert the
    // same (experimentId, anonymousToken) — the loser's update is a no-op.
    const exposure = await this.prisma.formExperimentExposure.upsert({
      where: {
        experimentId_anonymousToken: { experimentId, anonymousToken },
      },
      create: {
        experimentId,
        variantId,
        anonymousToken,
        accountId: accountId ?? null,
        exposedAt: new Date(),
      },
      update: {},
      select: { variantId: true, createdAt: true },
    })

    // If the upsert found an existing row (race lost), isNew = false
    const isNew = exposure.variantId === variantId
    return { variantId: exposure.variantId, isNew }
  }

  // ── getExposedVariant ───────────────────────────────────────────────────────

  async getExposedVariant(input: {
    experimentId: string
    anonymousToken: string
  }): Promise<{ variantId: string } | null> {
    const row = await this.prisma.formExperimentExposure.findUnique({
      where: {
        experimentId_anonymousToken: {
          experimentId: input.experimentId,
          anonymousToken: input.anonymousToken,
        },
      },
      select: { variantId: true },
    })
    return row ? { variantId: row.variantId } : null
  }

  // ── stopExperimentWithWinner ────────────────────────────────────────────────

  async stopExperimentWithWinner(id: string, winnerVariantId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Load experiment + variant to get the winning versionId
      const exp = await tx.formExperiment.findUnique({
        where: { id },
        include: { variants: true },
      })
      if (!exp) throw domainError('not_found', 'Experiment not found')

      const winner = exp.variants.find((v) => v.id === winnerVariantId)
      if (!winner) {
        throw domainError('not_found', 'Winner variant does not belong to this experiment')
      }

      // Stop the experiment and record the winner
      const stopped = await tx.formExperiment.update({
        where: { id },
        data: {
          status: 'stopped',
          stoppedAt: new Date(),
          winnerVariantId,
        },
        include: { variants: true },
      })

      // Unset all current versions for this form
      await tx.formVersion.updateMany({
        where: { formId: exp.formId, isCurrent: true },
        data: { isCurrent: false },
      })

      // Promote the winner's version to current
      await tx.formVersion.update({
        where: { id: winner.versionId },
        data: { isCurrent: true },
      })

      // Bump the form's currentVersion number to match the winner's version
      const winnerVersion = await tx.formVersion.findUnique({
        where: { id: winner.versionId },
        select: { version: true },
      })
      if (winnerVersion) {
        await tx.formDefinition.update({
          where: { id: exp.formId },
          data: { currentVersion: winnerVersion.version },
        })
      }

      return stopped
    })
  }

  // ── cancelExperiment ────────────────────────────────────────────────────────

  async cancelExperiment(id: string) {
    const exp = await this.prisma.formExperiment.findUnique({ where: { id } })
    if (!exp) throw domainError('not_found', 'Experiment not found')

    return this.prisma.formExperiment.update({
      where: { id },
      data: { status: 'stopped', stoppedAt: new Date() },
      include: { variants: true },
    })
    // Intentionally does NOT change the form's currentVersion — the pre-experiment
    // default spec remains active.
  }

  // ── patchExperiment ─────────────────────────────────────────────────────────

  async patchExperiment(
    id: string,
    patch: {
      name?: string
      hypothesis?: string
      // Weight updates while running: ALLOWED per §10 risk #4.
      // Existing exposures remain bound to whichever weights were active at
      // exposure time (stickiness is enforced by the unique index, not by
      // re-evaluating weights). New visitors after the patch get the new weights.
      variantWeights?: Array<{ id: string; weightBps: number }>
    },
  ) {
    const exp = await this.prisma.formExperiment.findUnique({
      where: { id },
      include: { variants: true },
    })
    if (!exp) throw domainError('not_found', 'Experiment not found')

    if (patch.variantWeights) {
      // Validate sum = 10_000
      const total = patch.variantWeights.reduce((s, v) => s + v.weightBps, 0)
      if (total !== 10_000) {
        throw domainError(
          'validation_error',
          `Variant weights must sum to 10000; got ${total}`,
        )
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.formExperiment.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.hypothesis !== undefined ? { hypothesis: patch.hypothesis } : {}),
        },
        include: { variants: true },
      })

      if (patch.variantWeights) {
        for (const vw of patch.variantWeights) {
          await tx.formExperimentVariant.update({
            where: { id: vw.id },
            data: { weightBps: vw.weightBps },
          })
        }
      }

      return updated
    })
  }

  // ── Running experiment for a form (for render-time resolution) ──────────────

  async getRunningExperimentForForm(formId: string) {
    return this.prisma.formExperiment.findFirst({
      where: { formId, status: 'running' },
      include: { variants: true },
    })
  }
}
