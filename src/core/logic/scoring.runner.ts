/**
 * scoring.runner.ts — server-side score computation.
 *
 * Thin layer over json-logic-js (already in the Phase-1 dependency tree).
 * Does NOT re-implement any logic evaluation — delegates to the same engine
 * used elsewhere in the server.
 *
 * Scoring rule evaluation (declaration order):
 *   Rules are applied in the order they appear in `spec.scoring.rules`.
 *   Each rule's `then` clause may be:
 *     { "add": N }  — accumulate N onto the running total
 *     { "set": N }  — replace the running total with N
 *   The first matching `add` does not stop processing; all matching rules fire.
 *   A matching `set` overrides the total as of that rule, but subsequent rules
 *   continue to apply (matching `set` rules override again; matching `add`
 *   rules add onto the post-set value).
 *
 * Bucket selection:
 *   Buckets are `{ min, max, label }` ranges (both ends inclusive).
 *   The first bucket whose range contains the final total wins.
 *   If no bucket matches, `bucket` is null.
 */

import jsonLogic from 'json-logic-js'
import type { FormSpec } from '../forms/types.js'

// ── Phase-3A spec shapes ──────────────────────────────────────────────────────

export interface ScoringRule {
  if: unknown
  then: { add: number } | { set: number }
}

export interface ScoringBucket {
  min: number
  max: number
  label: string
}

export interface ScoringSpec {
  enabled: boolean
  rules: ScoringRule[]
  buckets: ScoringBucket[]
}

export interface FormSpecWithScoring extends FormSpec {
  scoring?: ScoringSpec
}

export interface ScoreResult {
  total: number
  bucket: string | null
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute score for a submission.
 *
 * @param spec        Published form spec (may include Phase-3A `scoring`).
 * @param values      Submitted field values keyed by field-id.
 * @param calcResults Output of `computeCalculationsServer` (may be empty `{}`).
 * @returns           `{ total, bucket }`. Returns `{ total: 0, bucket: null }`
 *                    when scoring is absent or disabled.
 */
export function computeScoreServer(
  spec: FormSpecWithScoring,
  values: Record<string, unknown>,
  calcResults: Record<string, number | string | null>,
): ScoreResult {
  const scoring = spec.scoring
  if (!scoring || !scoring.enabled) {
    return { total: 0, bucket: null }
  }

  // Build the data object accessible via json-logic `var` references.
  // Field values + calc results are merged; calcs take precedence on collision.
  const data: Record<string, unknown> = { ...values, ...calcResults }

  let total = 0

  for (const rule of scoring.rules) {
    let matched = false
    try {
      matched = Boolean(jsonLogic.apply(rule.if as Parameters<typeof jsonLogic.apply>[0], data))
    } catch {
      // Malformed rule — skip silently (spec validator should have caught this)
      continue
    }

    if (!matched) continue

    const then = rule.then as Record<string, unknown>
    if ('set' in then && typeof then['set'] === 'number') {
      total = then['set']
    } else if ('add' in then && typeof then['add'] === 'number') {
      total += then['add']
    }
  }

  // Bucket lookup — first matching bucket wins.
  let bucket: string | null = null
  for (const b of scoring.buckets) {
    if (total >= b.min && total <= b.max) {
      bucket = b.label
      break
    }
  }

  return { total, bucket }
}
