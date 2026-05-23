/**
 * E2E seed helper — upserts the NPS FormTemplate row used by
 * scoring-branching.spec.ts.
 *
 * Reads prisma/seed/templates/nps.json and upserts a FormTemplate row with
 * slug "nps-e2e" so the spec can clone it without touching the built-in
 * "nps" slug that the standard seed may have written.
 *
 * The function is exported so it can be called from a beforeAll inside a spec,
 * as well as run directly as a standalone script:
 *
 *   npx tsx test/e2e/setup/seed-template.ts
 *
 * Idempotent: safe to run multiple times.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { PrismaClient } from '@prisma/client'

// Resolve path relative to this file so it works regardless of cwd.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const NPS_JSON_PATH = path.resolve(__dirname, '../../../prisma/seed/templates/nps.json')

export const NPS_E2E_SLUG = 'nps-e2e'

/**
 * Upsert the NPS template row.
 *
 * @param prisma  A real PrismaClient (must be connected to the test database).
 * @returns       The templateId of the upserted row.
 */
export async function seedNpsTemplate(prisma: PrismaClient): Promise<{ templateId: string }> {
  const specJson = JSON.parse(readFileSync(NPS_JSON_PATH, 'utf-8'))

  const existing = await prisma.formTemplate.findUnique({ where: { slug: NPS_E2E_SLUG } })

  if (existing) {
    console.log(`[seed-template] Found existing NPS template: ${existing.id}`)
    return { templateId: existing.id }
  }

  const row = await prisma.formTemplate.create({
    data: {
      slug: NPS_E2E_SLUG,
      title: 'Net Promoter Score (NPS) — E2E',
      description: 'E2E test copy of the built-in NPS template.',
      category: 'nps',
      featuredOrder: 99,
      specJson: specJson as object,
    },
  })

  console.log(`[seed-template] Created NPS template: ${row.id}`)
  return { templateId: row.id }
}

// ── Standalone execution ──────────────────────────────────────────────────────

// Only run the script body when executed directly (not when imported).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) {
    console.log('[seed-template] DATABASE_URL not set — skipping seed.')
    process.exit(0)
  }

  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })

  try {
    await seedNpsTemplate(prisma)
    console.log('[seed-template] Done.')
  } catch (err) {
    console.error('[seed-template] Error:', err)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}
