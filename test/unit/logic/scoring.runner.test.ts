import { describe, it, expect } from 'vitest'
import {
  computeScoreServer,
  type FormSpecWithScoring,
} from '../../../src/core/logic/scoring.runner.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

const BASE_SPEC: FormSpecWithScoring = {
  title: 'Test',
  type: 'dynamic',
  access: { mode: 'public_anonymous' },
  pages: [{ id: 'pg1', title: 'P1', fields: [{ id: 'fld_q1', type: 'text', label: 'Q1' }] }],
}

function withScoring(
  rules: FormSpecWithScoring['scoring']['rules'],
  buckets: FormSpecWithScoring['scoring']['buckets'] = [],
): FormSpecWithScoring {
  return {
    ...BASE_SPEC,
    scoring: { enabled: true, rules, buckets },
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('computeScoreServer', () => {
  it('returns 0/null when scoring is disabled', () => {
    const spec: FormSpecWithScoring = {
      ...BASE_SPEC,
      scoring: { enabled: false, rules: [], buckets: [] },
    }
    const result = computeScoreServer(spec, {}, {})
    expect(result).toEqual({ total: 0, bucket: null })
  })

  it('returns 0/null when scoring is absent', () => {
    const result = computeScoreServer(BASE_SPEC, {}, {})
    expect(result).toEqual({ total: 0, bucket: null })
  })

  it('rule order matters — rules are applied in declaration order', () => {
    const spec = withScoring([
      { if: { '==': [{ var: 'fld_q1' }, 'A'] }, then: { add: 10 } },
      { if: { '==': [{ var: 'fld_q1' }, 'A'] }, then: { add: 5 } },
    ])
    const result = computeScoreServer(spec, { fld_q1: 'A' }, {})
    // Both rules match → total = 15
    expect(result.total).toBe(15)
  })

  it('set overrides add: set replaces total, subsequent add adds onto it', () => {
    const spec = withScoring([
      { if: { '==': [{ var: 'fld_q1' }, 'A'] }, then: { add: 10 } },
      { if: { '==': [{ var: 'fld_q1' }, 'A'] }, then: { set: 50 } },
      { if: { '==': [{ var: 'fld_q1' }, 'A'] }, then: { add: 2 } },
    ])
    const result = computeScoreServer(spec, { fld_q1: 'A' }, {})
    // add 10 → 10; set 50 → 50; add 2 → 52
    expect(result.total).toBe(52)
  })

  it('bucket selection — correct bucket on boundary value (min inclusive)', () => {
    const spec = withScoring(
      [{ if: true, then: { set: 10 } }],
      [
        { min: 0, max: 9, label: 'Low' },
        { min: 10, max: 100, label: 'High' },
      ],
    )
    const result = computeScoreServer(spec, {}, {})
    expect(result.total).toBe(10)
    expect(result.bucket).toBe('High')
  })

  it('bucket selection — correct bucket on boundary value (max inclusive)', () => {
    const spec = withScoring(
      [{ if: true, then: { set: 9 } }],
      [
        { min: 0, max: 9, label: 'Low' },
        { min: 10, max: 100, label: 'High' },
      ],
    )
    const result = computeScoreServer(spec, {}, {})
    expect(result.total).toBe(9)
    expect(result.bucket).toBe('Low')
  })

  it('bucket selection — null when no bucket matches', () => {
    const spec = withScoring(
      [{ if: true, then: { set: 200 } }],
      [{ min: 0, max: 100, label: 'In range' }],
    )
    const result = computeScoreServer(spec, {}, {})
    expect(result.bucket).toBeNull()
  })

  it('can reference calc results via var', () => {
    const spec = withScoring([
      { if: { '>=': [{ var: 'calc_total' }, 100] }, then: { add: 20 } },
    ])
    const result = computeScoreServer(spec, {}, { calc_total: 150 })
    expect(result.total).toBe(20)
  })
})
