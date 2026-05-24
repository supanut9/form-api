/**
 * WorkspaceService — CRUD, membership, and invitation management.
 *
 * Phase 3C – L17.
 *
 * Audit rows are written for: workspace.created, workspace.member_added,
 * workspace.invitation_sent, workspace.invitation_accepted.
 *
 * Slug derivation uses slugify@1.6.9.
 * Invitation tokens use crypto.randomBytes(32); only the SHA-256 hash is stored.
 */

import crypto from 'node:crypto'
import slugify from 'slugify'
import type { PrismaClient } from '@prisma/client'
import { AuditService } from '../audit/audit.service.js'

// Re-export for convenience
export { WorkspaceRole } from '@prisma/client'
import { type WorkspaceRole } from '@prisma/client'

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function notFoundError(entity: string, id: string): Error & { code: string; statusCode: number } {
  const err = new Error(`${entity} not found: ${id}`) as Error & {
    code: string
    statusCode: number
  }
  err.code = `${entity.toLowerCase()}_not_found`
  err.statusCode = 404
  return err
}

function conflictError(message: string, code: string): Error & { code: string; statusCode: number } {
  const err = new Error(message) as Error & { code: string; statusCode: number }
  err.code = code
  err.statusCode = 409
  return err
}

function validationError(message: string, code: string): Error & { code: string; statusCode: number } {
  const err = new Error(message) as Error & { code: string; statusCode: number }
  err.code = code
  err.statusCode = 400
  return err
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveSlug(input: string): string {
  return slugify(input, { lower: true, strict: true, trim: true })
}

/** Short (8-char) hash of a string — used for personal workspace slugs. */
function shortHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8)
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateWorkspaceInput {
  slug?: string
  name: string
  planSlug: string
  createdByAccountId: string
}

export interface CreateInvitationInput {
  workspaceId: string
  email: string
  role: WorkspaceRole
  inviterAccountId: string
}

// ---------------------------------------------------------------------------
// WorkspaceService
// ---------------------------------------------------------------------------

export class WorkspaceService {
  private readonly prisma: PrismaClient
  private readonly audit: AuditService

  constructor(prisma: PrismaClient) {
    this.prisma = prisma
    this.audit = new AuditService(prisma)
  }

  // ── Query helpers ──────────────────────────────────────────────────────────

  /**
   * List workspaces where the account is an active member (joinedAt not null).
   */
  async listForAccount(accountSub: string) {
    return this.prisma.workspace.findMany({
      where: {
        members: {
          some: {
            accountId: accountSub,
            joinedAt: { not: null },
          },
        },
        archivedAt: null,
      },
      include: { plan: true },
      orderBy: { createdAt: 'asc' },
    })
  }

  /**
   * Fetch a single workspace by id or slug; includes plan.
   * Throws 404 if not found.
   */
  async getWorkspace(idOrSlug: string) {
    // UUID shape: 8-4-4-4-12 hex groups
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idOrSlug,
    )

    const workspace = await this.prisma.workspace.findFirst({
      where: isUuid ? { id: idOrSlug } : { slug: idOrSlug },
      include: { plan: true },
    })

    if (!workspace) {
      throw notFoundError('Workspace', idOrSlug)
    }

