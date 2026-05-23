import { describe, it, expect } from 'vitest'
import {
  computeVisitedPages,
  type FormSpecWithActions,
} from '../../../src/core/logic/action.runner.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeSpec(
  pageIds: string[],
  actions: FormSpecWithActions['actions'] = [],
): FormSpecWithActions {
  return {
    title: 'Test',
    type: 'dynamic',
    access: { mode: 'public_anonymous' },
    pages: pageIds.map((id) => ({
      id,
      title: id,
      fields: [],
    })),
    actions,
  }
}

const EMPTY_SCORE = { total: 0, bucket: null }

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('computeVisitedPages', () => {
  it('visits all pages in order when no actions are defined', () => {
    const spec = makeSpec(['pg1', 'pg2', 'pg3'])
    const result = computeVisitedPages(spec, {}, {}, EMPTY_SCORE)
    expect(result.visited).toEqual(['pg1', 'pg2', 'pg3'])
    expect(result.skipped).toEqual([])
  })

  it('jump_to_page: jumps to named page, skipping intermediate', () => {
    const spec = makeSpec(['pg1', 'pg2', 'pg3', 'pg4'], [
      {
        trigger: 'page_exit',
        page_id: 'pg1',
        if: { '==': [{ var: 'fld_q1' }, 'skip'] },
        do: { jump_to_page: 'pg3' },
      },
    ])
    const result = computeVisitedPages(spec, { fld_q1: 'skip' }, {}, EMPTY_SCORE)
    expect(result.visited).toEqual(['pg1', 'pg3', 'pg4'])
    expect(result.skipped).toEqual(['pg2'])
  })

  it('jump_to_page: falls through to natural order when condition is false', () => {
    const spec = makeSpec(['pg1', 'pg2', 'pg3'], [
      {
        trigger: 'page_exit',
        page_id: 'pg1',
        if: { '==': [{ var: 'fld_q1' }, 'jump'] },
        do: { jump_to_page: 'pg3' },
      },
    ])
    // Condition NOT met (value = 'nope')
    const result = computeVisitedPages(spec, { fld_q1: 'nope' }, {}, EMPTY_SCORE)
    expect(result.visited).toEqual(['pg1', 'pg2', 'pg3'])
    expect(result.skipped).toEqual([])
  })

  it('skip_pages: skips N pages forward', () => {
    const spec = makeSpec(['pg1', 'pg2', 'pg3', 'pg4', 'pg5'], [
      {
        trigger: 'page_exit',
        page_id: 'pg1',
        do: { skip_pages: 2 },
      },
    ])
    // Action has no `if`, fires unconditionally
    const result = computeVisitedPages(spec, {}, {}, EMPTY_SCORE)
    // pg1 → skip 2 → pg4
    expect(result.visited).toEqual(['pg1', 'pg4', 'pg5'])
    expect(result.skipped).toContain('pg2')
    expect(result.skipped).toContain('pg3')
  })

  it('fallthrough: first matching action wins — second action with jump_to_pg4 is ignored', () => {
    // Two actions on pg1: first jumps to pg3, second (also matching) jumps to pg4.
    // With 5 pages so pg4 is NOT a natural successor of pg3 (pg3 → pg4 → pg5 would
    // all be visited in natural order). We verify that pg2 is skipped (first action
    // fired, not second) and that the traversal started at pg3 rather than pg4.
    const spec = makeSpec(['pg1', 'pg2', 'pg3', 'pg4', 'pg5'], [
      {
        trigger: 'page_exit',
        page_id: 'pg1',
        if: { '==': [{ var: 'x' }, 1] },
        do: { jump_to_page: 'pg3' },
      },
      {
        trigger: 'page_exit',
        page_id: 'pg1',
        if: { '==': [{ var: 'x' }, 1] },
        do: { jump_to_page: 'pg4' },
      },
    ])
    const result = computeVisitedPages(spec, { x: 1 }, {}, EMPTY_SCORE)
    // First action wins → skip pg2, start at pg3 (then pg4, pg5 naturally)
    expect(result.visited[0]).toBe('pg1')
    expect(result.visited[1]).toBe('pg3') // NOT pg4 as the direct jump target
    expect(result.skipped).toContain('pg2')
  })

  it('cycle detection: a page that jumps to itself stops traversal', () => {
    const spec = makeSpec(['pg1', 'pg2'], [
      {
        trigger: 'page_exit',
        page_id: 'pg1',
        do: { jump_to_page: 'pg1' },
      },
    ])
    const result = computeVisitedPages(spec, {}, {}, EMPTY_SCORE)
    expect(result.cycleDetected).toBe(true)
    // pg1 was visited once before cycle detected
    expect(result.visited).toEqual(['pg1'])
  })

  it('cycle detection: a page that jumps to a previously visited page stops', () => {
    const spec = makeSpec(['pg1', 'pg2', 'pg3'], [
      {
        trigger: 'page_exit',
        page_id: 'pg3',
        do: { jump_to_page: 'pg1' },
      },
    ])
    const result = computeVisitedPages(spec, {}, {}, EMPTY_SCORE)
    expect(result.cycleDetected).toBe(true)
    expect(result.visited).toEqual(['pg1', 'pg2', 'pg3'])
  })

  it('can reference score in action conditions', () => {
    const spec = makeSpec(['pg1', 'pg2', 'pg3'], [
      {
        trigger: 'page_exit',
        page_id: 'pg1',
        if: { '>=': [{ var: 'score' }, 50] },
        do: { jump_to_page: 'pg3' },
      },
    ])
    const score = { total: 75, bucket: 'High' }
    const result = computeVisitedPages(spec, {}, {}, score)
    expect(result.visited).toEqual(['pg1', 'pg3'])
    expect(result.skipped).toEqual(['pg2'])
  })
})
