/**
 * Shared types for form CRUD and version management.
 * Used by form.service.ts, version.service.ts, and the admin route plugins.
 *
 * The FormSpec / FormPage / FormField shapes match form-plan §4.1 and mirror
 * packages/form-renderer/src/types.ts (the public renderer's input shape).
 */

import type { FormDefinition } from '@prisma/client'
import { z } from 'zod'
import {
  CalculationsSchema,
  ScoringSchema,
  ActionsSchema,
} from './spec-3a.js'

// ── Domain row aliases ────────────────────────────────────────────────────────

export type FormSummary = FormDefinition

export interface CurrentVersionRow {
  id: string
  formId: string
  version: number
  specJson: unknown
  schemaHash: string
  publishedAt: Date
  publishedBy: string
  isCurrent: boolean
}

export interface FormWithCurrentVersion extends FormDefinition {
  currentVersionRow: CurrentVersionRow | null
}

// ── FormSpec — the JSON document stored in form_versions.spec_json ────────────

export const fieldTypeSchema = z.enum([
  'text', 'textarea', 'number', 'email', 'phone',
  'select', 'multiselect', 'checkbox', 'radio', 'date', 'file',
])

export const selectOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
})

export const fieldSpecSchema = z
  .object({
    id: z.string().min(1),
    type: fieldTypeSchema,
    label: z.string().min(1),
    required: z.boolean().optional(),
    helpText: z.string().optional(),
    options: z.array(selectOptionSchema).optional(),
    // show_if: a json-logic rule. Validation of the rule shape itself happens
    // inside spec.validator.ts at the semantic-pass step.
    show_if: z.unknown().optional(),
    // prefill opt-out: when the form's prefill.mode === 'last_submission',
    // setting this to false keeps the field blank on revisit. Default: true.
    prefill: z.boolean().optional(),
    // Phase-2-lite auth mapping: pulls the user's OIDC profile claim into
    // this field as a fallback default when the visitor is authenticated.
    auth_field: z.enum(['email', 'name', 'sub']).optional(),
  })
  // Keep extra keys so the renderer-specific properties (placeholder, rows,
  // validation, etc.) round-trip through Prisma + the spec validator.
  .passthrough()

export const accessSpecSchema = z.object({
  mode: z.enum(['public_anonymous', 'private_oidc', 'link_token']),
  require_account: z.boolean().optional(),
})

export const themeSpecSchema = z
  .object({
    primary_color: z.string().optional(),
    logo_url: z.string().url().optional(),
    font: z.string().optional(),
    custom_css: z.string().optional(),
  })
  .optional()

export const pageSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  fields: z.array(fieldSpecSchema),
  show_if: z.unknown().optional(),
})

export const thankYouSpecSchema = z.object({
  title: z.string(),
  body_md: z.string(),
  redirect_url_template: z.string().optional(),
})

export const submitConfigSchema = z.object({
  webhooks: z
    .array(
      z.object({
        url: z.string().url(),
        secret_ref: z.string(),
      }),
    )
    .optional(),
  post_actions: z.array(z.string()).optional(),
})

export const prefillConfigSchema = z.object({
  mode: z.enum(['none', 'last_submission']).default('none'),
  identity: z.enum(['authenticated', 'both']).default('authenticated'),
  submit_behavior: z.enum(['append', 'replace']).default('append'),
})

export const formSpecSchema = z.object({
  id: z.string().min(1).optional(),
  version: z.number().int().positive().optional(),
  title: z.string().min(1),
  type: z.enum(['main', 'dynamic']),
  access: accessSpecSchema,
  event_key: z.string().optional(),
  theme: themeSpecSchema,
  pages: z.array(pageSpecSchema).min(1),
  thank_you: thankYouSpecSchema.optional(),
  submit: submitConfigSchema.optional(),
  prefill: prefillConfigSchema.optional(),
  // ── Phase 3A extensions (optional; missing keys = Phase-1 spec, still valid)
  calculations: CalculationsSchema.optional(),
  scoring: ScoringSchema.optional(),
  actions: ActionsSchema.optional(),
})

export type FieldSpec = z.infer<typeof fieldSpecSchema>
export type PageSpec = z.infer<typeof pageSpecSchema>
export type FormSpec = z.infer<typeof formSpecSchema>

// ── canonical JSON (for schema-hash determinism) ──────────────────────────────

/**
 * Deterministic JSON string: keys sorted alphabetically at every depth.
 * Used by version.service to compute a stable sha256 of a FormSpec so the
 * hash doesn't drift when admins re-save with re-ordered keys.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys.map(
    (k) =>
      `${JSON.stringify(k)}:${canonicalJson(
        (value as Record<string, unknown>)[k],
      )}`,
  )
  return `{${parts.join(',')}}`
}
