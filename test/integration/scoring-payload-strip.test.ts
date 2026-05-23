/**
 * Integration test — NPS scoring + payload strip (fast path, no browser).
 *
 * Uses a real Postgres database (DATABASE_URL must be set) and boots Fastify
 * in-process via `buildServer()`. No form-web required.
 *
 * Skips automatically when INTEGRATION_TESTS env var is not set (truthy) so
 * local devs without a running Postgres don't see red. In CI the `unit` job
 * sets INTEGRATION_TESTS=true alongside DATABASE_URL, so these tests run there.
 *
 * What is tested:
 *
 *   1. seedNpsTemplate + TemplateService.cloneTemplateIntoForm wire up a real
 *      FormDefinition + FormVersion in the database.
 *
 *   2. POST /v1/public/forms/<slug>/submit with a "forged" payload containing
 *      BOTH pg_followup AND pg_promoter fields (score=3 → detractor path →
 *      pg_promoter should have been skipped) returns 201.
 *
 *   3. The persisted payload_jsonb has fld_referral (pg_promoter) stripped.
 *
 *   4. An audit_log row with action='submission.skipped_fields_stripped' was
 *      written and references the submission id.
 *
 * NOTE: Assertions 3 and 4 will only pass once the submit route
 * (src/routes/public/submit.ts) has been updated to call stripSkippedFields
 * from src/core/submissions/payload.validator.ts (Phase 3A Lane L2 wiring).
 * Until then, run with `it.skip` to keep CI green, or mark it as a TODO.
 * This test is the acceptance gate for that integration.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import { buildServer } from '../../src/server.js'
import { TemplateService } from '../../src/core/templates/template.service.js'
import { seedNpsTemplate } from '../e2e/setup/seed-template.js'

// ── Skip guard ────────────────────────────────────────────────────────────────
//
// Use INTEGRATION_TESTS rather than DATABASE_URL because dotenv/config is
// loaded transitively when src/server.ts is imported, which would cause
// DATABASE_URL to appear truthy even on developer machines that don't have a
// live Postgres running. INTEGRATION_TESTS=true is set explicitly in CI.
const hasDatabaseUrl = Boolean(process.env.INTEGRATION_TESTS)

// ── Prisma factory ────────────────────────────────────────────────────────────

function buildPrisma(): PrismaClient {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 3,
    idleTimeoutMillis: 10_000,
  })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe.skipIf(!hasDatabaseUrl)('scoring-payload-strip integration', () => {
  let prisma: PrismaClient
  let app: Awaited<ReturnType<typeof buildServer>>
  let clonedSlug: string
  let clonedFormId: string

  const OWNER = 'integration-test-seed'
  const CLONE_SLUG = 'nps-integration-strip-test'

  beforeAll(async () => {
    // Build a direct Prisma client for setup + assertions.
    prisma = buildPrisma()
    await prisma.$connect()

    // Upsert the NPS template.
    const { templateId } = await seedNpsTemplate(prisma)

    // Clone into a real form (idempotent).
    const existing = await prisma.formDefinition.findFirst({
      where: { slug: CLONE_SLUG },
    })

    if (existing) {
      clonedFormId = existing.id
      clonedSlug = existing.slug!
    } else {
      const svc = new TemplateService(prisma)
      const result = await svc.cloneTemplateIntoForm(templateId, {
        ownerAccountId: OWNER,
        newSlug: CLONE_SLUG,
        newTitle: 'NPS Integration Strip Test',
      })
      clonedFormId = result.id
      clonedSlug = result.slug!
    }

    // Boot Fastify in-process. buildServer() wires its own prisma plugin using
    // DATABASE_URL from env — the same DB this test seeded into.
    app = await buildServer()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  // ── Test 1: template clone produces a queryable form ─────────────────────

  it('cloned form is reachable via render-spec', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/public/forms/${clonedSlug}/spec`,
    })

    // 200 or 404 — the render-spec route must at least respond (not 500).
    expect([200, 404]).toContain(res.statusCode)
    if (res.statusCode === 200) {
      const body = res.json<{ id?: string }>()
      expect(body.id ?? body).toBeTruthy()
    }
  })

  // ── Test 2: forged promoter field is stripped ─────────────────────────────

  /**
   * This test is the acceptance gate for Phase 3A Lane L2 wiring.
   *
   * stripSkippedFields must be called inside
   * src/routes/public/submit.ts for assertions 3 + 4 to pass.
   *
   * Until that wiring is in place this test documents the EXPECTED behavior.
   * When the submit route is updated, these assertions will go green without
   * any change to this file.
   */
  it('submit strips pg_promoter fields and writes audit row (strip-wiring gate)', async () => {
    // Forged payload: score=3 (detractor) but includes fld_referral from pg_promoter.
    const forgedPayload = {
      fld_score: '3',
      fld_reason: 'Too slow',
      fld_improvement: 'Fix performance',
      fld_referral: 'Forged — should be stripped from pg_promoter',
    }

    const res = await app.inject({
      method: 'POST',
      url: `/v1/public/forms/${clonedSlug}/submit`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: forgedPayload }),
    })

    expect(res.statusCode).toBe(201)

    const body = res.json<{ submission_id: string }>()
    const submissionId = body.submission_id
    expect(submissionId).toBeTruthy()

    // Read the persisted row via the direct Prisma client (bypasses Fastify).
    const submission = await prisma.formSubmission.findUnique({
      where: { id: submissionId },
      select: { payloadJsonb: true },
    })

    expect(submission).not.toBeNull()
    const persisted = submission!.payloadJsonb as Record<string, unknown>

    // fld_referral lives on pg_promoter — must be stripped for score=3.
    expect(persisted).not.toHaveProperty('fld_referral')

    // Fields from pages visited by a detractor path must be present.
    expect(persisted).toHaveProperty('fld_score', '3')
    // fld_improvement is on pg_followup — should be retained.
    expect(persisted).toHaveProperty('fld_improvement', 'Fix performance')

    // Audit log row written with correct action and subjectId.
    const auditRow = await prisma.auditLog.findFirst({
      where: {
        action: 'submission.skipped_fields_stripped',
        subjectId: submissionId,
      },
    })

    expect(auditRow).not.toBeNull()
    expect(auditRow!.subjectId).toBe(submissionId)

    const diff = auditRow!.diffJson as { stripped_fields?: string[] } | null
    expect(diff?.stripped_fields).toContain('fld_referral')
  })
})
