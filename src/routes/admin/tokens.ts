/**
 * Admin endpoints for API token CRUD.
 *
 *   POST   /admin/tokens         → create (returns raw `token` ONCE)
 *   GET    /admin/tokens         → list active tokens (?include_revoked=true)
 *   POST   /admin/tokens/:id/revoke → mark revoked
 *   DELETE /admin/tokens/:id     → hard delete
 *
 * The settings/api-tokens page expects the create response shape
 * `{ token, row }`. The row uses `scopes_json` (snake_case) and the snake_case
 * timestamps to match the UI's TypeScript interface.
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requirePermission } from '../../core/auth/rbac.js'
import { TokenService } from '../../core/tokens/token.service.js'
import { AuditService } from '../../core/audit/audit.service.js'

const idParamsSchema = z.object({ id: z.string().uuid() })

const TOKEN_TYPES = ['admin', 'webhook_caller', 'public_read'] as const

const createBodySchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(TOKEN_TYPES),
  scopes: z.array(z.string().min(1)).min(1),
  expires_at: z.string().datetime().nullable().optional(),
})

const listQuerySchema = z.object({
  include_revoked: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
})

function serialize(row: {
  id: string
  name: string
  type: 'admin' | 'webhook_caller' | 'public_read'
  scopesJson: unknown
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    scopes_json: Array.isArray(row.scopesJson) ? (row.scopesJson as string[]) : [],
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  }
}

export const tokensAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/admin/tokens',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('manage', 'ApiToken'),
      ],
      schema: { tags: ['admin', 'tokens'], body: createBodySchema },
    },
    async (request, reply) => {
      const service = new TokenService(app.prisma)
      const { token, row } = await service.issueToken({
        name: request.body.name,
        type: request.body.type,
        scopes: request.body.scopes,
        expiresAt: request.body.expires_at
          ? new Date(request.body.expires_at)
          : null,
      })
      void new AuditService(app.prisma).record({
        actorAccountId: request.session?.sub ?? null,
        action: 'token.create',
        subjectType: 'ApiToken',
        subjectId: row.id,
        diff: {
          name: row.name,
          type: row.type,
          scopes: request.body.scopes,
          expires_at: row.expiresAt?.toISOString() ?? null,
        },
      })
      return reply.status(201).send({ token, row: serialize(row) })
    },
  )

  app.get(
    '/admin/tokens',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'ApiToken'),
      ],
      schema: { tags: ['admin', 'tokens'], querystring: listQuerySchema },
    },
    async (request) => {
      const service = new TokenService(app.prisma)
      const rows = await service.listTokens(request.query.include_revoked === true)
      return rows.map(serialize)
    },
  )

  app.post(
    '/admin/tokens/:id/revoke',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('manage', 'ApiToken'),
      ],
      schema: { tags: ['admin', 'tokens'], params: idParamsSchema },
    },
    async (request, reply) => {
      const service = new TokenService(app.prisma)
      const row = await service.revokeToken(request.params.id)
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Token not found' } })
      }
      void new AuditService(app.prisma).record({
        actorAccountId: request.session?.sub ?? null,
        action: 'token.revoke',
        subjectType: 'ApiToken',
        subjectId: row.id,
      })
      return serialize(row)
    },
  )

  app.delete(
    '/admin/tokens/:id',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('manage', 'ApiToken'),
      ],
      schema: { tags: ['admin', 'tokens'], params: idParamsSchema },
    },
    async (request, reply) => {
      const service = new TokenService(app.prisma)
      const ok = await service.deleteToken(request.params.id)
      if (!ok) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Token not found' } })
      }
      return reply.status(204).send()
    },
  )
}

export default tokensAdminRoutes
