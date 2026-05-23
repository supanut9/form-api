/**
 * spec-3a.ts
 *
 * Zod schemas for Phase 3A form-spec extensions:
 *   - CalculationsSchema
 *   - ScoringSchema
 *   - ActionsSchema
 *
 * These are kept in a separate file so Phase 3B/3C can follow the same pattern
 * (spec-3b.ts, spec-3c.ts) without touching this file.
 *
 * JsonLogicRuleSchema is intentionally NOT redefined here — it is re-exported
 * from types.ts so every consumer shares one canonical definition.
 */

import { z } from 'zod'

// ── JsonLogic rule ────────────────────────────────────────────────────────────

/**
 * Canonical json-logic rule schema.
 * Phase-1 stub: accepts any non-null, non-array object at runtime.
 * The inferred TypeScript type is `unknown` so it stays compatible with
 * Lane L2 runner interfaces (ScoringRule.if: unknown, etc.) which are the
 * authoritative runtime consumers.
 * Full operator / type-checking lands in Wave 3 once the renderer exports
 * the shared evaluator. Re-exported here so consumers import from one place.
 */
export const JsonLogicRuleSchema = z
  .unknown()
  .refine(
    (v) => v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v),
    { message: 'json-logic rule must be a non-null, non-array object' },
  )

// ── CalculationsSchema ────────────────────────────────────────────────────────

/**
 * A single calculated-field definition.
 * id    — must start with "calc_"
 * formula — the HyperFormula / spreadsheet expression evaluated at runtime.
 *           Syntax is validated structurally at publish time (unknown ref check
 *           in publish-guard.ts); expression semantics are runtime concerns.
 */
export const CalculationItemSchema = z.object({
  id: z
    .string()
    .regex(/^calc_[a-z0-9_-]+$/i, 'calc id must match /^calc_[a-z0-9_-]+$/i'),
  label: z.string().min(1),
  formula: z.string().min(1).max(1024),
  hidden: z.boolean().optional(),
})

export const CalculationsSchema = z.array(CalculationItemSchema)

// ── ScoringSchema ─────────────────────────────────────────────────────────────

const ScoringRuleSchema = z.object({
  if: JsonLogicRuleSchema,
  then: z
    .object({
      add: z.number().optional(),
      set: z.number().optional(),
    })
    .refine((v) => v.add !== undefined || v.set !== undefined, {
      message: 'scoring rule.then must have at least one of: add, set',
    }),
})

const ScoringBucketSchema = z.object({
  min: z.number(),
  max: z.number(),
  label: z.string().min(1),
})

/**
 * Scoring configuration. Bucket ranges must be non-overlapping.
 */
export const ScoringSchema = z
  .object({
    enabled: z.boolean(),
    rules: z.array(ScoringRuleSchema),
    buckets: z.array(ScoringBucketSchema),
  })
  .refine(
    (s) => {
      // Verify no two buckets share any integer in their [min, max] range.
      // We check overlap pair-wise: two ranges [a,b] and [c,d] overlap when a<=d && c<=b.
      const bs = s.buckets
      for (let i = 0; i < bs.length; i++) {
        for (let j = i + 1; j < bs.length; j++) {
          const a = bs[i]
          const b = bs[j]
          if (a === undefined || b === undefined) continue
          if (a.min <= b.max && b.min <= a.max) return false
        }
      }
      return true
    },
    { message: 'scoring buckets must not overlap' },
  )

// ── ActionsSchema ─────────────────────────────────────────────────────────────

const PageIdSchema = z
  .string()
  .regex(/^pg_[a-z0-9_-]+$/i, 'page id must match /^pg_[a-z0-9_-]+$/i')

const ActionDoSchema = z.union([
  z.object({ jump_to_page: PageIdSchema }),
  // skip_pages may be an array of explicit page ids (spec canonical form)
  // OR a positive integer (L2 runner's "skip N pages forward" interpretation).
  // Both forms are accepted so that L2's PageAction interface remains assignable
  // to FormSpec['actions'][number] without touching L2 files.
  z.object({ skip_pages: z.union([z.array(PageIdSchema).min(1), z.number().int().positive()]) }),
])

export const ActionItemSchema = z.object({
  trigger: z.literal('page_exit'),
  page_id: PageIdSchema,
  // if is optional so that L2 runner interfaces (PageAction.if?: unknown) remain
  // assignable to FormSpec['actions'][number]. At publish time, publish-guard
  // validates that any provided if value is a valid json-logic object.
  if: JsonLogicRuleSchema.optional(),
  do: ActionDoSchema,
})

export const ActionsSchema = z.array(ActionItemSchema)

// ── Inferred TS types ─────────────────────────────────────────────────────────

export type CalculationItem = z.infer<typeof CalculationItemSchema>
export type Calculations = z.infer<typeof CalculationsSchema>
export type Scoring = z.infer<typeof ScoringSchema>
export type ActionItem = z.infer<typeof ActionItemSchema>
export type Actions = z.infer<typeof ActionsSchema>
export type JsonLogicRule = z.infer<typeof JsonLogicRuleSchema>
