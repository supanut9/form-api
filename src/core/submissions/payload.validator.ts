/**
 * payload.validator.ts — server-side submission payload gating.
 *
 * After basic Zod structural validation (done by the route layer), this
 * module:
 *   1. Runs `computeVisitedPages` to determine which pages the server
 *      considers visible for this submission.
 *   2. Strips any field whose pageId is not in `visited`.
 *   3. If fields were stripped, writes an audit entry
 *      `submission.skipped_fields_stripped` with the diff.
 *   4. Returns the sanitized payload for persistence.
 *
 * The submission is NOT rejected on strip — a benign racy client may
 * submit during a spec change. We log + strip instead of blocking.
 */

import type { PrismaClient } from '@prisma/client'
import type { FormSpec } from '../forms/types.js'
import type { FormSpecWith3A } from '../logic/calc.runner.js'
import type { FormSpecWithScoring } from '../logic/scoring.runner.js'
import type { FormSpecWithActions } from '../logic/action.runner.js'
import { computeCalculationsServer } from '../logic/calc.runner.js'
import { computeScoreServer } from '../logic/scoring.runner.js'
import { computeVisitedPages } from '../logic/action.runner.js'

// Combined spec type (all three 3A extensions)
type FullSpec = FormSpec & FormSpecWith3A & FormSpecWithScoring & FormSpecWithActions

export interface StripResult {
  /** Sanitized payload safe to persist. */
  sanitized: Record<string, unknown>
  /** Field ids that were present in `raw` but stripped. */
  stripped: string[]
}

/**
 * Validate and strip a raw payload against the published spec.
 *
 * @param spec        The published form spec.
 * @param raw         The incoming payload from the client.
 * @param formId      Used for the HF instance LRU key.
 * @param version     Used for the HF instance LRU key.
 * @param prisma      Prisma client — used to write the audit entry on strip.
 * @param submissionId  The newly-created submission id (for the audit subject).
 * @param actorAccountId  Authenticated account sub or null.
 */
export async function stripSkippedFields(
  spec: FullSpec,
  raw: Record<string, unknown>,
  formId: string,
  version: number,
  prisma: PrismaClient,
  submissionId: string,
  actorAccountId: string | null,
): Promise<StripResult> {
  // Step 1: compute calc results + score so page actions can reference them.
  const calcResults = computeCalculationsServer(spec, raw, formId, version)
  const score = computeScoreServer(spec, raw, calcResults)
  const traversal = computeVisitedPages(spec, raw, calcResults, score)

  const visitedSet = new Set(traversal.visited)

  // Build a reverse map: field-id → page-id.
  const fieldToPage = new Map<string, string>()
  for (const page of spec.pages) {
    for (const field of page.fields) {
      fieldToPage.set(field.id, page.id)
    }
  }

  // Step 2: strip fields whose page was not visited.
  const sanitized: Record<string, unknown> = {}
  const stripped: string[] = []

  for (const [key, value] of Object.entries(raw)) {
    const pageId = fieldToPage.get(key)
    if (pageId === undefined) {
      // Unknown field (not in spec at all) — also strip.
      stripped.push(key)
      continue
    }
    if (!visitedSet.has(pageId)) {
      stripped.push(key)
      continue
    }
    sanitized[key] = value
  }

  // Step 3: if any fields were stripped, write an audit entry.
  if (stripped.length > 0) {
    try {
      await prisma.auditLog.create({
        data: {
          actorAccountId,
          action: 'submission.skipped_fields_stripped',
          subjectType: 'Submission',
          subjectId: submissionId,
          diffJson: {
            stripped_fields: stripped,
            visited_pages: traversal.visited,
            skipped_pages: traversal.skipped,
            cycle_detected: traversal.cycleDetected ?? false,
            form_id: formId,
            version,
          },
        },
      })
    } catch {
      // Audit failure must never block the submission.
      console.warn(
        `[payload.validator] audit write failed for submission ${submissionId}`,
      )
    }
  }

  return { sanitized, stripped }
}
