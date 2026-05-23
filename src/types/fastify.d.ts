// Module augmentation for Fastify instance and request decorators.
// Lane 4 owns the prisma declaration below.
// Lane 5a (Wave 2) adds auth decorators for both the L1 pattern and the
// cms-api-equivalent session pattern.

import type { PrismaClient } from '@prisma/client'
import type { AppAbility, PermissionKey } from '../core/auth/rbac.js'
import type { SessionPayload } from '../core/auth/types.js'

declare module 'fastify' {
  // ── Instance decorators ──────────────────────────────────────────────────

  interface FastifyInstance {
    /** Prisma client — added by prisma-plugin (Lane 4) */
    prisma: PrismaClient

    /**
     * preHandler: verifies the Bearer session JWT and attaches request.account.
     * Returns 401 if the token is missing or invalid.
     * Added by auth.plugin.ts (L1 pattern — /v1/auth/* routes).
     */
    authenticate(
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ): Promise<void>

    /**
     * Returns a preHandler that enforces the named CASL permission on
     * request.account.abilities. Must follow authenticate / maybeAuthenticate.
     */
    authorize(
      permission: PermissionKey,
    ): (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>

    /**
     * preHandler: attaches request.account if a valid Bearer token is present,
     * otherwise silently continues. For endpoints that serve both authenticated
     * and anonymous users.
     */
    maybeAuthenticate(
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ): Promise<void>

    /**
     * preHandler: break-glass check → JWT verify → sets request.session.
     * Added by plugins/auth.ts (L5a — /admin/session/* routes).
     */
    authenticate(
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ): Promise<void>
  }

  // ── Request decorators ───────────────────────────────────────────────────

  interface FastifyRequest {
    /**
     * Populated by authenticate or maybeAuthenticate (L1 pattern).
     * Undefined when no valid session token was provided.
     */
    account?: {
      sub: string
      email: string
      name: string
      roles: string[]
      abilities: AppAbility
    }

    /**
     * Populated by authenticate (L5a cms-api mirror).
     * Contains sub, roles, sid from the local HS256 JWT.
     */
    session: SessionPayload
  }
}
