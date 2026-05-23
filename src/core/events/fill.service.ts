/**
 * FormEventFill service.
 *
 * Records that a (form_event, account|anonymous) pair has been filled, and
 * answers status queries from callers ("did this user complete event X?").
 *
 * Idempotency:
 *  - Authenticated fills are unique on (event_key, account_id).
 *  - Anonymous fills are unique on (event_key, anonymous_token).
 *  - Re-submitting under the same identity updates submissionId + filledAt.
 */
import type { PrismaClient } from '@prisma/client'

export interface FillIdentity {
  accountId?: string | null
  anonymousToken?: string | null
}

export interface FillStatus {
  filled: boolean
  filled_at: string | null
  submission_id: string | null
}

export class FillService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Mark an event filled by the given identity. Returns the FormEventFill row.
   * No-op (returns null) if neither accountId nor anonymousToken is provided.
   */
  async markFilled(input: {
    eventKey: string
    submissionId: string
    identity: FillIdentity
  }) {
    const { eventKey, submissionId, identity } = input
    if (identity.accountId) {
      return this.prisma.formEventFill.upsert({
        where: {
          event_account_uniq: { eventKey, accountId: identity.accountId },
        },
        create: {
          eventKey,
          accountId: identity.accountId,
          submissionId,
        },
        update: { submissionId, filledAt: new Date() },
      })
    }
    if (identity.anonymousToken) {
      return this.prisma.formEventFill.upsert({
        where: {
          event_token_uniq: { eventKey, anonymousToken: identity.anonymousToken },
        },
        create: {
          eventKey,
          anonymousToken: identity.anonymousToken,
          submissionId,
        },
        update: { submissionId, filledAt: new Date() },
      })
    }
    return null
  }

  async getStatus(input: {
    eventKey: string
    identity: FillIdentity
  }): Promise<FillStatus> {
    const { eventKey, identity } = input

    // Prefer authenticated identity when both are present.
    if (identity.accountId) {
      const row = await this.prisma.formEventFill.findUnique({
        where: {
          event_account_uniq: { eventKey, accountId: identity.accountId },
        },
      })
      if (row) {
        return {
          filled: true,
          filled_at: row.filledAt.toISOString(),
          submission_id: row.submissionId,
        }
      }
    }
    if (identity.anonymousToken) {
      const row = await this.prisma.formEventFill.findUnique({
        where: {
          event_token_uniq: { eventKey, anonymousToken: identity.anonymousToken },
        },
      })
      if (row) {
        return {
          filled: true,
          filled_at: row.filledAt.toISOString(),
          submission_id: row.submissionId,
        }
      }
    }
    return { filled: false, filled_at: null, submission_id: null }
  }
}
