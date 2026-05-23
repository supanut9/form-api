/**
 * action.runner.ts — server-side page-traversal engine.
 *
 * Determines which pages were visible to the user by replaying the
 * `jump_to_page` / `skip_pages` actions that the renderer would have applied,
 * using the submitted values and computed score as the data context.
 *
 * This is the single source of truth for "which pages the server considers
 * visited". The renderer's client-side traversal is advisory; the server's
 * view wins at submission time.
 *
 * Traversal algorithm:
 *   1. Start at pages[0].
 *   2. Mark the current page as visited.
 *   3. Evaluate all `page_exit` actions whose `page_id` matches the current
 *      page, in declaration order.  The first action whose `if` condition
 *      matches wins and determines the next page.
 *   4. If no action fires, proceed to the next page in spec order.
 *   5. If a page has already been visited (cycle), record `cycle_detected` and
 *      stop traversal.
 *   6. Repeat until no next page exists (terminal page reached).
 *
 * Supported action `do` kinds:
 *   { "jump_to_page": "<page_id>" }   — jump to the named page
 *   { "skip_pages": N }               — skip N pages forward in spec order
 *
 * If `if` is absent, the action fires unconditionally.
 */

import jsonLogic from 'json-logic-js'
import type { FormSpec } from '../forms/types.js'
import type { ScoreResult } from './scoring.runner.js'

// ── Phase-3A spec shapes ──────────────────────────────────────────────────────

export interface PageAction {
  trigger: 'page_exit'
  page_id: string
  if?: unknown
  do: { jump_to_page: string } | { skip_pages: number }
}

export interface FormSpecWithActions extends FormSpec {
  actions?: PageAction[]
}

// ── Result type ───────────────────────────────────────────────────────────────

export interface PageTraversalResult {
  /** Pages the user actually visited, in traversal order. */
  visited: string[]
  /** Pages declared in the spec that were never reached. */
  skipped: string[]
  /** All pages in the order they were traversed (same as `visited`). */
  finalOrder: string[]
  /** Set when a cycle was detected during traversal. */
  cycleDetected?: boolean
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute which pages were visited given the submitted values and score.
 *
 * @param spec        Published form spec (may include Phase-3A `actions`).
 * @param values      Submitted field values keyed by field-id.
 * @param calcResults Output of `computeCalculationsServer`.
 * @param score       Output of `computeScoreServer`.
 * @returns           `{ visited, skipped, finalOrder, cycleDetected? }`.
 *                    When spec has no `actions`, all pages are visited in order.
 */
export function computeVisitedPages(
  spec: FormSpecWithActions,
  values: Record<string, unknown>,
  calcResults: Record<string, number | string | null>,
  score: ScoreResult,
): PageTraversalResult {
  const specActions = (spec as FormSpecWithActions).actions ?? []

  // Build a fast page-index lookup.
  const pageIds = spec.pages.map((p) => p.id)
  const pageIndex = new Map<string, number>(pageIds.map((id, i) => [id, i]))

  // Data context for json-logic evaluation.
  const data: Record<string, unknown> = {
    ...values,
    ...calcResults,
    score: score.total,
    score_bucket: score.bucket,
  }

  const visited: string[] = []
  const visitedSet = new Set<string>()
  let currentIdx = 0
  let cycleDetected = false

  while (currentIdx >= 0 && currentIdx < spec.pages.length) {
    const currentPage = spec.pages[currentIdx]
    if (!currentPage) break

    const currentId = currentPage.id

    // Cycle detection: if we've already visited this page, stop.
    if (visitedSet.has(currentId)) {
      cycleDetected = true
      break
    }

    visited.push(currentId)
    visitedSet.add(currentId)

    // Evaluate page_exit actions for the current page.
    const applicableActions = specActions.filter(
      (a) => a.trigger === 'page_exit' && a.page_id === currentId,
    )

    let nextIdx: number | null = null

    for (const action of applicableActions) {
      // Evaluate condition (absent = always fires).
      let conditionMet = true
      if (action.if !== undefined) {
        try {
          conditionMet = Boolean(
            jsonLogic.apply(action.if as Parameters<typeof jsonLogic.apply>[0], data),
          )
        } catch {
          conditionMet = false
        }
      }

      if (!conditionMet) continue

      const doClause = action.do as Record<string, unknown>
      if ('jump_to_page' in doClause && typeof doClause['jump_to_page'] === 'string') {
        const targetId = doClause['jump_to_page'] as string
        const targetIdx = pageIndex.get(targetId)
        if (targetIdx !== undefined) {
          nextIdx = targetIdx
        }
        break // first matching action wins
      } else if ('skip_pages' in doClause && typeof doClause['skip_pages'] === 'number') {
        const skip = doClause['skip_pages'] as number
        nextIdx = currentIdx + 1 + skip
        break // first matching action wins
      }
    }

    if (nextIdx !== null) {
      // Clamp skip_pages to avoid going past the end.
      currentIdx = Math.min(nextIdx, spec.pages.length)
    } else {
      // Natural progression.
      currentIdx += 1
    }
  }

  const skipped = pageIds.filter((id) => !visitedSet.has(id))

  return {
    visited,
    skipped,
    finalOrder: visited,
    ...(cycleDetected ? { cycleDetected: true } : {}),
  }
}
