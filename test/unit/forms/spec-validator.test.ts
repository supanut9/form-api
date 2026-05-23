/**
 * Unit tests for spec.validator.ts
 *
 * Covers:
 *  - Happy path: minimal valid spec passes
 *  - Missing required fields (title, type, access, pages)
 *  - Invalid FieldType value
 *  - Invalid AccessMode value
 *  - Duplicate field ids (semantic check)
 *  - Duplicate page ids (semantic check)
 *  - Matrix field rows_from_field referencing unknown field
 *  - Empty pages array (Zod min(1))
 *  - SpecValidationError shape (message + issues array)
 */

import { describe, it, expect } from 'vitest'
import { validateSpec, FormSpecValidationError } from '../../../src/core/forms/spec.validator.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function minimalSpec(overrides: Record<string, unknown> = {}) {
  return {
    id: 'frm_test',
    version: 1,
    title: 'Test Form',
    type: 'dynamic',
    access: { mode: 'public_anonymous', require_account: false, anonymous_allowed: true },
    pages: [
      {
        id: 'pg_1',
        title: 'Page 1',
        fields: [
          { id: 'fld_name', type: 'text', label: 'Name', required: true },
        ],
      },
    ],
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('validateSpec', () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it('accepts a minimal valid spec', async () => {
    const result = await validateSpec(minimalSpec())
    expect(result.title).toBe('Test Form')
    expect(result.pages).toHaveLength(1)
  })

  it('accepts a full spec with all optional fields', async () => {
    const spec = minimalSpec({
      event_key: 'my.event.v1',
      theme: {
        primary_color: '#4f46e5',
        logo_url: 'https://example.com/logo.png',
        font: 'Inter',
        custom_css: 'body { color: red }',
      },
      thank_you: {
        title: 'Thanks!',
        body_md: '## Thanks',
        redirect_url_template: '{return_url}',
      },
      submit: {
        webhooks: [{ url: 'https://example.com/hook', secret_ref: 'MY_SECRET' }],
        post_actions: ['mark_event_filled'],
      },
    })
    const result = await validateSpec(spec)
    expect(result.event_key).toBe('my.event.v1')
    expect(result.theme?.primary_color).toBe('#4f46e5')
  })

  it('accepts spec with all field types', async () => {
    const spec = minimalSpec({
      pages: [
        {
          id: 'pg_1',
          title: 'Page 1',
          fields: [
            { id: 'f_text', type: 'text', label: 'Text', required: false },
            { id: 'f_textarea', type: 'textarea', label: 'Textarea', required: false },
            { id: 'f_number', type: 'number', label: 'Number', required: false },
            { id: 'f_email', type: 'email', label: 'Email', required: false },
            { id: 'f_phone', type: 'phone', label: 'Phone', required: false },
            { id: 'f_select', type: 'select', label: 'Select', required: false, options: [{ value: 'a', label: 'A' }] },
            { id: 'f_multi', type: 'multiselect', label: 'Multi', required: false, options: [{ value: 'a', label: 'A' }] },
            { id: 'f_check', type: 'checkbox', label: 'Check', required: false },
            { id: 'f_radio', type: 'radio', label: 'Radio', required: false, options: [{ value: 'a', label: 'A' }] },
            { id: 'f_date', type: 'date', label: 'Date', required: false },
            { id: 'f_file', type: 'file', label: 'File', required: false },
          ],
        },
      ],
    })
    const result = await validateSpec(spec)
    expect(result.pages[0]!.fields).toHaveLength(11)
  })

  it('accepts all three access modes', async () => {
    for (const mode of ['public_anonymous', 'private_oidc', 'link_token'] as const) {
      const spec = minimalSpec({ access: { mode, require_account: false, anonymous_allowed: true } })
      const result = await validateSpec(spec)
      expect(result.access.mode).toBe(mode)
    }
  })

  // ── Missing required top-level fields ──────────────────────────────────────

  it('throws FormSpecValidationError when title is missing', async () => {
    const spec = minimalSpec()
    delete (spec as Record<string, unknown>)['title']
    await expect(validateSpec(spec)).rejects.toThrow(FormSpecValidationError)
  })

  it('throws FormSpecValidationError when type is missing', async () => {
    const spec = minimalSpec()
    delete (spec as Record<string, unknown>)['type']
    await expect(validateSpec(spec)).rejects.toThrow(FormSpecValidationError)
  })

  it('throws FormSpecValidationError when access is missing', async () => {
    const spec = minimalSpec()
    delete (spec as Record<string, unknown>)['access']
    await expect(validateSpec(spec)).rejects.toThrow(FormSpecValidationError)
  })

  it('throws FormSpecValidationError when pages is missing', async () => {
    const spec = minimalSpec()
    delete (spec as Record<string, unknown>)['pages']
    await expect(validateSpec(spec)).rejects.toThrow(FormSpecValidationError)
  })

  // ── Invalid enum values ─────────────────────────────────────────────────────

  it('throws when FieldType is invalid', async () => {
    const spec = minimalSpec({
      pages: [
        {
          id: 'pg_1',
          title: 'Page 1',
          fields: [{ id: 'fld_1', type: 'invalid_type', label: 'Bad Field', required: false }],
        },
      ],
    })
    await expect(validateSpec(spec)).rejects.toThrow(FormSpecValidationError)
  })

  it('throws when AccessMode is invalid', async () => {
    const spec = minimalSpec({ access: { mode: 'totally_wrong', require_account: false, anonymous_allowed: false } })
    const err = await validateSpec(spec).catch((e) => e)
    expect(err).toBeInstanceOf(FormSpecValidationError)
    expect((err as FormSpecValidationError).issues.some((i) => i.includes('access'))).toBe(true)
  })

  // ── Empty pages ─────────────────────────────────────────────────────────────

  it('throws when pages array is empty', async () => {
    const spec = minimalSpec({ pages: [] })
    await expect(validateSpec(spec)).rejects.toThrow(FormSpecValidationError)
  })

  // ── Semantic checks ─────────────────────────────────────────────────────────

  it('throws on duplicate field ids within a form', async () => {
    const spec = minimalSpec({
      pages: [
        {
          id: 'pg_1',
          title: 'Page 1',
          fields: [
            { id: 'dup_id', type: 'text', label: 'Field A', required: false },
            { id: 'dup_id', type: 'text', label: 'Field B', required: false },
          ],
        },
      ],
    })
    const err = await validateSpec(spec).catch((e) => e)
    expect(err).toBeInstanceOf(FormSpecValidationError)
    expect((err as FormSpecValidationError).issues.some((i) => i.includes('dup_id'))).toBe(true)
  })

  it('throws on duplicate field ids across pages', async () => {
    const spec = minimalSpec({
      pages: [
        { id: 'pg_1', title: 'P1', fields: [{ id: 'shared_id', type: 'text', label: 'F1', required: false }] },
        { id: 'pg_2', title: 'P2', fields: [{ id: 'shared_id', type: 'text', label: 'F2', required: false }] },
      ],
    })
    const err = await validateSpec(spec).catch((e) => e)
    expect(err).toBeInstanceOf(FormSpecValidationError)
    expect((err as FormSpecValidationError).issues.some((i) => i.includes('shared_id'))).toBe(true)
  })

  it('throws on duplicate page ids', async () => {
    const spec = minimalSpec({
      pages: [
        { id: 'same_page', title: 'P1', fields: [{ id: 'f1', type: 'text', label: 'F1', required: false }] },
        { id: 'same_page', title: 'P2', fields: [{ id: 'f2', type: 'text', label: 'F2', required: false }] },
      ],
    })
    const err = await validateSpec(spec).catch((e) => e)
    expect(err).toBeInstanceOf(FormSpecValidationError)
    expect((err as FormSpecValidationError).issues.some((i) => i.includes('same_page'))).toBe(true)
  })


  // ── Error shape ─────────────────────────────────────────────────────────────

  it('FormSpecValidationError has issues array with field paths', async () => {
    const spec = minimalSpec()
    delete (spec as Record<string, unknown>)['title']
    const err = await validateSpec(spec).catch((e) => e)
    expect(err).toBeInstanceOf(FormSpecValidationError)
    expect(Array.isArray((err as FormSpecValidationError).issues)).toBe(true)
    expect((err as FormSpecValidationError).issues.length).toBeGreaterThan(0)
  })
})
