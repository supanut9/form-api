/**
 * GET /public/forms/:slug/prefill
 *
 * Layered prefill response:
 *
 *   1. Auth-derived defaults (`field.auth_field`) — every authenticated visit
 *      gets `account.email`/`name`/`sub` slotted into mapped fields. Always
 *      runs, regardless of `spec.prefill.mode`.
 *
 *   2. Prior submission (only when `spec.prefill.mode === 'last_submission'`).
 *      Filtered by per-field `prefill !== false`. Layered ON TOP of the
 *      auth-derived defaults, so a user's previously-edited value wins over
 *      their auth-server profile email.
 *
 * Returns 204 when both layers are empty. Soft-deleted submissions are
 * excluded.
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { FormService } from '../../core/forms/form.service.js'
import { formSpecSchema } from '../../core/forms/types.js'

const paramsSchema = z.object({ slug: z.string().min(1) })
const ANON_COOKIE = 'form_anon'

export const prefillPublicRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get(
    '/public/forms/:slug/prefill',
    {
      preHandler: [fastify.maybeAuthenticate],
      schema: {
        tags: ['public'],
        params: paramsSchema,
      },
    },
    async (request, reply) => {
      const formService = new FormService(app.prisma)
      const form = await formService.getFormWithCurrentVersion(request.params.slug)
      if (!form || !form.currentVersionRow) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Form not found' } })
      }

      const parsed = formSpecSchema.safeParse(form.currentVersionRow.specJson)
      if (!parsed.success) return reply.status(204).send()
      const spec = parsed.data

      const session = request.session ?? null
      const accountSub = session?.sub ?? null
      const anonToken = request.cookies?.[ANON_COOKIE] ?? null

      // ── 1. Auth-derived defaults ───────────────────────────────────────────
      const authDerived: Record<string, unknown> = {}
      if (session) {
        const profile: Record<'email' | 'name' | 'sub', string | undefined> = {
          email: session.email,
          name: session.name,
          sub: session.sub,
        }
        for (const page of spec.pages) {
          for (const f of page.fields) {
            const claim = (f as { auth_field?: 'email' | 'name' | 'sub' }).auth_field
            if (!claim) continue
            const value = profile[claim]
            if (value) authDerived[f.id] = value
          }
        }
      }

      // ── 2. Prior submission overlay (mode=last_submission only) ───────────
      const prefillCfg = spec.prefill
      let prior:
        | { id: string; submittedAt: Date; version: number; payloadJsonb: unknown }
        | null = null

      if (prefillCfg && prefillCfg.mode === 'last_submission') {
        const matchAuth =
          prefillCfg.identity === 'authenticated' || prefillCfg.identity === 'both'
        const matchAnon = prefillCfg.identity === 'both'

        let priorWhere:
          | { formId: string; deletedAt: null; accountId: string }
          | { formId: string; deletedAt: null; anonymousToken: string }
          | null = null
        if (matchAuth && accountSub) {
          priorWhere = { formId: form.id, deletedAt: null, accountId: accountSub }
        } else if (matchAnon && anonToken) {
          priorWhere = { formId: form.id, deletedAt: null, anonymousToken: anonToken }
        }

        if (priorWhere) {
          prior = await app.prisma.formSubmission.findFirst({
            where: priorWhere,
            orderBy: { submittedAt: 'desc' },
            select: {
              id: true,
              submittedAt: true,
              payloadJsonb: true,
              version: true,
            },
          })
        }
      }

      // Build the final payload: auth-derived first, prior submission overlays.
      const merged: Record<string, unknown> = { ...authDerived }
      if (prior) {
        const allowed = new Set<string>()
        for (const page of spec.pages) {
          for (const f of page.fields) {
            if ((f as { prefill?: boolean }).prefill !== false) {
              allowed.add(f.id)
            }
          }
        }
        const raw = (prior.payloadJsonb ?? {}) as Record<string, unknown>
        for (const [k, v] of Object.entries(raw)) {
          if (allowed.has(k) && v !== undefined && v !== '') {
            merged[k] = v
          }
        }
      }

      if (Object.keys(merged).length === 0) {
        return reply.status(204).send()
      }

      return {
        submission_id: prior?.id ?? null,
        submitted_at: prior?.submittedAt.toISOString() ?? null,
        version: prior?.version ?? null,
        payload: merged,
        sources: {
          auth: Object.keys(authDerived),
          prior_submission: prior ? Object.keys(merged).filter((k) => !(k in authDerived)) : [],
        },
      }
    },
  )
}

export default prefillPublicRoutes
