/**
 * E2E spec — NPS template: branching + scoring + server-side payload strip.
 *
 * Prerequisites (services must already be running before this suite):
 *   form-api  → http://localhost:4200  (npm run dev / node dist/server.js)
 *   form-web  → http://localhost:4202  (npm run dev / npm start)
 *
 * To start form-web locally:
 *   cd ../form-web && npm run dev       # or: npm start (after npm run build)
 *
 * The global-setup.ts wait loop covers both services.
 *
 * Skips automatically when DATABASE_URL is not set (no live DB available).
 *
 * What these tests cover:
 *
 *   Test 1 — Detractor branch (browser flow)
 *     Seeds NPS template → clones into a real FormDefinition + FormVersion →
 *     navigates to /f/<slug> → fills score=3 (detractor) + reason →
 *     asserts the page jump lands on "pg_followup" (not "pg_promoter") →
 *     fills follow-up + submits → thank-you renders.
 *
 *   Test 2 — Server-side payload strip (API flow)
 *     POSTs directly to /v1/public/forms/<slug>/submit with a payload that
 *     includes BOTH pg_followup AND pg_promoter fields (score=3, detractor
 *     path → pg_promoter was NOT visited) → expects 201 → reads the
 *     persisted payload_jsonb via Prisma → asserts fld_referral (pg_promoter)
 *     is absent → asserts an audit_log row with
 *     action='submission.skipped_fields_stripped' referencing the submission id.
 *
 * NOTE: Test 2 relies on the submit route calling stripSkippedFields
 * (payload.validator.ts). If the route has not yet been wired to call
 * stripSkippedFields (Phase 3A Lane L2 task), the strip assertion will fail
 * because the raw fld_referral value will be present in payload_jsonb.
 * That is intentional — this spec is the acceptance gate for that wire-up.
 */

import { test, expect, type APIRequestContext } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import { TemplateService } from '../../src/core/templates/template.service.js'
import { seedNpsTemplate } from './setup/seed-template.js'

// ── Skip guard ────────────────────────────────────────────────────────────────

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)

// ── Prisma factory (reused across both tests) ─────────────────────────────────

function buildPrisma(): PrismaClient {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 3,
    idleTimeoutMillis: 10_000,
  })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}

// ── Shared state seeded once in beforeAll ─────────────────────────────────────

let prisma: PrismaClient
let clonedSlug: string
let clonedFormId: string

const OWNER_ACCOUNT_ID = 'e2e-nps-seed'
const CLONE_SLUG = 'nps-e2e-branching'

test.describe('NPS scoring + branching', () => {
  test.skip(!hasDatabaseUrl, 'Skipping: DATABASE_URL not set')

  test.beforeAll(async () => {
    prisma = buildPrisma()
    await prisma.$connect()

    // Seed the NPS template (idempotent).
    const { templateId } = await seedNpsTemplate(prisma)

    // Clone the template into a real FormDefinition, or reuse if already cloned.
    const existing = await prisma.formDefinition.findFirst({
      where: { slug: CLONE_SLUG },
    })

    if (existing) {
      clonedFormId = existing.id
      clonedSlug = existing.slug!
      console.log(`[scoring-branching] Reusing form: ${clonedFormId} slug: ${clonedSlug}`)
    } else {
      const svc = new TemplateService(prisma)
      const result = await svc.cloneTemplateIntoForm(templateId, {
        ownerAccountId: OWNER_ACCOUNT_ID,
        newSlug: CLONE_SLUG,
        newTitle: 'NPS E2E Branching Test',
      })
      clonedFormId = result.id
      clonedSlug = result.slug!
      console.log(`[scoring-branching] Cloned form: ${clonedFormId} slug: ${clonedSlug}`)
    }
  })

  test.afterAll(async () => {
    await prisma.$disconnect()
  })

  // ── Test 1: Detractor branch via browser ───────────────────────────────────

  test('score=3 routes to pg_followup, not pg_promoter', async ({ page }) => {
    // Navigate to the public form URL (baseURL = http://localhost:4202).
    await page.goto(`/f/${clonedSlug}`)

    // Page 1 "Your Experience" should render.
    await expect(page.getByText('Your Experience')).toBeVisible({ timeout: 15_000 })

    // Select score=3 (detractor: 0–6).
    // The radio inputs are labelled "3" per the NPS spec options array.
    const scoreRadio = page.getByRole('radio', { name: '3' })
    await expect(scoreRadio).toBeVisible({ timeout: 5_000 })
    await scoreRadio.click()

    // Fill the optional reason textarea.
    const reasonField = page.getByLabel("What's the main reason for your score?")
    if (await reasonField.isVisible()) {
      await reasonField.fill('Performance is slow')
    }

    // Click Next to advance.
    await page.getByRole('button', { name: /next/i }).click()

    // Assert we landed on the detractor follow-up page, not the promoter page.
    // "Help Us Improve" is pg_followup's title.
    await expect(page.getByText('Help Us Improve')).toBeVisible({ timeout: 10_000 })

    // Sanity: promoter page "Thanks for the Love" should NOT be visible.
    await expect(page.getByText('Thanks for the Love')).not.toBeVisible()

    // Fill the follow-up textarea.
    const improvementField = page.getByLabel('What could we do better?')
    await expect(improvementField).toBeVisible({ timeout: 5_000 })
    await improvementField.fill('Please improve performance and response times.')

    // Submit.
    await page.getByRole('button', { name: /submit/i }).click()

    // Thank-you page.
    await expect(page.getByText(/thank you/i)).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 2: Server-side payload strip via API ──────────────────────────────

  test('promoter-page fields stripped from payload_jsonb on detractor submit', async ({
    request,
  }: {
    request: APIRequestContext
  }) => {
    // Build a "forged" payload: score=3 (detractor) but ALSO includes
    // fld_referral which lives on pg_promoter — a page that should be skipped.
    const forgedPayload = {
      fld_score: '3',
      fld_reason: 'Too slow',
      fld_improvement: 'Fix the performance',
      fld_referral: 'Forged promoter field — should be stripped',
    }

    // POST directly to form-api (port 4200) — bypass baseURL which points at
    // form-web. Playwright's `request` fixture uses a separate baseURL.
    const response = await request.post(
      `http://localhost:4200/v1/public/forms/${clonedSlug}/submit`,
      {
        data: { payload: forgedPayload },
        headers: { 'Content-Type': 'application/json' },
      },
    )

    expect(response.status()).toBe(201)

    const body = await response.json()
    const submissionId: string = body.submission_id
    expect(submissionId).toBeTruthy()

    // Read the persisted row directly via Prisma.
    const submission = await prisma.formSubmission.findUnique({
      where: { id: submissionId },
      select: { payloadJsonb: true },
    })

    expect(submission).not.toBeNull()

    const persisted = submission!.payloadJsonb as Record<string, unknown>

    // fld_referral is on pg_promoter which is skipped for score < 7.
    expect(persisted).not.toHaveProperty('fld_referral')

    // Fields from visited pages (pg_1 + pg_followup) MUST be present.
    expect(persisted).toHaveProperty('fld_score', '3')
    expect(persisted).toHaveProperty('fld_improvement', 'Fix the performance')

    // Audit row — asserts action and subjectId linkage.
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
