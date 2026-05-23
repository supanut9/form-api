import { formSpecSchema, type FormSpec } from './types.js'

// ── Errors ────────────────────────────────────────────────────────────────────

export class FormSpecValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message)
    this.name = 'FormSpecValidationError'
  }
}

// ── Semantic checks ───────────────────────────────────────────────────────────

function collectFieldIds(spec: FormSpec): string[] {
  return spec.pages.flatMap((p) => p.fields.map((f) => f.id))
}

function findDuplicates<T>(values: T[]): T[] {
  const seen = new Set<T>()
  const dupes = new Set<T>()
  for (const v of values) {
    if (seen.has(v)) dupes.add(v)
    seen.add(v)
  }
  return [...dupes]
}

/**
 * Phase-1 stub: confirm a show_if rule is a non-null, non-array object.
 * Full json-logic validation (operators, type-checks against field types)
 * lands in Wave 3 once packages/form-renderer exports the shared evaluator.
 */
function isPlainRuleObject(rule: unknown): boolean {
  return rule !== null && typeof rule === 'object' && !Array.isArray(rule)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Structural + lightweight-semantic validation.
 * Does NOT evaluate show_if rules — call deepValidateSpec for that.
 */
export async function validateSpec(spec: unknown): Promise<FormSpec> {
  const result = formSpecSchema.safeParse(spec)
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `[${i.path.join('.')}] ${i.message}`,
    )
    throw new FormSpecValidationError(
      'Form spec failed structural validation',
      issues,
    )
  }

  const parsed = result.data
  const semanticIssues: string[] = []

  // page-id uniqueness
  const pageDupes = findDuplicates(parsed.pages.map((p) => p.id))
  if (pageDupes.length) {
    semanticIssues.push(
      `duplicate page ids: ${pageDupes.join(', ')}`,
    )
  }

  // field-id uniqueness across all pages
  const allFieldIds = collectFieldIds(parsed)
  const fieldDupes = findDuplicates(allFieldIds)
  if (fieldDupes.length) {
    semanticIssues.push(
      `duplicate field ids: ${fieldDupes.join(', ')}`,
    )
  }

  // select / multiselect / radio require options
  for (const page of parsed.pages) {
    for (const field of page.fields) {
      const needsOptions =
        field.type === 'select' ||
        field.type === 'multiselect' ||
        field.type === 'radio'
      if (needsOptions && (!field.options || field.options.length === 0)) {
        semanticIssues.push(
          `field ${field.id} (${field.type}) requires non-empty options`,
        )
      }
    }
  }

  if (semanticIssues.length) {
    throw new FormSpecValidationError(
      'Form spec failed semantic validation',
      semanticIssues,
    )
  }

  return parsed
}

/**
 * Deep validation — structural + semantic + show_if rule shape.
 * Use this on publish. Stub at Phase 1: the shared json-logic evaluator from
 * packages/form-renderer will land in Wave 3 and do real rule typechecking.
 */
export async function deepValidateSpec(spec: unknown): Promise<FormSpec> {
  const parsed = await validateSpec(spec)
  const ruleIssues: string[] = []

  for (const page of parsed.pages) {
    if (page.show_if !== undefined && !isPlainRuleObject(page.show_if)) {
      ruleIssues.push(`page ${page.id} show_if must be a json-logic object`)
    }
    for (const field of page.fields) {
      if (field.show_if !== undefined && !isPlainRuleObject(field.show_if)) {
        ruleIssues.push(
          `field ${field.id} show_if must be a json-logic object`,
        )
      }
    }
  }

  if (ruleIssues.length) {
    throw new FormSpecValidationError(
      'Form spec failed rule validation',
      ruleIssues,
    )
  }

  return parsed
}
