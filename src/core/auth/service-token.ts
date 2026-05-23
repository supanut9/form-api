/**
 * Service-token (`fak_…`) gate for internal endpoints.
 *
 * Usage:
 *   app.get(
 *     '/internal/foo',
 *     { preHandler: [requireServiceToken('events.read')] },
 *     handler,
 *   )
 *
 * The preHandler:
 *   1. Reads `Authorization: Bearer <token>` (no cookie fallback — internal
 *      callers are services, not browsers).
 *   2. Resolves via TokenService.verifyToken (sha256 lookup, revoked/expired
 *      checks).
 *   3. Optionally enforces that the token's scopes array contains the
 *      required scope. Special-cased: token type `admin` bypasses scope
 *      checks (admin tokens get everything).
 *   4. Attaches the row to `request.serviceToken` for handlers that want it.
 *
 * Audit: the lookup itself isn't logged — too noisy. Mutations called by
 * internal endpoints (e.g. webhook replay) should record their own audit
 * rows using the token's id as a marker.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { TokenService } from '../tokens/token.service.js'
import type { ApiToken } from '@prisma/client'

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by requireServiceToken when authentication succeeds. */
    serviceToken?: ApiToken
  }
}

export function requireServiceToken(requiredScope?: string): preHandlerHookHandler {
  return async function serviceTokenPreHandler(
    this: { prisma: import('@prisma/client').PrismaClient },
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const header = request.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return reply
        .code(401)
        .send({ error: { code: 'missing_token', message: 'Bearer token required' } })
    }
    const raw = header.slice(7).trim()

    const service = new TokenService(this.prisma)
    const row = await service.verifyToken(raw)
    if (!row) {
      return reply
        .code(401)
        .send({ error: { code: 'invalid_token', message: 'Token rejected' } })
    }

    if (requiredScope && row.type !== 'admin') {
      const scopes = Array.isArray(row.scopesJson) ? (row.scopesJson as string[]) : []
      if (!scopes.includes(requiredScope) && !scopes.includes('*')) {
        return reply.code(403).send({
          error: {
            code: 'insufficient_scope',
            message: `Token missing required scope: ${requiredScope}`,
          },
        })
      }
    }

    request.serviceToken = row
  }
}
