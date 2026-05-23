import { describe, it, expect, vi } from 'vitest'
import {
  compileFieldMap,
  computeCalculationsServer,
  type FormSpecWith3A,
} from '../../../src/core/logic/calc.runner.js'
import type { FormSpec } from '../../../src/core/forms/types.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<FormSpecWith3A> = {}): FormSpecWith3A {
  return {
    title: 'Test',
    type: 'dynamic',
    access: { mode: 'public_anonymous' },
    pages: [
      {
        id: 'pg1',
        title: 'Page 1',
        fields: [
          { id: 'fld_a', type: 'number', label: 'A' },
          { id: 'fld_b', type: 'number', label: 'B' },
          { id: 'fld_c', type: 'number', label: 'C' },
        ],
      },
    ],
    calculations: [],
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('compileFieldMap', () => {
  it('assigns A1, A2, A3 in declaration order across pages', () => {
    const spec = makeSpec({
      pages: [
        { id: 'pg1', title: 'P1', fields: [{ id: 'fld_x', type: 'number', label: 'X' }] },
        { id: 'pg2', title: 'P2', fields: [{ id: 'fld_y', type: 'number', label: 'Y' }] },
      ],
    })
    const map = compileFieldMap(spec as FormSpec)
    expect(map['fld_x']).toBe('A1')
    expect(map['fld_y']).toBe('A2')
  })
})

describe('computeCalculationsServer', () => {
  it('fixture 1: SUM across multiselect — sums numeric members', () => {
    const spec = makeSpec({
      pages: [
        {
          id: 'pg1',
          title: 'P1',
          fields: [{ id: 'fld_qty', type: 'multiselect', label: 'Qty', options: [{ value: '1', label: '1' }] }],
        },
      ],
      calculations: [{ id: 'calc_sum', label: 'Sum', formula: 'SUM(fld_qty)' }],
    })
    // multiselect value is an array — toHFValue sums numeric members
    const result = computeCalculationsServer(spec, { fld_qty: [5, 10, 15] }, 'form1', 1)
    // SUM of 30 in a single cell: HF receives a scalar 30 from toHFValue, so =SUM(A1) = 30
    expect(result['calc_sum']).toBe(30)
  })

  it('fixture 2: nested calc referencing another calc', () => {
    const spec = makeSpec({
      calculations: [
        { id: 'calc_base', label: 'Base', formula: 'fld_a + fld_b' },
        { id: 'calc_tax', label: 'Tax', formula: 'calc_base * 0.1' },
      ],
    })
    const result = computeCalculationsServer(spec, { fld_a: 100, fld_b: 50 }, 'form2', 1)
    expect(result['calc_base']).toBe(150)
    expect(result['calc_tax']).toBeCloseTo(15)
  })

  it('fixture 3: divide-by-zero returns null', () => {
    const spec = makeSpec({
      calculations: [{ id: 'calc_div', label: 'Div', formula: 'fld_a / fld_b' }],
    })
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = computeCalculationsServer(spec, { fld_a: 10, fld_b: 0 }, 'form3', 1)
    expect(result['calc_div']).toBeNull()
    consoleSpy.mockRestore()
  })

  it('fixture 4: missing field defaults to 0 so sum still works', () => {
    const spec = makeSpec({
      calculations: [{ id: 'calc_total', label: 'Total', formula: 'fld_a + fld_b + fld_c' }],
    })
    // fld_c is omitted
    const result = computeCalculationsServer(spec, { fld_a: 7, fld_b: 3 }, 'form4', 1)
    expect(result['calc_total']).toBe(10)
  })

  it('fixture 5: invalid formula returns null and logs warning', () => {
    const spec = makeSpec({
      calculations: [{ id: 'calc_bad', label: 'Bad', formula: 'NOT_A_FUNCTION_XYZ(fld_a)' }],
    })
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = computeCalculationsServer(spec, { fld_a: 5 }, 'form5', 1)
    expect(result['calc_bad']).toBeNull()
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
