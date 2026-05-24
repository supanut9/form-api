/**
 * Unit tests for ExperimentService.
 *
 * Prisma is mocked entirely — no live DB required. We use a hand-rolled
 * mock object that mimics the PrismaClient shape needed by ExperimentService.
 */

process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:55438/test'
process.env['FORMS_JWT_SECRET'] = 'test-jwt-secret-must-be-at-least-32-chars!!'

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ExperimentService } = await import(
  '../../../src/core/experiments/experiment.service.js'
)

// ── Test fixtures ─────────────────────────────────────────────────────────────

const FORM_ID = 'form-0000-0000-0000-000000000001'
const EXP_ID = 'exp-00000-0000-0000-0000-000000000001'
const VARIANT_A_ID = 'var-a0000-0000-0000-0000-000000000001'
const VARIANT_B_ID = 'var-b0000-0000-0000-0000-000000000002'
const VERSION_A_ID = 'ver-a0000-0000-0000-0000-000000000001'
const VERSION_B_ID = 'ver-b0000-0000-0000-0000-000000000002'

const makeVariants = () => [
  { id: VARIANT_A_ID, experimentId: EXP_ID, label: 'Control', versionId: VERSION_A_ID, weightBps: 5000, createdAt: new Date(), updatedAt: new Date() },
  { id: VARIANT_B_ID, experimentId: EXP_ID, label: 'Challenger', versionId: VERSION_B_ID, weightBps: 5000, createdAt: new Date(), updatedAt: new Date() },
]

const makeExperiment = (status = 'draft') => ({
  id: EXP_ID,
  formId: FORM_ID,
  name: 'Test Exp',
  hypothesis: null,
  status,
  primaryMetric: 'submit_rate',
  startedAt: null,
  stoppedAt: null,
  winnerVariantId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  variants: makeVariants(),
})

// ── Prisma mock factory ───────────────────────────────────────────────────────

