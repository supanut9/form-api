/**
 * Phase 3C – L17: Workspace backfill script.
 *
 * Creates one personal workspace per distinct ownerAccountId in form_definitions,
 * then assigns workspaceId to all that owner's:
 *   - FormDefinition rows
 *   - FormTemplate rows (where createdBy = ownerAccountId)
 *   - FormWebhook rows (where the parent form belongs to this owner)
 *   - ApiToken rows (all — ApiToken has no owner column; assigned to the first owner found)
 *
 * Idempotent: if the workspace slug already exists, reuses the existing workspace.
 *
 * Usage:
 *   npx tsx scripts/3c-backfill-workspaces.ts [--dry-run]
 *
 * Environment:
 *   DATABASE_URL must be set.
 */

import process from 'node:process'
import crypto from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import pg from 'pg'

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run')

if (DRY_RUN) {
  console.log('[backfill] DRY RUN — no writes will be made')
}

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const connectionString = process.env['DATABASE_URL']
if (!connectionString) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString, max: 5 })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8)
}

function personalSlug(ownerAccountId: string): string {
  return `personal-${shortHash(ownerAccountId)}`
}

const PROGRESS_INTERVAL = 100

// ---------------------------------------------------------------------------
// Main backfill
// ---------------------------------------------------------------------------

async function backfill() {
  // Fetch free plan id (must exist — seeded in migration)
  const freePlan = await (prisma as any).workspacePlan.findUnique({
    where: { slug: 'free' },
    select: { id: true },
  })
  if (!freePlan) {
    console.error('[backfill] "free" workspace plan not found. Run the 3C migration first.')
    process.exit(1)
  }
  const freePlanId = freePlan.id as string

  // Collect distinct owner account ids
  const owners: Array<{ ownerAccountId: string }> = await prisma.$queryRaw`
    SELECT DISTINCT "owner_account_id" AS "ownerAccountId"
    FROM "form_definitions"
    WHERE "owner_account_id" IS NOT NULL
    ORDER BY "owner_account_id"
  `

  console.log(`[backfill] Found ${owners.length} distinct owner account(s)`)

  let processed = 0
  let created = 0
  let reused = 0

  for (const { ownerAccountId } of owners) {
    const slug = personalSlug(ownerAccountId)

    if (DRY_RUN) {
      console.log(`[dry-run] Would upsert workspace slug="${slug}" for account="${ownerAccountId}"`)
      processed++
      if (processed % PROGRESS_INTERVAL === 0) {
        console.log(`[backfill] Progress: ${processed}/${owners.length}`)
      }
      continue
    }

    // ── Upsert workspace ───────────────────────────────────────────────────
    let workspaceId: string

    const existing = await (prisma as any).workspace.findUnique({
      where: { slug },
      select: { id: true },
    })

    if (existing) {
      workspaceId = existing.id as string
      reused++
    } else {
      // Run entire account's update in a single transaction for atomicity
      const result = await prisma.$transaction(async (tx: any) => {
        const ws = await tx.workspace.create({
          data: {
            slug,
            name: 'Personal workspace',
            planId: freePlanId,
            createdByAccountId: ownerAccountId,
          },
          select: { id: true },
        })

        await tx.workspaceMember.create({
          data: {
            workspaceId: ws.id,
            accountId: ownerAccountId,
            role: 'owner',
            joinedAt: new Date(),
          },
        })

        return ws
      })
      workspaceId = result.id as string
      created++
    }

    // ── Update owned rows in a single transaction ──────────────────────────
    await prisma.$transaction(async (tx: any) => {
      // FormDefinition
      await tx.formDefinition.updateMany({
        where: {
          ownerAccountId,
          workspaceId: null,
        },
        data: { workspaceId },
      })

      // FormTemplate (createdBy = ownerAccountId stored as UUID text)
      await tx.formTemplate.updateMany({
        where: {
          createdBy: ownerAccountId,
          workspaceId: null,
        },
        data: { workspaceId },
      })

      // FormWebhook — join via form_definitions to find this owner's webhooks
      // Prisma updateMany doesn't support nested where on relations;
      // use raw SQL for the join-based update.
      await tx.$executeRaw`
        UPDATE "form_webhooks"
        SET "workspace_id" = ${workspaceId}::uuid
        WHERE "workspace_id" IS NULL
          AND "form_id" IN (
            SELECT "id" FROM "form_definitions"
            WHERE "owner_account_id" = ${ownerAccountId}
          )
      `
    })

    processed++
    if (processed % PROGRESS_INTERVAL === 0) {
      console.log(`[backfill] Progress: ${processed}/${owners.length}`)
    }
  }

  if (!DRY_RUN) {
    // ApiToken: no owner column — assign unscoped tokens to the first created workspace
    // (per spec comment: "adapt to whichever owner column exists"). ApiToken has no
    // owner field in the current schema, so we leave workspaceId null for now.
    // They can be manually assigned via admin once workspace UI ships in 3C.2.
    console.log(
      '[backfill] NOTE: ApiToken rows have no owner column and are left with workspaceId=null.',
    )
    console.log(
      '          They will be assigned via admin workspace settings UI (3C.2).',
    )
  }

  console.log(
    `[backfill] Done. Processed=${processed}, workspacesCreated=${created}, workspacesReused=${reused}`,
  )
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

backfill()
  .catch((err) => {
    console.error('[backfill] Fatal error:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
