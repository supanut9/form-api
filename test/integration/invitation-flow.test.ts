/**
 * Integration test — workspace invitation flow.
 *
 * Exercises the full invitation lifecycle via WorkspaceService against a real DB:
 *   1. createInvitation produces a WorkspaceInvitation row with tokenHash + 7-day expiresAt.
 *   2. acceptInvitation(plaintextToken, inviteeId) creates a WorkspaceMember row
 *      with role=editor, joinedAt=now.  Invitation is marked acceptedAt=now.
 *   3. Re-accepting the same token returns invitation_already_accepted.
 *   4. Accepting a token whose expiresAt is in the past returns invitation_expired.
 *
 * Gated on INTEGRATION_TESTS=true.
 */

// ── Skip guard ─────────────────────────────────────────────────────────────────

const RUN = Boolean(process.env.INTEGRATION_TESTS)

// ── Mocks ─────────────────────────────────────────────────────────────────────

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest'

vi.mock('stripe', () => {
  function MockStripe(this: any) {
    this.paymentIntents = { create: vi.fn(), retrieve: vi.fn() }
    this.webhooks = { constructEvent: vi.fn() }
  }
  return { default: MockStripe }
})

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/config/env.js')>()
  return {
    env: {
      ...original.env,
      STRIPE_SECRET_KEY: 'sk_test_mock',
      STRIPE_WEBHOOK_SECRET: 'whsec_mock',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_mock',
    },
  }
})

// ── Imports ───────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import crypto from 'node:crypto'
import { WorkspaceService } from '../../src/core/workspaces/workspace.service.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrisma(): PrismaClient {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 3,
    idleTimeoutMillis: 10_000,
  })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('invitation-flow integration', () => {
  let prisma: PrismaClient
  let wsService: WorkspaceService

  let wsId: string
  const OWNER = 'invitation-flow-integration-owner'
  const INVITEE = 'invitation-flow-integration-invitee'
  const INVITEE_EMAIL = 'invitee@example.com'

  beforeAll(async () => {
    prisma = buildPrisma()
    await prisma.$connect()

    wsService = new WorkspaceService(prisma)

    const prismaAny = prisma as any

    // Resolve free plan
    const freePlan = await prismaAny.workspacePlan.findUnique({ where: { slug: 'free' } })
    if (!freePlan) throw new Error('free plan not seeded — run migration 20260701 first')

    // Seed workspace
    const ws = await prismaAny.workspace.create({
      data: {
        slug: `invitation-flow-ws-${Date.now()}`,
        name: 'Invitation Flow WS',
        planId: freePlan.id,
        createdByAccountId: OWNER,
      },
    })
    wsId = ws.id

    await prismaAny.workspaceMember.create({
      data: { workspaceId: wsId, accountId: OWNER, role: 'owner', joinedAt: new Date() },
    })
  })

  afterAll(async () => {
    const prismaAny = prisma as any
    // Delete invitations then members then workspace
    await prismaAny.workspaceInvitation.deleteMany({ where: { workspaceId: wsId } })
    await prismaAny.workspaceMember.deleteMany({ where: { workspaceId: wsId } })
    await prismaAny.workspace.deleteMany({ where: { id: wsId } })

    await prisma.$disconnect()
  })

  let rawToken: string
  let invitationId: string

  // ── Step 1: createInvitation ───────────────────────────────────────────────

  it('createInvitation produces a DB row with hashed token and 7-day expiry', async () => {
    const result = await wsService.createInvitation({
      workspaceId: wsId,
      email: INVITEE_EMAIL,
      role: 'editor',
      inviterAccountId: OWNER,
    })

    rawToken = result.rawToken
    invitationId = result.invitation.id

    expect(typeof rawToken).toBe('string')
    expect(rawToken).toHaveLength(64) // 32 bytes hex

    // Verify row in DB
    const prismaAny = prisma as any
    const row = await prismaAny.workspaceInvitation.findUnique({ where: { id: invitationId } })
    expect(row).not.toBeNull()
    expect(row.tokenHash).toBe(sha256Hex(rawToken))
    expect(row.tokenHash).not.toBe(rawToken) // hash ≠ raw
    expect(row.email).toBe(INVITEE_EMAIL)
    expect(row.role).toBe('editor')
    expect(row.acceptedAt).toBeNull()

    // expiresAt should be ~7 days from now (within a 10-second window)
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    const expectedExpiry = Date.now() + sevenDaysMs
    expect(Math.abs(row.expiresAt.getTime() - expectedExpiry)).toBeLessThan(10_000)
  })

  // ── Step 2: acceptInvitation ───────────────────────────────────────────────

  it('acceptInvitation creates a WorkspaceMember row with role=editor and joinedAt=now', async () => {
    const before = Date.now() - 1000 // generous lower bound

    const member = await wsService.acceptInvitation(rawToken, INVITEE)

    expect(member.workspaceId).toBe(wsId)
    expect(member.accountId).toBe(INVITEE)
    expect(member.role).toBe('editor')
    expect(member.joinedAt).not.toBeNull()
    expect(member.joinedAt!.getTime()).toBeGreaterThanOrEqual(before)

    // Invitation row must be marked accepted
    const prismaAny = prisma as any
    const inv = await prismaAny.workspaceInvitation.findUnique({ where: { id: invitationId } })
    expect(inv.acceptedAt).not.toBeNull()
    expect(inv.acceptedAt.getTime()).toBeGreaterThanOrEqual(before)
  })

  // ── Step 3: Re-acceptance returns invitation_already_accepted ─────────────

  it('re-accepting the same token returns invitation_already_accepted', async () => {
    await expect(wsService.acceptInvitation(rawToken, INVITEE)).rejects.toMatchObject({
      code: 'invitation_already_accepted',
      statusCode: 409,
    })
  })

  // ── Step 4: Expired-token acceptance returns invitation_expired ───────────

  it('accepting an expired token returns invitation_expired', async () => {
    // Create a fresh invitation and immediately set its expiresAt to the past
    const { invitation: expiredInv, rawToken: expiredRaw } = await wsService.createInvitation({
      workspaceId: wsId,
      email: 'other@example.com',
      role: 'viewer',
      inviterAccountId: OWNER,
    })

    // Manually expire it
    const prismaAny = prisma as any
    await prismaAny.workspaceInvitation.update({
      where: { id: expiredInv.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    await expect(wsService.acceptInvitation(expiredRaw, 'some-other-account')).rejects.toMatchObject(
      {
        code: 'invitation_expired',
        statusCode: 400,
      },
    )
  })
})
