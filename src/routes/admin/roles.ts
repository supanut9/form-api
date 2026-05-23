/**
 * Admin role + permission + account-role endpoints.
 *
 *   GET    /admin/roles                                  → list roles
 *   POST   /admin/roles                                  → create role
 *   PATCH  /admin/roles/:id                              → update role
 *   DELETE /admin/roles/:id                              → delete role (non-system)
 *
 *   GET    /admin/permissions                            → permission catalog
 *
 *   POST   /admin/account-roles                          → grant role to account
 *   DELETE /admin/account-roles/:accountId/:roleId       → revoke
 *   GET    /admin/account-roles                          → list grants (optional ?role_id, ?account_id)
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requirePermission } from '../../core/auth/rbac.js'
import { RoleService } from '../../core/rbac/role.service.js'
import { AuditService } from '../../core/audit/audit.service.js'

const roleIdParamsSchema = z.object({ id: z.string().uuid() })
const accountRoleParamsSchema = z.object({
  accountId: z.string().min(1),
  roleId: z.string().uuid(),
})

const createRoleBodySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_-]*$/, 'role name must be lowercase, start with a letter'),
  description: z.string().max(500).nullable().optional(),
  permission_ids: z.array(z.string()).default([]),
})

const updateRoleBodySchema = z.object({
  description: z.string().max(500).nullable().optional(),
  permission_keys: z.array(z.string()).optional(),
})

const grantBodySchema = z.object({
  account_id: z.string().min(1),
  role_id: z.string().uuid(),
})

const listGrantsQuerySchema = z.object({
  account_id: z.string().optional(),
  role_id: z.string().uuid().optional(),
})

export const rolesAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  // ── Roles ────────────────────────────────────────────────────────────────

  app.get(
    '/admin/roles',
    {
      preHandler: [fastify.authenticate, requirePermission('read', 'Role')],
      schema: { tags: ['admin', 'rbac'] },
    },
    async () => new RoleService(app.prisma).listRoles(),
  )

  app.get(
    '/admin/roles/:id',
    {
      preHandler: [fastify.authenticate, requirePermission('read', 'Role')],
      schema: { tags: ['admin', 'rbac'], params: roleIdParamsSchema },
    },
    async (request, reply) => {
      const role = await new RoleService(app.prisma).getRole(request.params.id)
      if (!role) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Role not found' } })
      }
      return role
    },
  )

  app.post(
    '/admin/roles',
    {
      preHandler: [fastify.authenticate, requirePermission('manage', 'Role')],
      schema: { tags: ['admin', 'rbac'], body: createRoleBodySchema },
    },
    async (request, reply) => {
      const service = new RoleService(app.prisma)
      try {
        const role = await service.createRole({
          name: request.body.name,
          description: request.body.description,
          // UI sends permission *keys* under either `permission_ids` (legacy)
          // or `permission_keys`. We accept both transparently here.
          permissionKeys: request.body.permission_ids,
        })
        void new AuditService(app.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'role.create',
          subjectType: 'Role',
          subjectId: role.id,
          diff: { name: role.name, permissions: request.body.permission_ids },
        })
        return reply.status(201).send(role)
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'system_role') {
          return reply
            .status(400)
            .send({ error: { code: 'system_role', message: e.message } })
        }
        if ((err as { code?: string }).code === 'P2002') {
          return reply
            .status(409)
            .send({ error: { code: 'name_taken', message: 'Role name already exists' } })
        }
        throw err
      }
    },
  )

  app.patch(
    '/admin/roles/:id',
    {
      preHandler: [fastify.authenticate, requirePermission('manage', 'Role')],
      schema: {
        tags: ['admin', 'rbac'],
        params: roleIdParamsSchema,
        body: updateRoleBodySchema,
      },
    },
    async (request, reply) => {
      const service = new RoleService(app.prisma)
      try {
        const role = await service.updateRole(request.params.id, {
          description: request.body.description,
          permissionKeys: request.body.permission_keys,
        })
        if (!role) {
          return reply
            .status(404)
            .send({ error: { code: 'not_found', message: 'Role not found' } })
        }
        void new AuditService(app.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'role.update',
          subjectType: 'Role',
          subjectId: role.id,
          diff: {
            description: request.body.description,
            permission_keys: request.body.permission_keys,
          },
        })
        return role
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'system_role') {
          return reply
            .status(400)
            .send({ error: { code: 'system_role', message: e.message } })
        }
        throw err
      }
    },
  )

  app.delete(
    '/admin/roles/:id',
    {
      preHandler: [fastify.authenticate, requirePermission('manage', 'Role')],
      schema: { tags: ['admin', 'rbac'], params: roleIdParamsSchema },
    },
    async (request, reply) => {
      const service = new RoleService(app.prisma)
      try {
        const ok = await service.deleteRole(request.params.id)
        if (!ok) {
          return reply
            .status(404)
            .send({ error: { code: 'not_found', message: 'Role not found' } })
        }
        void new AuditService(app.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'role.delete',
          subjectType: 'Role',
          subjectId: request.params.id,
        })
        return reply.status(204).send()
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'system_role') {
          return reply
            .status(400)
            .send({ error: { code: 'system_role', message: e.message } })
        }
        throw err
      }
    },
  )

  // ── Permissions catalog ──────────────────────────────────────────────────

  app.get(
    '/admin/permissions',
    {
      preHandler: [fastify.authenticate, requirePermission('read', 'Role')],
      schema: { tags: ['admin', 'rbac'] },
    },
    async () => new RoleService(app.prisma).listPermissionCatalog(),
  )

  // ── Account-role grants ──────────────────────────────────────────────────

  app.post(
    '/admin/account-roles',
    {
      preHandler: [fastify.authenticate, requirePermission('manage', 'Role')],
      schema: { tags: ['admin', 'rbac'], body: grantBodySchema },
    },
    async (request, reply) => {
      const service = new RoleService(app.prisma)
      try {
        const grant = await service.grantRole({
          accountId: request.body.account_id,
          roleId: request.body.role_id,
          grantedBy: request.session?.sub ?? 'system',
        })
        void new AuditService(app.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'role.grant',
          subjectType: 'AccountRole',
          subjectId: `${grant.accountId}:${grant.roleId}`,
          diff: { account_id: grant.accountId, role_id: grant.roleId },
        })
        return reply.status(201).send({
          account_id: grant.accountId,
          role_id: grant.roleId,
          granted_at: grant.grantedAt.toISOString(),
          role: {
            id: grant.role.id,
            name: grant.role.name,
            description: grant.role.description || null,
          },
        })
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'role_not_found') {
          return reply
            .status(404)
            .send({ error: { code: 'role_not_found', message: e.message } })
        }
        throw err
      }
    },
  )

  app.delete(
    '/admin/account-roles/:accountId/:roleId',
    {
      preHandler: [fastify.authenticate, requirePermission('manage', 'Role')],
      schema: { tags: ['admin', 'rbac'], params: accountRoleParamsSchema },
    },
    async (request, reply) => {
      const service = new RoleService(app.prisma)
      const ok = await service.revokeRole(
        request.params.accountId,
        request.params.roleId,
      )
      if (!ok) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Grant not found' } })
      }
      void new AuditService(app.prisma).record({
        actorAccountId: request.session?.sub ?? null,
        action: 'role.revoke',
        subjectType: 'AccountRole',
        subjectId: `${request.params.accountId}:${request.params.roleId}`,
      })
      return reply.status(204).send()
    },
  )

  app.get(
    '/admin/account-roles',
    {
      preHandler: [fastify.authenticate, requirePermission('read', 'Role')],
      schema: {
        tags: ['admin', 'rbac'],
        querystring: listGrantsQuerySchema,
      },
    },
    async (request) => {
      const service = new RoleService(app.prisma)
      const rows = await service.listAccountRoles({
        accountId: request.query.account_id,
        roleId: request.query.role_id,
      })
      return rows.map((r) => ({
        account_id: r.accountId,
        role_id: r.roleId,
        granted_at: r.grantedAt.toISOString(),
        granted_by: r.grantedBy,
        role: {
          id: r.role.id,
          name: r.role.name,
          description: r.role.description || null,
        },
      }))
    },
  )
}

export default rolesAdminRoutes
