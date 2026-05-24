/**
 * Unit tests for WorkspaceService.
 * Uses a fully mocked PrismaClient — no live DB required.
 */

process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test'

import { describe, it, expect, vi, beforeEach, type MockedObject } from 'vitest'
import type { PrismaClient } from '@prisma/client'

// ── Build a deep mock of PrismaClient ────────────────────────────────────────

function makePrismaMock() {
  return {
    workspacePlan: {
      findUnique: vi.fn(),
    },
    workspace: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    workspaceMember: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    workspaceInvitation: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  } as unknown as MockedObject<PrismaClient>
}

// ── Import under test ────────────────────────────────────────────────────────

const { WorkspaceService } = await import(
  '../../../src/core/workspaces/workspace.service.js'
)

// ── Helpers ──────────────────────────────────────────────────────────────────

const FREE_PLAN = {
  id: 'plan-free-uuid',
  slug: 'free',
  name: 'Free',
  monthlySubmissionQuota: 100,
  maxForms: 10,
  maxFileSizeMb: 5,
  paymentsEnabled: false,
  experimentsEnabled: false,
  analyticsRetentionDays: 30,
  stripePriceId: null,
}

const WORKSPACE = {
  id: 'ws-uuid-1',
  slug: 'personal-abc12345',
  name: 'Personal workspace',
  planId: FREE_PLAN.id,
  plan: FREE_PLAN,
  stripeCustomerId: null,
  createdByAccountId: 'account-sub-1',
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorkspaceService', () => {
  let prisma: MockedObject<PrismaClient>
  let service: InstanceType<typeof WorkspaceService>

  beforeEach(() => {
    prisma = makePrismaMock()
    service = new WorkspaceService(prisma as unknown as PrismaClient)
    // Audit swallows errors — mock auditLog.create to succeed silently
    prisma.auditLog.create.mockResolvedValue({} as any)
  })

  // ── createWorkspace ────────────────────────────────────────────────────────

  describe('createWorkspace', () => {
    it('creates workspace + owner member in a transaction', async () => {
      prisma.workspacePlan.findUnique.mockResolvedValue(FREE_PLAN as any)
      prisma.workspace.findUnique.mockResolvedValue(null) // no slug conflict

      const txWorkspace = { ...WORKSPACE, plan: FREE_PLAN }
      // $transaction receives a callback — run it synchronously with a tx mock
      const txMock = {
        workspace: { create: vi.fn().mockResolvedValue(txWorkspace) },
        workspaceMember: { create: vi.fn().mockResolvedValue({}) },
      }
      prisma.$transaction.mockImplementation(async (fn: (tx: any) => any) => fn(txMock))

      const result = await service.createWorkspace({
        name: 'Personal workspace',
        planSlug: 'free',
        createdByAccountId: 'account-sub-1',
      })

      expect(prisma.workspacePlan.findUnique).toHaveBeenCalledWith({
        where: { slug: 'free' },
      })
      expect(txMock.workspace.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Personal workspace',
            planId: FREE_PLAN.id,
            createdByAccountId: 'account-sub-1',
          }),
        }),
      )
      expect(txMock.workspaceMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: WORKSPACE.id,
            accountId: 'account-sub-1',
            role: 'owner',
          }),
        }),
      )
      expect(result.id).toBe(WORKSPACE.id)
    })

    it('derives slug from name if not provided', async () => {
      prisma.workspacePlan.findUnique.mockResolvedValue(FREE_PLAN as any)
      prisma.workspace.findUnique.mockResolvedValue(null)

      const txMock = {
        workspace: { create: vi.fn().mockResolvedValue({ ...WORKSPACE, slug: 'my-team' }) },
        workspaceMember: { create: vi.fn().mockResolvedValue({}) },
      }
      prisma.$transaction.mockImplementation(async (fn: (tx: any) => any) => fn(txMock))

      await service.createWorkspace({
        name: 'My Team',
        planSlug: 'free',
        createdByAccountId: 'account-sub-1',
      })

      expect(txMock.workspace.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ slug: 'my-team' }),
        }),
      )
    })

    it('throws 409 slug_conflict when slug already exists', async () => {
      prisma.workspacePlan.findUnique.mockResolvedValue(FREE_PLAN as any)
      prisma.workspace.findUnique.mockResolvedValue(WORKSPACE as any) // slug taken

      await expect(
        service.createWorkspace({
          name: 'Personal workspace',
          planSlug: 'free',
          createdByAccountId: 'account-sub-1',
        }),
      ).rejects.toMatchObject({ code: 'slug_conflict', statusCode: 409 })
    })

    it('throws 404 when plan slug not found', async () => {
      prisma.workspacePlan.findUnique.mockResolvedValue(null)

      await expect(
        service.createWorkspace({
          name: 'My WS',
          planSlug: 'nonexistent',
          createdByAccountId: 'account-sub-1',
        }),
      ).rejects.toMatchObject({ code: 'workspaceplan_not_found', statusCode: 404 })
    })
  })

  // ── addMember ──────────────────────────────────────────────────────────────

  describe('addMember', () => {
    it('upserts a member with the given role', async () => {
      prisma.workspace.findUnique.mockResolvedValue(WORKSPACE as any)
      prisma.workspaceMember.upsert.mockResolvedValue({
        workspaceId: WORKSPACE.id,
        accountId: 'account-sub-2',
        role: 'editor',
        invitedAt: new Date(),
        joinedAt: new Date(),
      } as any)

      const member = await service.addMember(WORKSPACE.id, 'account-sub-2', 'editor')

      expect(prisma.workspaceMember.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId_accountId: { workspaceId: WORKSPACE.id, accountId: 'account-sub-2' } },
          create: expect.objectContaining({ role: 'editor' }),
        }),
      )
      expect(member.role).toBe('editor')
    })
  })

  // ── removeMember ───────────────────────────────────────────────────────────

  describe('removeMember', () => {
    it('refuses to remove the last owner', async () => {
      prisma.workspace.findUnique.mockResolvedValue(WORKSPACE as any)
      prisma.workspaceMember.count.mockResolvedValue(1)
      prisma.workspaceMember.findUnique.mockResolvedValue({
        workspaceId: WORKSPACE.id,
        accountId: 'account-sub-1',
        role: 'owner',
        invitedAt: new Date(),
        joinedAt: new Date(),
      } as any)

      await expect(
        service.removeMember(WORKSPACE.id, 'account-sub-1'),
      ).rejects.toMatchObject({ code: 'last_owner_removal', statusCode: 400 })
    })

    it('allows removing a non-owner member', async () => {
      prisma.workspace.findUnique.mockResolvedValue(WORKSPACE as any)
      prisma.workspaceMember.count.mockResolvedValue(1) // 1 owner remains
      prisma.workspaceMember.findUnique.mockResolvedValue({
        workspaceId: WORKSPACE.id,
        accountId: 'account-sub-2',
        role: 'editor',
        invitedAt: new Date(),
        joinedAt: new Date(),
      } as any)
      prisma.workspaceMember.delete.mockResolvedValue({} as any)

      await service.removeMember(WORKSPACE.id, 'account-sub-2')

      expect(prisma.workspaceMember.delete).toHaveBeenCalledWith({
        where: { workspaceId_accountId: { workspaceId: WORKSPACE.id, accountId: 'account-sub-2' } },
      })
    })
  })

  // ── createInvitation + acceptInvitation ────────────────────────────────────

  describe('createInvitation', () => {
    it('creates invitation with a hashed token and 7-day expiry', async () => {
      prisma.workspace.findUnique.mockResolvedValue(WORKSPACE as any)
      prisma.workspaceInvitation.create.mockResolvedValue({
        id: 'inv-uuid-1',
        workspaceId: WORKSPACE.id,
        email: 'test@example.com',
        role: 'editor',
        tokenHash: 'some-hash',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        acceptedAt: null,
        createdAt: new Date(),
      } as any)

      const { invitation, rawToken } = await service.createInvitation({
        workspaceId: WORKSPACE.id,
        email: 'test@example.com',
        role: 'editor',
        inviterAccountId: 'account-sub-1',
      })

      expect(typeof rawToken).toBe('string')
      expect(rawToken).toHaveLength(64) // 32 bytes hex
      expect(invitation.email).toBe('test@example.com')

      // Verify the stored tokenHash differs from the raw token
      const [createCall] = prisma.workspaceInvitation.create.mock.calls
      const storedHash = (createCall as any)[0].data.tokenHash
      expect(storedHash).not.toBe(rawToken)
      expect(storedHash).toHaveLength(64) // SHA-256 hex
    })
  })

  describe('acceptInvitation', () => {
    it('upserts member and marks invitation accepted', async () => {
      const rawToken = 'a'.repeat(64)
      const tokenHash = require('node:crypto')
        .createHash('sha256')
        .update(rawToken)
        .digest('hex')

      const invitation = {
        id: 'inv-uuid-1',
        workspaceId: WORKSPACE.id,
        email: 'test@example.com',
        role: 'editor' as const,
        tokenHash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        acceptedAt: null,
        createdAt: new Date(),
      }

      prisma.workspaceInvitation.findUnique.mockResolvedValue(invitation as any)

      const txMock = {
        workspaceMember: {
          upsert: vi.fn().mockResolvedValue({
            workspaceId: WORKSPACE.id,
            accountId: 'account-sub-2',
            role: 'editor',
            joinedAt: new Date(),
            invitedAt: new Date(),
          }),
        },
        workspaceInvitation: {
          update: vi.fn().mockResolvedValue({ ...invitation, acceptedAt: new Date() }),
        },
      }
      prisma.$transaction.mockImplementation(async (fn: (tx: any) => any) => fn(txMock))

      const member = await service.acceptInvitation(rawToken, 'account-sub-2')

      expect(txMock.workspaceMember.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            workspaceId_accountId: {
              workspaceId: WORKSPACE.id,
              accountId: 'account-sub-2',
            },
          },
          create: expect.objectContaining({ role: 'editor' }),
        }),
      )
      expect(txMock.workspaceInvitation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: invitation.id },
          data: expect.objectContaining({ acceptedAt: expect.any(Date) }),
        }),
      )
      expect(member.role).toBe('editor')
    })

    it('throws when invitation not found', async () => {
      prisma.workspaceInvitation.findUnique.mockResolvedValue(null)
      await expect(
        service.acceptInvitation('no-such-token', 'account-sub-2'),
      ).rejects.toMatchObject({ code: 'workspaceinvitation_not_found', statusCode: 404 })
    })

    it('throws when invitation already accepted', async () => {
      prisma.workspaceInvitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        workspaceId: WORKSPACE.id,
        email: 'x@x.com',
        role: 'editor',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 1000),
        acceptedAt: new Date(),
        createdAt: new Date(),
      } as any)

      await expect(
        service.acceptInvitation('any', 'account-sub-2'),
      ).rejects.toMatchObject({ code: 'invitation_already_accepted', statusCode: 409 })
    })

    it('throws when invitation expired', async () => {
      prisma.workspaceInvitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        workspaceId: WORKSPACE.id,
        email: 'x@x.com',
        role: 'editor',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() - 1000), // past
        acceptedAt: null,
        createdAt: new Date(),
      } as any)

      await expect(
        service.acceptInvitation('any', 'account-sub-2'),
      ).rejects.toMatchObject({ code: 'invitation_expired', statusCode: 400 })
    })
  })
})
