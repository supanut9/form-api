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
import { stripSkippedFields } from '../../core/submissions/payload.validator.js'
import { PaymentService } from '../../core/payments/payment.service.js'

const ANON_COOKIE = 'form_anon'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (s: string) => UUID_RE.test(s)
const paramsSchema = z.object({ slug: z.string().min(1) })
const bodySchema = z.object({
  payload: z.record(z.string(), z.unknown()).default({}),
  event_key: z.string().optional(),
  return_url: z.string().optional(),
  payment_intent_id: z.string().optional(),
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
      // Cast spec to include Phase 3B payment extension (keys are passthrough-safe
      // via formSpecSchema.passthrough; the payment sub-object is validated below).
      const spec = specParsed.data as typeof specParsed.data & {
        payment?: {
          mode?: string
          currency?: string
          amount_minor?: number
          capture_intent?: string
          stripe_account_id?: string
          required_for_submit?: boolean
        }
      }

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
      const knownOnly: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(request.body.payload)) {
        if (fieldIds.has(k)) knownOnly[k] = v
      }

      // ── Phase 3B: payment gate ──────────────────────────────────────────────
      // If the spec requires payment, the body MUST include payment_intent_id.
      // Actual intent verification happens AFTER the submission row exists so
      // we can write the FormPayment FK. If verification fails we hard-delete
      // the orphaned submission row and return 402.
      const paymentRequired = spec.payment?.required_for_submit === true
      if (paymentRequired && !request.body.payment_intent_id) {
        return reply.status(400).send({
          error: {
            code: 'payment_required',
            message: 'payment_intent_id is required for this form',
          },
        })
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
            payloadJsonb: knownOnly as object,
            ipHash,
            userAgent: ua,
            source: 'link',
            status: 'submitted',
          },
          select: { id: true, submittedAt: true },
        })
      })

      // Phase 3A: re-derive page visibility server-side and strip any fields
      // belonging to pages the user shouldn't have reached. Writes a
      // submission.skipped_fields_stripped audit row on detection. Audit
      // failures are swallowed inside the helper.
      const { sanitized: visitedOnly } = await stripSkippedFields(
        // Zod-parsed spec satisfies the runner's FullSpec shape at runtime
        // (scoring.then refinement enforces at least one of add|set).
        spec as unknown as Parameters<typeof stripSkippedFields>[0],
        knownOnly,
        form.id,
        form.currentVersion,
        app.prisma,
        submission.id,
        accountSub ?? null,
      )
      if (
        Object.keys(visitedOnly).length !== Object.keys(knownOnly).length
      ) {
        await app.prisma.formSubmission.update({
          where: { id: submission.id },
          data: { payloadJsonb: visitedOnly as object },
        })
      }

      // ── Phase 3B: record payment after submission row exists ────────────────
      // Re-verify the PaymentIntent server-side (never trust the client claim).
      // On failure: hard-delete the orphaned submission row and return 402.
      if (paymentRequired && request.body.payment_intent_id) {
        const paymentService = new PaymentService(app.prisma)
        try {
          await paymentService.recordPaymentForSubmission({
            submissionId: submission.id,
            paymentIntentId: request.body.payment_intent_id,
            stripeAccountId: spec.payment?.stripe_account_id ?? null,
          })
        } catch (err: unknown) {
          const e = err as Error & { code?: string }
          // Roll back: delete the orphaned submission row.
          await app.prisma.formSubmission.delete({ where: { id: submission.id } }).catch(() => {})
          if (e.code === 'intent_not_succeeded') {
            return reply.status(402).send({
              error: {
                code: 'payment_not_captured',
                message: 'The payment intent has not been captured',
              },
            })
          }
          throw err
        }

        // Audit the payment record event.
        void new AuditService(app.prisma).record({
          actorAccountId: accountSub ?? null,
          action: 'submission.payment_recorded',
          subjectType: 'Submission',
          subjectId: submission.id,
          diff: {
            payment_intent_id: request.body.payment_intent_id,
            form_id: form.id,
          },
        })
      }

      // Link any uploaded files referenced in the payload to this submission.
      // File fields carry the file_id (UUID string) returned by the presign
      // flow. We pluck all field values whose spec field type is 'file' and
      // attach them to this submission so they aren't garbage-collected as
      // orphans.
      const fileIds: string[] = []
      for (const page of spec.pages) {
        for (const f of page.fields) {
          if (f.type !== 'file') continue
          const v = visitedOnly[f.id]
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
            payload: visitedOnly,
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