function makePrisma() {
  return {
    formExperiment: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    formExperimentVariant: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    formExperimentExposure: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      groupBy: vi.fn(),
    },
    formVersion: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    formDefinition: {
      update: vi.fn(),
    },
    formSubmission: {
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ExperimentService', () => {
  let prisma: ReturnType<typeof makePrisma>
  let service: InstanceType<typeof ExperimentService>

  beforeEach(() => {
    prisma = makePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new ExperimentService(prisma as any)
  })

  // ── createExperiment ───────────────────────────────────────────────────────

  describe('createExperiment', () => {
    it('creates an experiment in draft status with valid inputs', async () => {
      prisma.formVersion.findMany.mockResolvedValue([
        { id: VERSION_A_ID },
        { id: VERSION_B_ID },
      ])
      const created = makeExperiment('draft')
      prisma.formExperiment.create.mockResolvedValue(created)

      const result = await service.createExperiment({
        formId: FORM_ID,
        name: 'Test Exp',
        primaryMetric: 'submit_rate',
        variants: [
          { label: 'Control', versionId: VERSION_A_ID, weightBps: 5000 },
          { label: 'Challenger', versionId: VERSION_B_ID, weightBps: 5000 },
        ],
      })

      expect(result.status).toBe('draft')
      expect(prisma.formExperiment.create).toHaveBeenCalledOnce()
    })

    it('throws validation_error if fewer than 2 variants', async () => {
      await expect(
        service.createExperiment({
          formId: FORM_ID,
          name: 'Test',
          primaryMetric: 'submit_rate',
          variants: [{ label: 'Only', versionId: VERSION_A_ID, weightBps: 10_000 }],
        }),
      ).rejects.toMatchObject({ code: 'validation_error' })
    })

    it('throws validation_error if weights do not sum to 10000', async () => {
      await expect(
        service.createExperiment({
          formId: FORM_ID,
          name: 'Test',
          primaryMetric: 'submit_rate',
          variants: [
            { label: 'A', versionId: VERSION_A_ID, weightBps: 4000 },
            { label: 'B', versionId: VERSION_B_ID, weightBps: 4000 },
          ],
        }),
      ).rejects.toMatchObject({ code: 'validation_error' })
    })

    it('throws validation_error if a versionId does not belong to the form', async () => {
      // Only returns one version — the other is from a different form
      prisma.formVersion.findMany.mockResolvedValue([{ id: VERSION_A_ID }])

      await expect(
        service.createExperiment({
          formId: FORM_ID,
          name: 'Test',
          primaryMetric: 'submit_rate',
          variants: [
            { label: 'A', versionId: VERSION_A_ID, weightBps: 5000 },
            { label: 'B', versionId: VERSION_B_ID, weightBps: 5000 },
          ],
        }),
      ).rejects.toMatchObject({ code: 'validation_error' })
    })
  })

  // ── startExperiment ────────────────────────────────────────────────────────

  describe('startExperiment', () => {
    it('happy path: sets status to running and startedAt', async () => {
      prisma.formExperiment.findUnique.mockResolvedValue(makeExperiment('draft'))
      const runningExp = { ...makeExperiment('running'), startedAt: new Date() }
      prisma.formExperiment.update.mockResolvedValue(runningExp)

      const result = await service.startExperiment(EXP_ID)
      expect(result.status).toBe('running')
      expect(result.startedAt).toBeInstanceOf(Date)
      expect(prisma.formExperiment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'running' }),
        }),
      )
    })

    it('throws another_experiment_running when Prisma throws P2002', async () => {
      prisma.formExperiment.findUnique.mockResolvedValue(makeExperiment('draft'))
      const p2002 = new Error('Unique constraint') as Error & { code: string }
      p2002.code = 'P2002'
      prisma.formExperiment.update.mockRejectedValue(p2002)

      await expect(service.startExperiment(EXP_ID)).rejects.toMatchObject({
        code: 'another_experiment_running',
      })
    })

    it('throws not_found when experiment does not exist', async () => {
      prisma.formExperiment.findUnique.mockResolvedValue(null)
      await expect(service.startExperiment(EXP_ID)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  })

  // ── recordExposure ─────────────────────────────────────────────────────────

  describe('recordExposure', () => {
    it('returns existing variantId with isNew=false for known token', async () => {
      prisma.formExperimentExposure.findUnique.mockResolvedValue({
        variantId: VARIANT_A_ID,
      })

      const result = await service.recordExposure({
        experimentId: EXP_ID,
        anonymousToken: 'known-token',
      })

      expect(result.variantId).toBe(VARIANT_A_ID)
      expect(result.isNew).toBe(false)
      expect(prisma.formExperimentVariant.findMany).not.toHaveBeenCalled()
    })

    it('calls assignVariant and upserts for a new token', async () => {
      prisma.formExperimentExposure.findUnique.mockResolvedValue(null)
      prisma.formExperimentVariant.findMany.mockResolvedValue([
        { id: VARIANT_A_ID, weightBps: 5000 },
        { id: VARIANT_B_ID, weightBps: 5000 },
      ])
      prisma.formExperimentExposure.upsert.mockResolvedValue({
        variantId: VARIANT_A_ID,
        createdAt: new Date(),
      })

      const result = await service.recordExposure({
        experimentId: EXP_ID,
        anonymousToken: 'new-token-abc',
      })

      expect(prisma.formExperimentExposure.upsert).toHaveBeenCalledOnce()
      expect(['variant-a', VARIANT_A_ID, VARIANT_B_ID]).toContain(result.variantId)
    })
  })

  // ── stopExperimentWithWinner ───────────────────────────────────────────────

  describe('stopExperimentWithWinner', () => {
    it('sets status=stopped, winnerVariantId, and promotes winning version to current', async () => {
      const txFn = vi.fn().mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        // The tx mock delegates to the same prisma mock
        return fn(prisma)
      })
      prisma.$transaction = txFn

      const stoppedExp = { ...makeExperiment('stopped'), winnerVariantId: VARIANT_A_ID, stoppedAt: new Date() }

      prisma.formExperiment.findUnique.mockResolvedValue(makeExperiment('running'))
      prisma.formExperiment.update.mockResolvedValue(stoppedExp)
      prisma.formVersion.updateMany.mockResolvedValue({ count: 1 })
      prisma.formVersion.update.mockResolvedValue({})
      prisma.formVersion.findUnique.mockResolvedValue({ version: 2 })
      prisma.formDefinition.update.mockResolvedValue({})

      const result = await service.stopExperimentWithWinner(EXP_ID, VARIANT_A_ID)

      expect(result.status).toBe('stopped')
      expect(result.winnerVariantId).toBe(VARIANT_A_ID)

      // Must flip isCurrent on the old version and set it on the winner's version
      expect(prisma.formVersion.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { isCurrent: false },
        }),
      )
      expect(prisma.formVersion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: VERSION_A_ID },
          data: { isCurrent: true },
        }),
      )
      // Must also bump form.currentVersion
      expect(prisma.formDefinition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { currentVersion: 2 },
        }),
      )
    })

    it('throws not_found if winner variantId does not belong to experiment', async () => {
      const txFn = vi.fn().mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma))
      prisma.$transaction = txFn
      prisma.formExperiment.findUnique.mockResolvedValue(makeExperiment('running'))

      await expect(
        service.stopExperimentWithWinner(EXP_ID, 'non-existent-variant-id'),
      ).rejects.toMatchObject({ code: 'not_found' })

      // form.currentVersion must NOT have been changed
      expect(prisma.formDefinition.update).not.toHaveBeenCalled()
    })
  })

  // ── cancelExperiment ───────────────────────────────────────────────────────

  describe('cancelExperiment', () => {
    it('sets status=stopped and stoppedAt without changing currentVersion', async () => {
      const cancelledExp = { ...makeExperiment('stopped'), stoppedAt: new Date() }
      prisma.formExperiment.findUnique.mockResolvedValue(makeExperiment('running'))
      prisma.formExperiment.update.mockResolvedValue(cancelledExp)

      const result = await service.cancelExperiment(EXP_ID)

      expect(result.status).toBe('stopped')
      expect(result.winnerVariantId).toBeNull()

      // Must NOT touch form_versions or form_definitions
      expect(prisma.formVersion.update).not.toHaveBeenCalled()
      expect(prisma.formVersion.updateMany).not.toHaveBeenCalled()
      expect(prisma.formDefinition.update).not.toHaveBeenCalled()
    })

    it('throws not_found for a non-existent experiment', async () => {
      prisma.formExperiment.findUnique.mockResolvedValue(null)
      await expect(service.cancelExperiment('bad-id')).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  })
})
