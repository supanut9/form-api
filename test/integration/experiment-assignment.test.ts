/**
 * Integration test — A/B experiment variant assignment via render-spec route.
 *
 * Skips automatically when INTEGRATION_TESTS env var is not set.
 *
 * What is tested:
 *
 *   1. Seeds a form with 2 published versions (v1, v2) and a running 50/50
 *      experiment.
 *
 *   2. Fetches GET /public/forms/<slug> 30 times with 30 distinct form_anon
 *      cookies. Asserts ~50/50 split (±20% slack) — both variants are hit.
 *
 *   3. Re-fetches 5 times with the SAME cookie — asserts same variant every
 *      time (stickiness guarantee).
 *
 *   4. Reads form_experiment_exposures and asserts one row per unique cookie.
 */

// ── Skip guard ─────────────────────────────────────────────────────────────────

const RUN = Boolean(process.env.INTEGRATION_TESTS)

// ── Imports ───────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { buildServer } from '../../src/server.js'

// ── Prisma factory ────────────────────────────────────────────────────────────

function buildPrisma(): PrismaClient {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 5,
    idleTimeoutMillis: 10_000,
  })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('experiment-assignment integration', () => {
  let prisma: PrismaClient
  let app: Awaited<ReturnType<typeof buildServer>>
  let formId: string
  let formSlug: string
  let experimentId: string
  let variantAId: string
  let variantBId: string
  let versionAId: string
  let versionBId: string

  // Titles differ between v1 and v2 so we can tell them apart in spec_json
  const TITLE_V1 = 'Experiment Form Version A'
  const TITLE_V2 = 'Experiment Form Version B'
  const FORM_SLUG = `experiment-assignment-integration-${Date.now()}`
  const OWNER = 'integration-seed'

  beforeAll(async () => {
    prisma = buildPrisma()
    await prisma.$connect()

    // ── Seed form definition ─────────────────────────────────────────────────
    const form = await prisma.formDefinition.create({
      data: {
        type: 'dynamic',
        title: TITLE_V1,
        slug: FORM_SLUG,
        currentVersion: 1,
        ownerAccountId: OWNER,
      },
    })
    formId = form.id
    formSlug = FORM_SLUG

    const makeSpec = (title: string, vNum: number) => ({
      id: formId,
      version: vNum,
      title,
      type: 'dynamic',
      access: { mode: 'public_anonymous', require_account: false, anonymous_allowed: true },
      pages: [{ id: 'pg_1', title: `Page 1 ${title}`, fields: [] }],
    })

    // Version 1 (isCurrent = true initially; will be overridden by experiment)
    const specA = makeSpec(TITLE_V1, 1)
    const vA = await prisma.formVersion.create({
      data: {
        formId,
        version: 1,
        specJson: specA,
        schemaHash: crypto.createHash('sha256').update(JSON.stringify(specA)).digest('hex'),
        publishedAt: new Date(),
        publishedBy: OWNER,
        isCurrent: true,
      },
    })
    versionAId = vA.id

    // Version 2
    const specB = makeSpec(TITLE_V2, 2)
    const vB = await prisma.formVersion.create({
      data: {
        formId,
        version: 2,
        specJson: specB,
        schemaHash: crypto.createHash('sha256').update(JSON.stringify(specB)).digest('hex'),
        publishedAt: new Date(),
        publishedBy: OWNER,
        isCurrent: false,
      },
    })
    versionBId = vB.id

    // Update currentVersion on the form to 2 (so it is aware of v2)
    await prisma.formDefinition.update({
      where: { id: formId },
      data: { currentVersion: 2 },
    })

    // ── Seed running experiment with 50/50 split ─────────────────────────────
    const experiment = await prisma.formExperiment.create({
      data: {
        formId,
        name: 'Assignment Integration Test Experiment',
        primaryMetric: 'submit_rate',
        status: 'running',
        startedAt: new Date(),
        variants: {
          create: [
            { label: 'Control (v1)', versionId: versionAId, weightBps: 5000 },
            { label: 'Treatment (v2)', versionId: versionBId, weightBps: 5000 },
          ],
        },
      },
      include: { variants: true },
    })
    experimentId = experiment.id
    variantAId = experiment.variants.find((v) => v.versionId === versionAId)!.id
    variantBId = experiment.variants.find((v) => v.versionId === versionBId)!.id

    // ── Boot Fastify in-process ──────────────────────────────────────────────
    app = await buildServer()
    await app.ready()
  })

  afterAll(async () => {
    // Clean up experiment exposures + experiment + versions + form
    await prisma.formExperimentExposure.deleteMany({ where: { experimentId } })
    await prisma.formExperiment.delete({ where: { id: experimentId } })
    await prisma.formVersion.deleteMany({ where: { formId } })
    await prisma.formDefinition.delete({ where: { id: formId } })

    await app.close()
    await prisma.$disconnect()
  })

  it('30 distinct cookies produce ~50/50 variant split (±20%) and both variants are hit', async () => {
    const variantCounts: Record<string, number> = { [variantAId]: 0, [variantBId]: 0 }

    for (let i = 0; i < 30; i++) {
      const cookie = `form_anon=${randomUUID()}`
      const res = await app.inject({
        method: 'GET',
        url: `/public/forms/${formSlug}`,
        headers: { cookie },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json<{ spec_json: { title?: string } }>()

      // Identify variant by title embedded in specJson
      const title = body.spec_json?.title ?? ''
      if (title === TITLE_V1) variantCounts[variantAId]++
      else if (title === TITLE_V2) variantCounts[variantBId]++
    }

    const countA = variantCounts[variantAId]
    const countB = variantCounts[variantBId]

    // Both variants must have been served at least once
    expect(countA).toBeGreaterThan(0)
    expect(countB).toBeGreaterThan(0)

    // Neither variant should exceed 70% (50% ± 20% slack)
    expect(countA).toBeLessThanOrEqual(21)
    expect(countB).toBeLessThanOrEqual(21)
  }, 30_000)

  it('same cookie always receives the same variant (stickiness)', async () => {
    const stickyToken = randomUUID()
    const cookie = `form_anon=${stickyToken}`

    const titles: string[] = []
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'GET',
        url: `/public/forms/${formSlug}`,
        headers: { cookie },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ spec_json: { title?: string } }>()
      titles.push(body.spec_json?.title ?? '')
    }

    // All 5 fetches must return the same title
    const unique = new Set(titles)
    expect(unique.size).toBe(1)
  }, 15_000)

  it('form_experiment_exposures has exactly one row per distinct anon token from the 30-fetch loop', async () => {
    // There should be 30 exposure rows from the split test plus 1 from the
    // stickiness test — but since stickiness only creates one exposure (upsert),
    // total = 31 distinct tokens.
    const exposures = await prisma.formExperimentExposure.findMany({
      where: { experimentId },
    })

    // At minimum the 30 tokens from the split loop + 1 sticky token
    expect(exposures.length).toBeGreaterThanOrEqual(31)

    // No duplicate (experimentId, anonymousToken) pairs
    const tokenSet = new Set(exposures.map((e) => e.anonymousToken))
    expect(tokenSet.size).toBe(exposures.length)
  })
})
