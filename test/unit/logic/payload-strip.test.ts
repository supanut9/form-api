/**
 * Integration test: stripSkippedFields
 *
 * Exercises the full pipeline: calc → score → page traversal → strip.
 * Prisma is mocked so no live database is required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stripSkippedFields } from '../../../src/core/submissions/payload.validator.js'
import type { FormSpecWith3A } from '../../../src/core/logic/calc.runner.js'
import type { FormSpecWithScoring } from '../../../src/core/logic/scoring.runner.js'
import type { FormSpecWithActions } from '../../../src/core/logic/action.runner.js'

// ── Mock Prisma ───────────────────────────────────────────────────────────────

function makePrismaMock() {
  return {
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  }
}

// ── Spec helpers ──────────────────────────────────────────────────────────────

type TestSpec = FormSpecWith3A & FormSpecWithScoring & FormSpecWithActions

function makeSpec(): TestSpec {
  return {
    title: 'Test Form',
    type: 'dynamic',
    access: { mode: 'public_anonymous' },
    pages: [
      {
        id: 'pg1',
        title: 'Page 1',
        fields: [
          { id: 'fld_name', type: 'text', label: 'Name' },
          { id: 'fld_score_input', type: 'number', label: 'Score' },
        ],
      },
      {
        id: 'pg2',
        title: 'Page 2 (conditional)',
        fields: [{ id: 'fld_followup', type: 'text', label: 'Follow Up' }],
      },
      {
        id: 'pg3',
        title: 'Page 3 (final)',
        fields: [{ id: 'fld_comments', type: 'textarea', label: 'Comments' }],
      },
    ],
    calculations: [],
    scoring: { enabled: false, rules: [], buckets: [] },
    actions: [
      {
        trigger: 'page_exit',
        page_id: 'pg1',
        if: { '<': [{ var: 'fld_score_input' }, 5] },
        do: { jump_to_page: 'pg3' }, // skip pg2 for low scores
      },
    ],
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('stripSkippedFields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not strip fields when all pages are visited', async () => {
    const spec = makeSpec()
    // score_input >= 5 → no jump → pg1, pg2, pg3 all visited
    const raw = {
      fld_name: 'Alice',
      fld_score_input: 8,
      fld_followup: 'yes',
      fld_comments: 'Great form',
    }
    const prisma = makePrismaMock()
    const result = await stripSkippedFields(
      spec,
      raw,
      'form_test',
      1,
      prisma as never,
      'sub_001',
      null,
    )
    expect(result.stripped).toHaveLength(0)
    expect(result.sanitized).toEqual(raw)
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it('strips fields from skipped pages', async () => {
    const spec = makeSpec()
    // score_input = 2 < 5 → jump to pg3, skipping pg2
    const raw = {
      fld_name: 'Bob',
      fld_score_input: 2,
      fld_followup: 'I should not be here', // pg2 was skipped
      fld_comments: 'Done',
    }
    const prisma = makePrismaMock()
    const result = await stripSkippedFields(
      spec,
      raw,
      'form_test',
      1,
      prisma as never,
      'sub_002',
      null,
    )
    expect(result.stripped).toContain('fld_followup')
    expect(result.sanitized).not.toHaveProperty('fld_followup')
    expect(result.sanitized['fld_name']).toBe('Bob')
    expect(result.sanitized['fld_comments']).toBe('Done')
  })

  it('writes an audit row when fields are stripped', async () => {
    const spec = makeSpec()
    const raw = {
      fld_name: 'Carol',
      fld_score_input: 1,
      fld_followup: 'extra data',
    }
    const prisma = makePrismaMock()
    await stripSkippedFields(
      spec,
      raw,
      'form_test',
      1,
      prisma as never,
      'sub_003',
      'account_abc',
    )
    expect(prisma.auditLog.create).toHaveBeenCalledOnce()
    const call = prisma.auditLog.create.mock.calls[0][0]
    expect(call.data.action).toBe('submission.skipped_fields_stripped')
    expect(call.data.subjectId).toBe('sub_003')
    expect(call.data.actorAccountId).toBe('account_abc')
    expect((call.data.diffJson as { stripped_fields: string[] }).stripped_fields).toContain(
      'fld_followup',
    )
  })

  it('strips unknown fields not present in the spec', async () => {
    const spec = makeSpec()
    const raw = {
      fld_name: 'Dave',
      fld_score_input: 10,
      completely_unknown_field: 'injected',
    }
    const prisma = makePrismaMock()
    const result = await stripSkippedFields(
      spec,
      raw,
      'form_test',
      1,
      prisma as never,
      'sub_004',
      null,
    )
    expect(result.stripped).toContain('completely_unknown_field')
    expect(result.sanitized).not.toHaveProperty('completely_unknown_field')
  })

  it('does not reject the submission when audit write fails', async () => {
    const spec = makeSpec()
    const raw = {
      fld_name: 'Eve',
      fld_score_input: 0,
      fld_followup: 'sneaky',
    }
    const prisma = makePrismaMock()
    prisma.auditLog.create.mockRejectedValue(new Error('DB down'))
    // Should resolve without throwing
    const result = await stripSkippedFields(
      spec,
      raw,
      'form_test',
      1,
      prisma as never,
      'sub_005',
      null,
    )
    expect(result.stripped).toContain('fld_followup')
  })
})
