/**
 * Role + Permission + AccountRole CRUD service.
 *
 * The seed defines four system roles (super-admin / editor / author / viewer)
 * with inline (action, subject) permissions. This service lets admins:
 *   - list/create/update/delete roles (system roles are read-only)
 *   - list all permission rows (for the multiselect picker)
 *   - grant/revoke roles to accounts
 *
 * The `Permission` model is not a global registry — each row is a per-role
 * grant. To produce a stable "permission key" the multiselect can render, we
 * collapse `action:subject` into one string the UI references.
 */
import type { PrismaClient } from '@prisma/client'

const SYSTEM_ROLE_NAMES = new Set(['super-admin', 'editor', 'author', 'viewer'])

export interface RoleSummary {
  id: string
  name: string
  description: string | null
  is_system: boolean
  permissions: { id: string; action: string; subject: string; key: string }[]
}

export class RoleService {
  constructor(private readonly prisma: PrismaClient) {}

  static isSystem(name: string): boolean {
    return SYSTEM_ROLE_NAMES.has(name)
  }

  async listRoles(): Promise<RoleSummary[]> {
    const roles = await this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { permissions: true },
    })
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description || null,
      is_system: r.isSystem,
      permissions: r.permissions.map((p) => ({
        id: p.id,
        action: p.action,
        subject: p.subject,
        key: `${p.action}:${p.subject}`,
      })),
    }))
  }

  async getRole(id: string): Promise<RoleSummary | null> {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: { permissions: true },
    })
    if (!role) return null
    return {
      id: role.id,
      name: role.name,
      description: role.description || null,
      is_system: role.isSystem,
      permissions: role.permissions.map((p) => ({
        id: p.id,
        action: p.action,
        subject: p.subject,
        key: `${p.action}:${p.subject}`,
      })),
    }
  }

  async createRole(input: {
    name: string
    description?: string | null
    permissionKeys: string[]
  }): Promise<RoleSummary> {
    if (RoleService.isSystem(input.name)) {
      const err = new Error('Cannot create a role with a system-reserved name') as Error & {
        code?: string
      }
      err.code = 'system_role'
      throw err
    }

    const role = await this.prisma.role.create({
      data: {
        name: input.name,
        description: input.description ?? '',
        isSystem: false,
      },
    })

    if (input.permissionKeys.length > 0) {
      await this.prisma.permission.createMany({
        data: input.permissionKeys.map((k) => {
          const [action, subject] = parseKey(k)
          return { roleId: role.id, action, subject }
        }),
      })
    }

    return (await this.getRole(role.id))!
  }

  async updateRole(
    id: string,
    patch: {
      description?: string | null
      permissionKeys?: string[]
    },
  ): Promise<RoleSummary | null> {
    const existing = await this.prisma.role.findUnique({ where: { id } })
    if (!existing) return null
    if (existing.isSystem && patch.permissionKeys) {
      const err = new Error('Cannot edit permissions on a system role') as Error & {
        code?: string
      }
      err.code = 'system_role'
      throw err
    }

    if (patch.description !== undefined) {
      await this.prisma.role.update({
        where: { id },
        data: { description: patch.description ?? '' },
      })
    }

    if (patch.permissionKeys) {
      await this.prisma.$transaction([
        this.prisma.permission.deleteMany({ where: { roleId: id } }),
        this.prisma.permission.createMany({
          data: patch.permissionKeys.map((k) => {
            const [action, subject] = parseKey(k)
            return { roleId: id, action, subject }
          }),
        }),
      ])
    }

    return this.getRole(id)
  }

  async deleteRole(id: string): Promise<boolean> {
    const existing = await this.prisma.role.findUnique({ where: { id } })
    if (!existing) return false
    if (existing.isSystem) {
      const err = new Error('Cannot delete a system role') as Error & { code?: string }
      err.code = 'system_role'
      throw err
    }
    await this.prisma.role.delete({ where: { id } })
    return true
  }

  // ── Permission catalog ───────────────────────────────────────────────────
  // The UI's permission multiselect wants a stable list of `{ key, description }`
  // strings to render. We aggregate every (action, subject) currently in use
  // across roles into a unique catalog. Built-in roles seed the canonical set;
  // any custom roles can also contribute.
  async listPermissionCatalog() {
    const rows = await this.prisma.permission.findMany({
      orderBy: [{ subject: 'asc' }, { action: 'asc' }],
    })
    const byKey = new Map<
      string,
      { id: string; key: string; description: string | null; action: string; subject: string }
    >()
    for (const r of rows) {
      const key = `${r.action}:${r.subject}`
      if (!byKey.has(key)) {
        byKey.set(key, {
          id: r.id, // representative — not stable, OK for picker
          key,
          description: describePermission(r.action, r.subject),
          action: r.action,
          subject: r.subject,
        })
      }
    }
    return Array.from(byKey.values())
  }

  // ── Account-role grants ──────────────────────────────────────────────────

  async grantRole(input: {
    accountId: string
    roleId: string
    grantedBy: string
  }) {
    const role = await this.prisma.role.findUnique({ where: { id: input.roleId } })
    if (!role) {
      const err = new Error('Role not found') as Error & { code?: string }
      err.code = 'role_not_found'
      throw err
    }
    return this.prisma.accountRole.upsert({
      where: {
        accountId_roleId: {
          accountId: input.accountId,
          roleId: input.roleId,
        },
      },
      create: {
        accountId: input.accountId,
        roleId: input.roleId,
        scopeJson: {},
        grantedBy: input.grantedBy,
        grantedAt: new Date(),
      },
      update: {
        grantedBy: input.grantedBy,
        grantedAt: new Date(),
      },
      include: { role: true },
    })
  }

  async revokeRole(accountId: string, roleId: string): Promise<boolean> {
    try {
      await this.prisma.accountRole.delete({
        where: { accountId_roleId: { accountId, roleId } },
      })
      return true
    } catch {
      return false
    }
  }

  async listAccountRoles(input: { accountId?: string; roleId?: string } = {}) {
    const where: Record<string, unknown> = {}
    if (input.accountId) where.accountId = input.accountId
    if (input.roleId) where.roleId = input.roleId
    const rows = await this.prisma.accountRole.findMany({
      where,
      orderBy: { grantedAt: 'desc' },
      include: { role: true },
    })
    return rows
  }
}

function parseKey(k: string): [string, string] {
  const idx = k.indexOf(':')
  if (idx <= 0) throw new Error(`Invalid permission key "${k}" — expected "action:subject"`)
  return [k.slice(0, idx), k.slice(idx + 1)]
}

function describePermission(action: string, subject: string): string {
  return `${humanize(action)} on ${humanize(subject)}`
}

function humanize(s: string): string {
  if (s === '*') return 'all'
  return s.replace(/[._-]/g, ' ')
}
