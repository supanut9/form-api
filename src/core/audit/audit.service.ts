/**
 * Audit log writer.
 *
 * Append-only. Every mutation in the system should call `record()` exactly
 * once. Failures are swallowed (logged at warn) so audit never blocks the
 * primary operation — but in practice the table is local Postgres and ought
 * to write reliably.
 */
import { Prisma, type PrismaClient } from '@prisma/client'

export type AuditAction =
  // forms
  | 'form.create'
  | 'form.update'
  | 'form.archive'
  | 'form.unarchive'
  | 'form.version.publish'
  // templates (Phase 3A)
  | 'template.create'
  | 'template.update'
  | 'template.delete'
  // submissions
  | 'submission.create'
  | 'submission.delete'
  | 'submission.restore'
  | 'submission.export'
  | 'submission.skipped_fields_stripped'
  | 'submission.payment_recorded'
  // events
  | 'event.create'
  | 'event.update'
  | 'event.delete'
  // webhooks
  | 'webhook.create'
  | 'webhook.update'
  | 'webhook.delete'
  | 'webhook.rotate_secret'
  | 'webhook.delivery.replay'
  // tokens
  | 'token.create'
  | 'token.revoke'
  // rbac
  | 'role.create'
  | 'role.update'
  | 'role.delete'
  | 'role.grant'
  | 'role.revoke'

export type AuditSubject =
  | 'Form'
  | 'FormVersion'
  | 'FormTemplate'
  | 'Submission'
  | 'FormEvent'
  | 'Webhook'
  | 'WebhookDelivery'
  | 'ApiToken'
  | 'Role'
  | 'AccountRole'

export interface AuditEntryInput {
  /** Authenticated account.sub when known; null for system actions. */
  actorAccountId: string | null
  action: AuditAction
  subjectType: AuditSubject
  subjectId: string
  /** Optional structured diff or context payload. */
  diff?: unknown
}

export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: AuditEntryInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorAccountId: entry.actorAccountId,
          action: entry.action,
          subjectType: entry.subjectType,
          subjectId: entry.subjectId,
          diffJson: (entry.diff ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      })
    } catch {
      // Swallow — caller's operation already succeeded.
    }
  }

  /**
   * Listing helper used by the admin audit page.
   * Filters are all optional; pagination is offset/limit.
   */
  async list(input: {
    actorAccountId?: string
    subjectType?: string
    subjectId?: string
    from?: Date
    to?: Date
    limit?: number
    offset?: number
  }) {
    const where: Record<string, unknown> = {}
    if (input.actorAccountId) where.actorAccountId = input.actorAccountId
    if (input.subjectType) where.subjectType = input.subjectType
    if (input.subjectId) where.subjectId = input.subjectId
    if (input.from || input.to) {
      const at: { gte?: Date; lte?: Date } = {}
      if (input.from) at.gte = input.from
      if (input.to) at.lte = input.to
      where.at = at
    }

    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { at: 'desc' },
        take: input.limit ?? 50,
        skip: input.offset ?? 0,
      }),
    ])
    return { total, rows }
  }
}
