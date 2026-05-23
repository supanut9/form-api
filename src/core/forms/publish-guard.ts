/**
 * publish-guard.ts
 *
 * Pure validation layer that runs before a new FormVersion row is written.
 * Returns an array of errors (empty = spec is publishable).
 * No IO — the caller is responsible for DB reads.
 */

import type { FormSpec } from './types.js'

export interface PublishGuardError {
  code:
    | 'duplicate_field_id'
    | 'duplicate_page_id'
    | 'unknown_field_ref'
    | 'field_id_pattern'
    | 'page_id_pattern'
    | 'archived_form'
    | 'empty_page'
    // 3A codes
    | 'unknown_calc_ref'
    | 'unknown_page_ref'
    | 'formula_unknown_ref'
    | 'scoring_unknown_ref'
  message: string
  path?: string[]
}

const PAGE_ID_RE = /^pg_[a-z0-9_-]+$/i
const FIELD_ID_RE = /^fld_[a-z0-9_-]+$/i

/**
 * Recursively collect every `{var: "<string>"}` value from a json-logic tree.
 * Only the first segment before "." is returned so matrix sub-keys ("fld_a.row")
 * are resolved to their parent field id ("fld_a").
 */
function collectVarRefs(node: unknown): string[] {
  if (node === null || node === undefined) return []
  if (typeof node !== 'object') return []

  const obj = node as Record<string, unknown>

  // Direct {var: "..."} literal
  if ('var' in obj && typeof obj['var'] === 'string') {
    const raw = obj['var']
    const dotIdx = raw.indexOf('.')
    return [dotIdx === -1 ? raw : raw.slice(0, dotIdx)]
  }

  // Recurse into all values (handles and/or/not/== etc.)
  const refs: string[] = []
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const item of v) refs.push(...collectVarRefs(item))
    } else {
      refs.push(...collectVarRefs(v))
    }
  }
  return refs
}

