/**
 * Unit tests for Phase 3A spec extensions.
 *
 * Covers:
 *  - Valid spec with calculations + scoring + actions parses cleanly.
 *  - Invalid calc id (missing calc_ prefix) is rejected by Zod.
 *  - Overlapping scoring buckets are rejected by Zod refine.
 *  - Action do.jump_to_page referencing unknown page id is caught by publish-guard.
 *  - Phase-1 spec (no 3A keys) still validates unchanged.
 */

import { describe, it, expect } from 'vitest'
import {
  CalculationsSchema,
  ScoringSchema,
  ActionsSchema,
} from '../../../src/core/forms/spec-3a.js'
import { validatePublishableSpec } from '../../../src/core/forms/publish-guard.js'
import type { FormSpec } from '../../../src/core/forms/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseSpec(overrides: Partial<FormSpec> = {}): FormSpec {
  return {
    title: 'Test Form',
    type: 'dynamic',
    access: { mode: 'public_anonymous' },
    pages: [
      {
        id: 'pg_1',
        title: 'Page 1',
        fields: [
          { id: 'fld_q1', type: 'text', label: 'Q1' },
        ],
      },
      {
        id: 'pg_2',
        title: 'Page 2',
        fields: [
          { id: 'fld_q2', type: 'number', label: 'Q2' },
        ],
      },
    ],
    ...overrides,
  } as FormSpec
}

const NOT_ARCHIVED = { archivedAt: null }

// ── CalculationsSchema ────────────────────────────────────────────────────────

describe('CalculationsSchema', () => {
  it('accepts valid calculations array', () => {
    const result = CalculationsSchema.safeParse([
      { id: 'calc_total', label: 'Total', formula: 'SUM(fld_q2)', hidden: false },
    ])
    expect(result.success).toBe(true)
  })

  it('rejects calc id without calc_ prefix', () => {
    const result = CalculationsSchema.safeParse([
      { id: 'bad_id', label: 'Bad', formula: 'fld_q1 + 1' },
    ])
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message).join(' ')
      expect(msgs).toMatch(/calc_/)
    }
  })

  it('rejects formula longer than 1024 chars', () => {
    const result = CalculationsSchema.safeParse([
      { id: 'calc_x', label: 'X', formula: 'A'.repeat(1025) },
    ])
    expect(result.success).toBe(false)
  })

  it('rejects empty formula', () => {
    const result = CalculationsSchema.safeParse([
      { id: 'calc_x', label: 'X', formula: '' },
    ])
    expect(result.success).toBe(false)
  })
})

// ── ScoringSchema ─────────────────────────────────────────────────────────────

