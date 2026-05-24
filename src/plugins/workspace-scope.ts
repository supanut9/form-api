/**
 * workspace-scope Fastify plugin (Phase 3C – L17).
 *
 * Registered AFTER auth plugin, BEFORE admin route registration.
 *
 * Resolution strategy: X-Workspace-Id header.
 *
 * Rationale: the existing admin routes all sit flat under /admin/*, e.g.
 * GET /admin/forms, POST /admin/forms. Introducing a /admin/w/:slug/... path
 * prefix would require touching every route across multiple lane ownerships.
 * The X-Workspace-Id header is zero-diff to existing routes and matches the
 * pattern used by multi-tenant SaaS APIs (Stripe, Linear, etc.).
 *
 * Backward-compatibility contract:
 *   • Header present → resolve by id or slug; 403 if not a member.
 *   • Header absent + account has exactly one workspace → auto-resolve.
 *   • Header absent + account has multiple workspaces → 400 workspace_required
 *     with list of accessible workspaces in the body.
 *   • Header absent + account has no workspace → workspaceId left undefined;
 *     pre-3C routes continue working without a filter.
 *   • Non-admin routes (no request.session) → this hook is a no-op.
 *
 * ALS scoping strategy:
 *   The onRequest hook detects that a workspace context will be needed and
 *   stores a context object on the request. A wrappedHandler wrapper would be
 *   cleaner, but Fastify 5 does not expose a route-handler wrapper hook.
 *   Instead we enter the ALS context in a preHandler and use
 *   workspaceStorage.enterWith() so the store remains active for the
 *   route handler that Fastify calls in the same async task chain.
 *   enterWith is safe because each HTTP request has its own V8 async context
 *   created by Fastify's onRequest lifecycle entry.
 */

import fp from 'fastify-plugin'
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify'
import type { WorkspaceRole } from '@prisma/client'
import { workspaceStorage } from '../lib/workspace-context.js'

// ---------------------------------------------------------------------------
// Fastify module augmentation
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved workspace id for this request (undefined on public routes). */
    workspaceId?: string
    /** Workspace role of the authenticated account (undefined when no workspace). */
    workspaceRole?: WorkspaceRole
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function workspaceScopePlugin(fastify: FastifyInstance): Promise<void> {
  // ── Hook 1: resolve workspace id + role ───────────────────────────────────
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only runs for authenticated admin requests — session must be set.
    if (!request.session?.sub) return

    const prisma = fastify.prisma
    const sub = request.session.sub

    const headerValue =
      (request.headers['x-workspace-id'] as string | undefined) ?? undefined

    let resolvedId: string | undefined
    let resolvedRole: WorkspaceRole | undefined

    if (headerValue) {
      // Header provided: look up by id or slug
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(headerValue)

      const workspace = await (prisma as any).workspace.findFirst({
        where: isUuid ? { id: headerValue } : { slug: headerValue },
        select: { id: true, slug: true },
      })

      if (!workspace) {
        return reply.status(404).send({
          error: { code: 'workspace_not_found', message: 'Workspace not found' },
        })
      }

      // Verify membership
      const member = await (prisma as any).workspaceMember.findUnique({
        where: {
          workspaceId_accountId: {
            workspaceId: workspace.id,
            accountId: sub,
          },
        },
        select: { role: true, joinedAt: true },
      })

      if (!member || !member.joinedAt) {
        return reply.status(403).send({
          error: { code: 'not_a_member', message: 'You are not a member of this workspace' },
        })
      }

      resolvedId = workspace.id as string
      resolvedRole = member.role as WorkspaceRole
    } else {
      // No header: auto-resolve based on membership count
      const memberships = await (prisma as any).workspaceMember.findMany({
        where: {
          accountId: sub,
          joinedAt: { not: null },
          workspace: { archivedAt: null },
        },
        select: {
          workspaceId: true,
          role: true,
          workspace: { select: { id: true, slug: true } },
        },
      })

      if (memberships.length === 1) {
        const m = memberships[0]
        resolvedId = m.workspaceId as string
        resolvedRole = m.role as WorkspaceRole
      } else if (memberships.length > 1) {
        return reply.status(400).send({
          error: {
            code: 'workspace_required',
            message:
              'This account belongs to multiple workspaces. Provide X-Workspace-Id header.',
            workspaces: memberships.map(
              (m: { workspaceId: string; workspace: { slug: string } }) => ({
                id: m.workspaceId,
                slug: m.workspace.slug,
              }),
            ),
          },
        })
      }
      // memberships.length === 0: resolvedId stays undefined — pre-3C compat
    }

    request.workspaceId = resolvedId
    request.workspaceRole = resolvedRole
  })

  // ── Hook 2: enter ALS workspace context for the route handler ─────────────
  // This runs after Hook 1 in the same preHandler queue, so request.workspaceId
  // is already populated. enterWith() modifies the store for the current async
  // context. Because Fastify's request lifecycle runs each request in its own
  // AsyncResource context (created at onRequest), enterWith here does NOT bleed
  // into other concurrent requests — it is request-scoped by construction.
  fastify.addHook('preHandler', (request: FastifyRequest, _reply: FastifyReply, done) => {
    if (request.workspaceId) {
      workspaceStorage.enterWith({ workspaceId: request.workspaceId })
    }
    done()
  })
}

export default fp(workspaceScopePlugin, {
  name: 'workspace-scope',
  fastify: '5.x',
  dependencies: ['prisma-plugin', 'form-auth-session'],
})