export function validatePublishableSpec(
  spec: FormSpec,
  form: { archivedAt: Date | null },
): PublishGuardError[] {
  // 1. Archived guard — bail early, no point reporting the rest.
  if (form.archivedAt !== null) {
    return [
      {
        code: 'archived_form',
        message: 'Cannot publish a version on an archived form',
      },
    ]
  }

  const errors: PublishGuardError[] = []

  // Collect all field ids across all pages for cross-reference checks.
  const allFieldIds = new Set<string>()

  // 2 & 3. Page-level checks: duplicate ids and id pattern.
  const seenPageIds = new Set<string>()
  for (let pi = 0; pi < spec.pages.length; pi++) {
    const page = spec.pages[pi]
    if (!page) continue
    const pageCtx = `pages[${pi}]`

    // 2a. Duplicate page id.
    if (seenPageIds.has(page.id)) {
      errors.push({
        code: 'duplicate_page_id',
        message: `Duplicate page id "${page.id}"`,
        path: [pageCtx, 'id'],
      })
    } else {
      seenPageIds.add(page.id)
    }

    // 3a. Page id pattern.
    if (!PAGE_ID_RE.test(page.id)) {
      errors.push({
        code: 'page_id_pattern',
        message: `Page id "${page.id}" must match /^pg_[a-z0-9_-]+$/i`,
        path: [pageCtx, 'id'],
      })
    }

    // 4. Empty page guard.
    if (!page.fields || page.fields.length === 0) {
      errors.push({
        code: 'empty_page',
        message: `Page "${page.id}" has no fields`,
        path: [pageCtx, 'fields'],
      })
    }

    // 2b & 3b. Field-level: duplicate ids and pattern — build allFieldIds set.
    const seenFieldIdsOnPage = new Set<string>()
    for (let fi = 0; fi < (page.fields ?? []).length; fi++) {
      const field = page.fields?.[fi]
      if (!field) continue
      const fieldCtx = `${pageCtx}.fields[${fi}]`

      // 2b. Duplicate field id (cross-page).
      if (allFieldIds.has(field.id)) {
        errors.push({
          code: 'duplicate_field_id',
          message: `Duplicate field id "${field.id}"`,
          path: [fieldCtx, 'id'],
        })
      } else {
        allFieldIds.add(field.id)
      }
      seenFieldIdsOnPage.add(field.id)

      // 3b. Field id pattern.
      if (!FIELD_ID_RE.test(field.id)) {
        errors.push({
          code: 'field_id_pattern',
          message: `Field id "${field.id}" must match /^fld_[a-z0-9_-]+$/i`,
          path: [fieldCtx, 'id'],
        })
      }
    }
  }

  // 5. Unknown field refs in show_if and rows_from_field.
  // We need allFieldIds to be fully populated before this pass.
  for (let pi = 0; pi < spec.pages.length; pi++) {
    const page = spec.pages[pi]
    if (!page) continue
    const pageCtx = `pages[${pi}]`

    // Page-level show_if.
    if (page.show_if != null) {
      for (const ref of collectVarRefs(page.show_if)) {
        if (!allFieldIds.has(ref)) {
          errors.push({
            code: 'unknown_field_ref',
            message: `show_if references unknown field id "${ref}"`,
            path: [pageCtx, 'show_if'],
          })
        }
      }
    }

    for (let fi = 0; fi < (page.fields ?? []).length; fi++) {
      const field = page.fields[fi]
      if (!field) continue
      const fieldCtx = `${pageCtx}.fields[${fi}]`

      // Field-level show_if.
      if (field.show_if != null) {
        for (const ref of collectVarRefs(field.show_if)) {
          if (!allFieldIds.has(ref)) {
            errors.push({
              code: 'unknown_field_ref',
              message: `show_if references unknown field id "${ref}"`,
              path: [fieldCtx, 'show_if'],
            })
          }
        }
      }

      // Matrix rows_from_field reference.
      const rowsFrom = (field as Record<string, unknown>)['rows_from_field']
      if (typeof rowsFrom === 'string' && rowsFrom.length > 0) {
        const rootRef = rowsFrom.indexOf('.') === -1 ? rowsFrom : rowsFrom.slice(0, rowsFrom.indexOf('.'))
        if (!allFieldIds.has(rootRef)) {
          errors.push({
            code: 'unknown_field_ref',
            message: `rows_from_field references unknown field id "${rootRef}"`,
            path: [fieldCtx, 'rows_from_field'],
          })
        }
      }
    }
  }

  // ── Phase 3A: calculations / scoring / actions cross-reference checks ───────

  // Build the set of known calc ids for formula-ref and scoring-ref validation.
  const allCalcIds = new Set<string>()
  if (spec.calculations) {
    for (const calc of spec.calculations) {
      allCalcIds.add(calc.id)
    }
  }

  // 6. Calculations — verify formula references to fld_ and calc_ identifiers.
  if (spec.calculations) {
    // Regex that finds fld_… and calc_… identifiers inside a formula string.
    // Matches both {var:"fld_x"} style refs and bare identifiers used by
    // HyperFormula custom-function wrappers (e.g. SUM(fld_qty, calc_total)).
    const FORMULA_ID_RE = /\b(fld_[a-z0-9_-]+|calc_[a-z0-9_-]+)\b/gi

    for (let ci = 0; ci < spec.calculations.length; ci++) {
      const calc = spec.calculations[ci]
      if (!calc) continue
      const ctx = `calculations[${ci}]`

      const matches = [...calc.formula.matchAll(FORMULA_ID_RE)]
      for (const m of matches) {
        const ref = m[1]
        if (!ref) continue
        if (ref.startsWith('fld_') && !allFieldIds.has(ref)) {
          errors.push({
            code: 'formula_unknown_ref',
            message: `Calculation "${calc.id}" formula references unknown field "${ref}"`,
            path: [ctx, 'formula'],
          })
        } else if (ref.startsWith('calc_') && ref !== calc.id && !allCalcIds.has(ref)) {
          errors.push({
            code: 'formula_unknown_ref',
            message: `Calculation "${calc.id}" formula references unknown calc "${ref}"`,
            path: [ctx, 'formula'],
          })
        }
      }
    }
  }

  // 7. Actions — verify page_id, jump_to_page, and skip_pages targets.
  if (spec.actions) {
    for (let ai = 0; ai < spec.actions.length; ai++) {
      const action = spec.actions[ai]
      if (!action) continue
      const ctx = `actions[${ai}]`

      // trigger source page must exist
      if (!seenPageIds.has(action.page_id)) {
        errors.push({
          code: 'unknown_page_ref',
          message: `Action page_id "${action.page_id}" does not exist`,
          path: [ctx, 'page_id'],
        })
      }

      // do.jump_to_page or do.skip_pages targets must exist
      const doClause = action.do as Record<string, unknown>
      if ('jump_to_page' in doClause) {
        const target = doClause['jump_to_page'] as string
        if (!seenPageIds.has(target)) {
          errors.push({
            code: 'unknown_page_ref',
            message: `Action do.jump_to_page "${target}" does not exist`,
            path: [ctx, 'do', 'jump_to_page'],
          })
        }
      } else if ('skip_pages' in doClause) {
        // skip_pages may be an array of page ids OR a numeric skip count (L2 form).
        // Only validate page-id references when it is an array of strings.
        const rawSkip = doClause['skip_pages']
        if (Array.isArray(rawSkip)) {
          const targets = rawSkip as string[]
          for (let ti = 0; ti < targets.length; ti++) {
            const target = targets[ti]
            if (!target) continue
            if (!seenPageIds.has(target)) {
              errors.push({
                code: 'unknown_page_ref',
                message: `Action do.skip_pages[${ti}] "${target}" does not exist`,
                path: [ctx, 'do', 'skip_pages', String(ti)],
              })
            }
          }
        }
      }
    }
  }

  // 8. Scoring rules — var: refs must be "score", a known fld_, or a known calc_.
  if (spec.scoring) {
    for (let ri = 0; ri < spec.scoring.rules.length; ri++) {
      const rule = spec.scoring.rules[ri]
      if (!rule) continue
      const ctx = `scoring.rules[${ri}].if`

      for (const ref of collectVarRefs(rule.if)) {
        if (ref === 'score') continue
        if (ref.startsWith('fld_') && allFieldIds.has(ref)) continue
        if (ref.startsWith('calc_') && allCalcIds.has(ref)) continue
        errors.push({
          code: 'scoring_unknown_ref',
          message: `Scoring rule[${ri}].if references unknown variable "${ref}"`,
          path: [ctx],
        })
      }
    }
  }

  return errors
}
