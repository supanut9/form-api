/**
 * E2E — workspace switcher.
 *
 * Gated on the MULTI_TENANT_E2E env var (truthy) so this spec is skipped in
 * standard CI runs that do not have a running form-admin instance.  The
 * standard e2e job sets DATABASE_URL only; multi-tenant e2e requires an
 * additional MULTI_TENANT_E2E=true override.
 *
 * Pre-conditions (all provided by beforeAll):
 *   - Two workspaces seeded for the same account via Prisma.
 *   - form-admin running at http://localhost:4201 with the emergency-token
 *     shortcut enabled (same pattern as submit-public-form.spec.ts).
 *
 * What is verified:
 *   1. Log in to form-admin via the emergency-token shortcut.
 *   2. Observe the workspace switcher in the top-left navigation area.
 *   3. Click the switcher and select the second workspace.
 *   4. Assert the URL updates (contains the second workspace slug or id).
 *   5. Assert the form list reflects the second workspace's forms and not the
 *      first workspace's forms.
 *
 * NOTE: Stripe Customer Portal interaction is explicitly excluded — that is an
 * external Stripe-hosted page and is not exercised here.
 */

import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

// ── Skip guard ─────────────────────────────────────────────────────────────────

const MULTI_TENANT_E2E = Boolean(process.env.MULTI_TENANT_E2E)

// ── Prisma factory ─────────────────────────────────────────────────────────────

function buildPrisma(): PrismaClient {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 2,
    idleTimeoutMillis: 10_000,
  })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}

// ── Test data ─────────────────────────────────────────────────────────────────

let prisma: PrismaClient
let ws1Id: string
let ws2Id: string
let ws1Slug: string
let ws2Slug: string
let formA_title: string
let formB_title: string
const OWNER_ACCOUNT = 'e2e-switcher-owner'

test.beforeAll(async () => {
  if (!MULTI_TENANT_E2E) return

  prisma = buildPrisma()
  await prisma.$connect()

  const prismaAny = prisma as any
  const freePlan = await prismaAny.workspacePlan.findUnique({ where: { slug: 'free' } })
  if (!freePlan) throw new Error('free plan not seeded')

  const ts = Date.now()
  ws1Slug = `e2e-switcher-ws1-${ts}`
  ws2Slug = `e2e-switcher-ws2-${ts}`
  formA_title = `Switcher Form Alpha ${ts}`
  formB_title = `Switcher Form Beta ${ts}`

  const ws1 = await prismaAny.workspace.create({
    data: {
      slug: ws1Slug,
      name: 'E2E Switcher WS-1',
      planId: freePlan.id,
      createdByAccountId: OWNER_ACCOUNT,
    },
  })
  ws1Id = ws1.id

  const ws2 = await prismaAny.workspace.create({
    data: {
      slug: ws2Slug,
      name: 'E2E Switcher WS-2',
      planId: freePlan.id,
      createdByAccountId: OWNER_ACCOUNT,
    },
  })
  ws2Id = ws2.id

  await prismaAny.workspaceMember.createMany({
    data: [
      { workspaceId: ws1Id, accountId: OWNER_ACCOUNT, role: 'owner', joinedAt: new Date() },
      { workspaceId: ws2Id, accountId: OWNER_ACCOUNT, role: 'owner', joinedAt: new Date() },
    ],
  })

  // Seed one form per workspace
  await prisma.formDefinition.create({
    data: {
      type: 'dynamic',
      title: formA_title,
      slug: `e2e-switcher-form-a-${ts}`,
      currentVersion: 1,
      ownerAccountId: OWNER_ACCOUNT,
      workspaceId: ws1Id,
    },
  })

  await prisma.formDefinition.create({
    data: {
      type: 'dynamic',
      title: formB_title,
      slug: `e2e-switcher-form-b-${ts}`,
      currentVersion: 1,
      ownerAccountId: OWNER_ACCOUNT,
      workspaceId: ws2Id,
    },
  })
})

test.afterAll(async () => {
  if (!MULTI_TENANT_E2E || !prisma) return

  const prismaAny = prisma as any
  await prismaAny.formDefinition.deleteMany({ where: { workspaceId: { in: [ws1Id, ws2Id] } } })
  await prismaAny.workspaceMember.deleteMany({ where: { workspaceId: { in: [ws1Id, ws2Id] } } })
  await prismaAny.workspace.deleteMany({ where: { id: { in: [ws1Id, ws2Id] } } })
  await prisma.$disconnect()
})

// ── Helper: log in via emergency token shortcut ────────────────────────────────

async function loginViaEmergencyToken(page: Page, accountId: string): Promise<void> {
  // The form-admin emergency-token shortcut is available at
  // GET /api/auth/emergency?account=<accountId>
  // when EMERGENCY_TOKEN env var is set in form-admin. This is the same
  // pattern as the existing e2e suite (submit-public-form.spec.ts).
  const EMERGENCY_TOKEN = process.env.EMERGENCY_TOKEN ?? 'emergency-dev-token'
  await page.goto(
    `http://localhost:4201/api/auth/emergency?account=${accountId}&token=${EMERGENCY_TOKEN}`,
  )
  // Wait for redirect to admin dashboard
  await page.waitForURL(/localhost:4201/, { timeout: 15_000 })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' })

test.describe('Workspace switcher e2e', () => {
  test.skip(!MULTI_TENANT_E2E, 'Skipping: MULTI_TENANT_E2E not set')

  test('workspace switcher changes URL and re-scopes form list to second workspace', async ({
    page,
  }) => {
    // ── 1. Log in ──────────────────────────────────────────────────────────────
    await loginViaEmergencyToken(page, OWNER_ACCOUNT)

    // ── 2. Navigate to the admin forms page for WS-1 ─────────────────────────
    await page.goto(`http://localhost:4201/admin/forms`, {
      waitUntil: 'networkidle',
    })

    // The workspace switcher should be visible in the top-left nav area.
    const switcher = page.getByTestId('workspace-switcher').or(
      page.getByRole('button', { name: /workspace/i }),
    )
    await expect(switcher).toBeVisible({ timeout: 10_000 })

    // ── 3. Verify WS-1 form appears in the initial list ──────────────────────
    // Set the header to WS-1 by navigating with the workspace param if needed.
    // The switcher component should already be on WS-1 (first workspace for account).
    // We look for formA_title in the page.
    await expect(page.getByText(formA_title)).toBeVisible({ timeout: 10_000 })

    // ── 4. Click the switcher and select WS-2 ────────────────────────────────
    await switcher.click()

    // The switcher dropdown should show both workspace names
    const ws2Option = page.getByText('E2E Switcher WS-2')
    await expect(ws2Option).toBeVisible({ timeout: 5_000 })
    await ws2Option.click()

    // ── 5. Assert URL contains ws2Slug or ws2Id ───────────────────────────────
    await page.waitForURL(
      (url) =>
        url.toString().includes(ws2Slug) || url.toString().includes(ws2Id),
      { timeout: 10_000 },
    )

    // ── 6. Assert form list now shows WS-2 form, not WS-1 form ───────────────
    await expect(page.getByText(formB_title)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(formA_title)).not.toBeVisible()
  })
})