describe('ScoringSchema', () => {
  it('accepts valid scoring config with non-overlapping buckets', () => {
    const result = ScoringSchema.safeParse({
      enabled: true,
      rules: [
        { if: { '==': [{ var: 'fld_q1' }, 'A'] }, then: { add: 10 } },
      ],
      buckets: [
        { min: 0, max: 9, label: 'Low' },
        { min: 10, max: 100, label: 'High' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects overlapping scoring buckets', () => {
    const result = ScoringSchema.safeParse({
      enabled: true,
      rules: [],
      buckets: [
        { min: 0, max: 10, label: 'Low' },
        { min: 5, max: 20, label: 'Overlap' },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message).join(' ')
      expect(msgs).toMatch(/overlap/)
    }
  })

  it('rejects scoring rule with no add or set', () => {
    const result = ScoringSchema.safeParse({
      enabled: true,
      rules: [
        { if: { '==': [{ var: 'x' }, 'A'] }, then: {} },
      ],
      buckets: [],
    })
    expect(result.success).toBe(false)
  })
})

// ── ActionsSchema ─────────────────────────────────────────────────────────────

describe('ActionsSchema', () => {
  it('accepts valid jump_to_page action', () => {
    const result = ActionsSchema.safeParse([
      {
        trigger: 'page_exit',
        page_id: 'pg_1',
        if: { '<': [{ var: 'score' }, 50] },
        do: { jump_to_page: 'pg_2' },
      },
    ])
    expect(result.success).toBe(true)
  })

  it('accepts valid skip_pages action', () => {
    const result = ActionsSchema.safeParse([
      {
        trigger: 'page_exit',
        page_id: 'pg_1',
        if: { '>': [{ var: 'score' }, 80] },
        do: { skip_pages: ['pg_2'] },
      },
    ])
    expect(result.success).toBe(true)
  })

  it('rejects action with non-pg_ page_id', () => {
    const result = ActionsSchema.safeParse([
      {
        trigger: 'page_exit',
        page_id: 'bad_page',
        if: { '==': [1, 1] },
        do: { jump_to_page: 'pg_2' },
      },
    ])
    expect(result.success).toBe(false)
  })
})

// ── publish-guard 3A cross-reference checks ───────────────────────────────────

describe('validatePublishableSpec — 3A cross-reference checks', () => {
  it('passes a spec with all valid 3A keys', () => {
    const spec = baseSpec({
      calculations: [
        { id: 'calc_total', label: 'Total', formula: 'fld_q2 * 2' },
      ],
      scoring: {
        enabled: true,
        rules: [
          { if: { '>': [{ var: 'fld_q2' }, 5] }, then: { add: 10 } },
        ],
        buckets: [
          { min: 0, max: 9, label: 'Low' },
          { min: 10, max: 20, label: 'High' },
        ],
      },
      actions: [
        {
          trigger: 'page_exit',
          page_id: 'pg_1',
          if: { '<': [{ var: 'score' }, 10] },
          do: { jump_to_page: 'pg_2' },
        },
      ],
    })
    const errors = validatePublishableSpec(spec, NOT_ARCHIVED)
    expect(errors).toHaveLength(0)
  })

  it('catches action do.jump_to_page referencing unknown page id', () => {
    const spec = baseSpec({
      actions: [
        {
          trigger: 'page_exit',
          page_id: 'pg_1',
          if: { '==': [1, 1] },
          do: { jump_to_page: 'pg_does_not_exist' },
        },
      ],
    })
    const errors = validatePublishableSpec(spec, NOT_ARCHIVED)
    expect(errors.some((e) => e.code === 'unknown_page_ref')).toBe(true)
    expect(errors.some((e) => e.message.includes('pg_does_not_exist'))).toBe(true)
  })

  it('catches action page_id referencing unknown page', () => {
    const spec = baseSpec({
      actions: [
        {
          trigger: 'page_exit',
          page_id: 'pg_ghost',
          if: { '==': [1, 1] },
          do: { jump_to_page: 'pg_1' },
        },
      ],
    })
    const errors = validatePublishableSpec(spec, NOT_ARCHIVED)
    expect(errors.some((e) => e.code === 'unknown_page_ref')).toBe(true)
    expect(errors.some((e) => e.message.includes('pg_ghost'))).toBe(true)
  })

  it('catches action do.skip_pages with unknown page', () => {
    const spec = baseSpec({
      actions: [
        {
          trigger: 'page_exit',
          page_id: 'pg_1',
          if: { '==': [1, 1] },
          do: { skip_pages: ['pg_missing'] },
        },
      ],
    })
    const errors = validatePublishableSpec(spec, NOT_ARCHIVED)
    expect(errors.some((e) => e.code === 'unknown_page_ref')).toBe(true)
  })

  it('catches formula referencing unknown fld_ id', () => {
    const spec = baseSpec({
      calculations: [
        { id: 'calc_bad', label: 'Bad', formula: 'fld_unknown_field * 2' },
      ],
    })
    const errors = validatePublishableSpec(spec, NOT_ARCHIVED)
    expect(errors.some((e) => e.code === 'formula_unknown_ref')).toBe(true)
    expect(errors.some((e) => e.message.includes('fld_unknown_field'))).toBe(true)
  })

  it('catches formula referencing unknown calc_ id', () => {
    const spec = baseSpec({
      calculations: [
        { id: 'calc_a', label: 'A', formula: 'calc_nonexistent + 1' },
      ],
    })
    const errors = validatePublishableSpec(spec, NOT_ARCHIVED)
    expect(errors.some((e) => e.code === 'formula_unknown_ref')).toBe(true)
  })

  it('allows formula referencing a sibling calc_ that is defined', () => {
    const spec = baseSpec({
      calculations: [
        { id: 'calc_base', label: 'Base', formula: 'fld_q2 * 1' },
        { id: 'calc_double', label: 'Double', formula: 'calc_base * 2' },
      ],
    })
    const errors = validatePublishableSpec(spec, NOT_ARCHIVED)
    const formulaErrors = errors.filter((e) => e.code === 'formula_unknown_ref')
    expect(formulaErrors).toHaveLength(0)
  })

  it('catches scoring rule referencing unknown variable', () => {
    const spec = baseSpec({
      scoring: {
        enabled: true,
        rules: [
          { if: { '>': [{ var: 'fld_unknown' }, 5] }, then: { add: 10 } },
        ],
        buckets: [],
      },
    })
    const errors = validatePublishableSpec(spec, NOT_ARCHIVED)
    expect(errors.some((e) => e.code === 'scoring_unknown_ref')).toBe(true)
    expect(errors.some((e) => e.message.includes('fld_unknown'))).toBe(true)
  })

  it('allows scoring rule referencing "score" builtin', () => {
    const spec = baseSpec({
      scoring: {
        enabled: true,
        rules: [
          { if: { '<': [{ var: 'score' }, 50] }, then: { add: 5 } },
        ],
        buckets: [],
      },
    })
    const errors = validatePublishableSpec(spec, NOT_ARCHIVED)
    const scoringErrors = errors.filter((e) => e.code === 'scoring_unknown_ref')
    expect(scoringErrors).toHaveLength(0)
  })

  it('allows scoring rule referencing known calc_ id', () => {
    const spec = baseSpec({
      calculations: [
        { id: 'calc_total', label: 'Total', formula: 'fld_q2' },
      ],
      scoring: {
        enabled: true,
        rules: [
          { if: { '>': [{ var: 'calc_total' }, 10] }, then: { add: 20 } },
        ],
        buckets: [],
      },
    })
    const errors = validatePublishableSpec(spec, NOT_ARCHIVED)
    const scoringErrors = errors.filter((e) => e.code === 'scoring_unknown_ref')
    expect(scoringErrors).toHaveLength(0)
  })
})

// ── Phase-1 backward compatibility ───────────────────────────────────────────

describe('Phase-1 spec (no 3A keys) backward compatibility', () => {
  it('passes publish-guard with no 3A fields present', () => {
    const spec = baseSpec()
    const errors = validatePublishableSpec(spec, NOT_ARCHIVED)
    expect(errors).toHaveLength(0)
  })

  it('formSpecSchema accepts spec with no 3A keys', async () => {
    // Import validateSpec which uses formSpecSchema internally
    const { validateSpec } = await import('../../../src/core/forms/spec.validator.js')
    const result = await validateSpec({
      title: 'Legacy Form',
      type: 'dynamic',
      access: { mode: 'public_anonymous' },
      pages: [
        {
          id: 'pg_1',
          title: 'Page 1',
          fields: [{ id: 'fld_name', type: 'text', label: 'Name' }],
        },
      ],
    })
    expect(result.title).toBe('Legacy Form')
    expect(result.calculations).toBeUndefined()
    expect(result.scoring).toBeUndefined()
    expect(result.actions).toBeUndefined()
  })

  it('formSpecSchema accepts spec with all 3A keys', async () => {
    const { validateSpec } = await import('../../../src/core/forms/spec.validator.js')
    const result = await validateSpec({
      title: '3A Form',
      type: 'dynamic',
      access: { mode: 'public_anonymous' },
      pages: [
        {
          id: 'pg_1',
          title: 'Page 1',
          fields: [{ id: 'fld_score', type: 'number', label: 'Score' }],
        },
        {
          id: 'pg_2',
          title: 'Page 2',
          fields: [{ id: 'fld_name', type: 'text', label: 'Name' }],
        },
      ],
      calculations: [
        { id: 'calc_double', label: 'Double', formula: 'fld_score * 2' },
      ],
      scoring: {
        enabled: true,
        rules: [{ if: { '>': [{ var: 'fld_score' }, 5] }, then: { add: 10 } }],
        buckets: [
          { min: 0, max: 9, label: 'Low' },
          { min: 10, max: 20, label: 'High' },
        ],
      },
      actions: [
        {
          trigger: 'page_exit',
          page_id: 'pg_1',
          if: { '<': [{ var: 'score' }, 5] },
          do: { jump_to_page: 'pg_2' },
        },
      ],
    })
    expect(result.calculations).toHaveLength(1)
    expect(result.scoring?.enabled).toBe(true)
    expect(result.actions).toHaveLength(1)
  })
})