    return workspace
  }

  // ── Create workspace ───────────────────────────────────────────────────────

  async createWorkspace(input: CreateWorkspaceInput) {
    const rawSlug = input.slug ?? deriveSlug(input.name)
    if (!rawSlug) {
      throw validationError('Could not derive a valid slug from name', 'invalid_slug')
    }

    // Resolve plan
    const plan = await this.prisma.workspacePlan.findUnique({
      where: { slug: input.planSlug },
    })
    if (!plan) {
      throw notFoundError('WorkspacePlan', input.planSlug)
    }

    // Check slug uniqueness
    const existing = await this.prisma.workspace.findUnique({
      where: { slug: rawSlug },
    })
    if (existing) {
      throw conflictError(`Workspace slug "${rawSlug}" is already taken`, 'slug_conflict')
    }

    const workspace = await this.prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: {
          slug: rawSlug,
          name: input.name,
          planId: plan.id,
          createdByAccountId: input.createdByAccountId,
        },
        include: { plan: true },
      })

      await tx.workspaceMember.create({
        data: {
          workspaceId: ws.id,
          accountId: input.createdByAccountId,
          role: 'owner',
          joinedAt: new Date(),
        },
      })

      return ws
    })

    await this.audit.record({
      actorAccountId: input.createdByAccountId,
      action: 'workspace.created',
      subjectType: 'Workspace',
      subjectId: workspace.id,
      diff: { slug: workspace.slug, name: workspace.name, planSlug: input.planSlug },
    })

    return workspace
  }

  // ── Membership ─────────────────────────────────────────────────────────────

  async addMember(workspaceId: string, accountId: string, role: WorkspaceRole) {
    await this._assertWorkspaceExists(workspaceId)

    const member = await this.prisma.workspaceMember.upsert({
      where: { workspaceId_accountId: { workspaceId, accountId } },
      create: {
        workspaceId,
        accountId,
        role,
        joinedAt: new Date(),
      },
      update: { role },
    })

    await this.audit.record({
      actorAccountId: null,
      action: 'workspace.member_added',
      subjectType: 'Workspace',
      subjectId: workspaceId,
      diff: { accountId, role },
    })

    return member
  }

  async removeMember(workspaceId: string, accountId: string) {
    await this._assertWorkspaceExists(workspaceId)

    // Refuse to remove the last owner
    const ownerCount = await this.prisma.workspaceMember.count({
      where: { workspaceId, role: 'owner', joinedAt: { not: null } },
    })

    const targetMember = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_accountId: { workspaceId, accountId } },
    })

    if (!targetMember) {
      throw notFoundError('WorkspaceMember', accountId)
    }

    if (targetMember.role === 'owner' && ownerCount <= 1) {
      throw validationError(
        'Cannot remove the last owner of a workspace',
        'last_owner_removal',
      )
    }

    return this.prisma.workspaceMember.delete({
      where: { workspaceId_accountId: { workspaceId, accountId } },
    })
  }

  async transferOwnership(workspaceId: string, newOwnerAccountId: string) {
    const workspace = await this._assertWorkspaceExists(workspaceId)

    // Find current owner(s)
    const currentOwners = await this.prisma.workspaceMember.findMany({
      where: { workspaceId, role: 'owner' },
    })

    const newOwnerMember = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_accountId: { workspaceId, accountId: newOwnerAccountId } },
    })
    if (!newOwnerMember) {
      throw notFoundError('WorkspaceMember', newOwnerAccountId)
    }

    await this.prisma.$transaction(async (tx) => {
      // Demote all current owners to admin
      for (const owner of currentOwners) {
        if (owner.accountId !== newOwnerAccountId) {
          await tx.workspaceMember.update({
            where: { workspaceId_accountId: { workspaceId, accountId: owner.accountId } },
            data: { role: 'admin' },
          })
        }
      }
      // Promote new owner
      await tx.workspaceMember.update({
        where: { workspaceId_accountId: { workspaceId, accountId: newOwnerAccountId } },
        data: { role: 'owner' },
      })
    })

    return workspace
  }

  // ── Archive ────────────────────────────────────────────────────────────────

  /**
   * Sets archivedAt. Does NOT cascade-delete owned forms (per §10 risk #7 —
   * preserve data on downgrade/archive; existing forms become read-only).
   */
  async archiveWorkspace(id: string) {
    await this._assertWorkspaceExists(id)

    return this.prisma.workspace.update({
      where: { id },
      data: { archivedAt: new Date() },
    })
  }

  // ── Invitations ────────────────────────────────────────────────────────────

  async createInvitation(input: CreateInvitationInput) {
    await this._assertWorkspaceExists(input.workspaceId)

    // Generate token — store only hash
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = sha256Hex(rawToken)

    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS)

    const invitation = await this.prisma.workspaceInvitation.create({
      data: {
        workspaceId: input.workspaceId,
        email: input.email,
        role: input.role,
        tokenHash,
        expiresAt,
      },
    })

    await this.audit.record({
      actorAccountId: input.inviterAccountId,
      action: 'workspace.invitation_sent',
      subjectType: 'Workspace',
      subjectId: input.workspaceId,
      diff: { email: input.email, role: input.role, invitationId: invitation.id },
    })

    // Return invitation + raw token so the caller can email it to the invitee.
    // The raw token must never be stored; only the hash persists.
    return { invitation, rawToken }
  }

  /**
   * Validates the raw invitation token and, if valid, creates/updates the
   * WorkspaceMember row and marks the invitation as accepted.
   */
  async acceptInvitation(rawToken: string, accountId: string) {
    const tokenHash = sha256Hex(rawToken)

    const invitation = await this.prisma.workspaceInvitation.findUnique({
      where: { tokenHash },
    })

    if (!invitation) {
      throw notFoundError('WorkspaceInvitation', rawToken)
    }

    if (invitation.acceptedAt) {
      throw conflictError('Invitation has already been accepted', 'invitation_already_accepted')
    }

    if (invitation.expiresAt < new Date()) {
      throw validationError('Invitation has expired', 'invitation_expired')
    }

    const member = await this.prisma.$transaction(async (tx) => {
      const m = await tx.workspaceMember.upsert({
        where: {
          workspaceId_accountId: {
            workspaceId: invitation.workspaceId,
            accountId,
          },
        },
        create: {
          workspaceId: invitation.workspaceId,
          accountId,
          role: invitation.role,
          joinedAt: new Date(),
        },
        update: {
          role: invitation.role,
          joinedAt: new Date(),
        },
      })

      await tx.workspaceInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      })

      return m
    })

    await this.audit.record({
      actorAccountId: accountId,
      action: 'workspace.invitation_accepted',
      subjectType: 'Workspace',
      subjectId: invitation.workspaceId,
      diff: { invitationId: invitation.id, role: invitation.role },
    })

    return member
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private async _assertWorkspaceExists(id: string) {
    const workspace = await this.prisma.workspace.findUnique({ where: { id } })
    if (!workspace) {
      throw notFoundError('Workspace', id)
    }
    return workspace
  }
}

// Re-export shortHash for use by the backfill script
export { shortHash }
