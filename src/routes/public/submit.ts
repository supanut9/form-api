/**
 * POST /public/forms/:slug/submit
 *
 * Validates payload against the form's current published spec, then writes a
 * FormSubmission row. Enforces access.mode for authenticated/anonymous gating.
 * Phase-1: no file resolution, no webhooks (those land in later lanes).
 */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { FormService } from '../../core/forms/form.service.js'
import { formSpecSchema } from '../../core/forms/types.js'
import { FillService } from '../../core/events/fill.service.js'
import { WebhookService } from '../../core/webhooks/webhook.service.js'
import { FileService } from '../../core/files/file.service.js'
import { AuditService } from '../../core/audit/audit.service.js'

const ANON_COOKIE = 'form_anon'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (s: string) => UUID_RE.test(s)
const paramsSchema = z.object({ slug: z.string().min(1) })
const bodySchema = z.object({
  payload: z.record(z.string(), z.unknown()).default({}),
  event_key: z.string().optional(),
  return_url: z.string().optional(),
})

function hashIp(ip: string | undefined): string {
  const day = new Date().toISOString().slice(0, 10)
  return createHash('sha256').update(`${ip ?? ''}|${day}`).digest('hex').slice(0, 32)
}

export const submitPublicRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/public/forms/:slug/submit',
    {
      preHandler: [fastify.maybeAuthenticate],
      schema: {
        tags: ['public'],
        description: 'Submit a form. Public endpoint — access enforced by spec.',
        params: paramsSchema,
        body: bodySchema,
      },
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const service = new FormService(app.prisma)
      const form = await service.getFormWithCurrentVersion(request.params.slug)
      if (!form || !form.currentVersionRow) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Form not found or not published' } })
      }

      // Validate the cached spec shape (defensive — already validated on publish).
      const specParsed = formSpecSchema.safeParse(form.currentVersionRow.specJson)
      if (!specParsed.success) {
        return reply
          .status(500)
          .send({ error: { code: 'spec_invalid', message: 'Published spec is invalid' } })
      }
      const spec = specParsed.data

      // Resolve identity per access.mode.
      const accountSub = request.session?.sub ?? null
      let anonymousToken = request.cookies?.[ANON_COOKIE] ?? null

      if (spec.access.mode === 'private_oidc' && !accountSub) {
        return reply
          .status(401)
          .send({ error: { code: 'unauthorized', message: 'Login required' } })
      }
      if (!accountSub && !anonymousToken) {
        anonymousToken = randomUUID()
        reply.setCookie(ANON_COOKIE, anonymousToken, {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: 60 * 60 * 24 * 180,
        })
      }

      // Minimal payload validation — only required-field presence for now.
      // Deeper rule + show_if evaluation comes when the shared evaluator lands.
      const fieldIds = new Set<string>()
      const missing: string[] = []
      for (const page of spec.pages) {
        for (const f of page.fields) {
          fieldIds.add(f.id)
          if (f.required) {
            const v = request.body.payload[f.id]
            if (v === undefined || v === null || v === '') missing.push(f.id)
          }
        }
      }
      if (missing.length > 0) {
        return reply.status(400).send({
          error: {
            code: 'validation_failed',
            message: 'Required fields missing',
            details: missing,
          },
        })
      }

      // Strip unknown keys (defense against malicious payloads).
      const sanitized: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(request.body.payload)) {
        if (fieldIds.has(k)) sanitized[k] = v
      }

      const ipHash = hashIp(request.ip)
      const ua = String(request.headers['user-agent'] ?? '').slice(0, 512)

      // If the spec opts into replace-on-resubmit, soft-delete prior live
      // submissions by this identity before inserting the new row. Done in a
      // single transaction so a failure mid-way doesn't leave the form in a
      // half-state.
      const submission = await app.prisma.$transaction(async (tx) => {
        if (
          spec.prefill?.submit_behavior === 'replace' &&
          (accountSub || anonymousToken)
        ) {
          const priorWhere = accountSub
            ? { formId: form.id, deletedAt: null, accountId: accountSub }
            : {
                formId: form.id,
                deletedAt: null,
                anonymousToken: anonymousToken!,
              }
          await tx.formSubmission.updateMany({
            where: priorWhere,
            data: { deletedAt: new Date() },
          })
        }
        return tx.formSubmission.create({
          data: {
            formId: form.id,
            version: form.currentVersion,
            accountId: accountSub ?? null,
            anonymousToken: accountSub ? null : anonymousToken,
            payloadJsonb: sanitized as object,
            ipHash,
            userAgent: ua,
            source: 'link',
            status: 'submitted',
          },
          select: { id: true, submittedAt: true },
        })
      })

      // Link any uploaded files referenced in the payload to this submission.
      // File fields carry the file_id (UUID string) returned by the presign
      // flow. We pluck all field values whose spec field type is 'file' and
      // attach them to this submission so they aren't garbage-collected as
      // orphans.
      const fileIds: string[] = []
      for (const page of spec.pages) {
        for (const f of page.fields) {
          if (f.type !== 'file') continue
          const v = sanitized[f.id]
          if (typeof v === 'string' && isUuid(v)) fileIds.push(v)
          else if (Array.isArray(v)) {
            for (const item of v) if (typeof item === 'string' && isUuid(item)) fileIds.push(item)
          }
        }
      }
      if (fileIds.length > 0) {
        const fileService = new FileService(app.prisma)
        await fileService.linkToSubmission(fileIds, submission.id).catch((err) => {
          fastify.log.warn({ err, file_ids: fileIds }, 'file link failed (non-fatal)')
        })
      }

      // Record event fill if the request supplies an event_key bound to this form.
      // Caller is trusted to supply the right key — defensive check verifies the
      // event exists *and* is bound to this form before writing the fill row.
      if (request.body.event_key) {
        const ev = await app.prisma.formEvent.findUnique({
          where: { eventKey: request.body.event_key },
          select: { eventKey: true, formId: true },
        })
        if (ev && ev.formId === form.id) {
          const fillService = new FillService(app.prisma)
          await fillService.markFilled({
            eventKey: ev.eventKey,
            submissionId: submission.id,
            identity: {
              accountId: accountSub ?? null,
              anonymousToken: accountSub ? null : anonymousToken,
            },
          })
        } else {
          fastify.log.warn(
            { event_key: request.body.event_key, form_id: form.id },
            'submit referenced unknown or mismatched event_key — fill not recorded',
          )
        }
      }

      // Record an audit entry (append-only; safe to do after the main write).
      void new AuditService(app.prisma).record({
        actorAccountId: accountSub ?? null,
        action: 'submission.create',
        subjectType: 'Submission',
        subjectId: submission.id,
        diff: {
          form_id: form.id,
          form_slug: form.slug,
          version: form.currentVersion,
          source: 'link',
          event_key: request.body.event_key ?? null,
          anonymous: !accountSub,
        },
      })

      // Enqueue webhook deliveries via BullMQ. The actual HTTP POST is handled
      // by the webhook worker process (pnpm worker). Failures are surfaced
      // through admin's deliveries view; submitters never wait on receivers.
      const webhookService = new WebhookService(app.prisma)
      const eventKeyForHook = request.body.event_key ?? null
      webhookService
        .enqueueOnSubmit({
          formId: form.id,
          submissionId: submission.id,
          payload: {
            event: 'submitted',
            form_id: form.id,
            form_slug: form.slug,
            version: form.currentVersion,
            submission_id: submission.id,
            event_key: eventKeyForHook,
            account_id: accountSub ?? null,
            anonymous_token: accountSub ? null : anonymousToken,
            submitted_at: submission.submittedAt.toISOString(),
            payload: sanitized,
          },
        })
        .catch((err) => {
          fastify.log.warn({ err }, 'webhook enqueue failed (non-fatal)')
        })

      // Resolve redirect: spec.thank_you.redirect_url_template overrides
      // {return_url} and {event_key} placeholders when provided by caller.
      let redirectUrl: string | undefined
      if (spec.thank_you?.redirect_url_template) {
        redirectUrl = spec.thank_you.redirect_url_template
          .replace('{return_url}', request.body.return_url ?? '')
          .replace('{event_key}', request.body.event_key ?? '')
      } else if (request.body.return_url) {
        redirectUrl = request.body.return_url
      }

      return {
        submission_id: submission.id,
        thank_you: spec.thank_you ?? null,
        redirect_url: redirectUrl ?? null,
      }
    },
  )
}

export default submitPublicRoutes
