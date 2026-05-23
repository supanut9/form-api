/**
 * Event domain service.
 *
 * Form events are the integration unit: other services don't ask "does form X
 * exist?" — they ask "did this user complete event X?". A FormEvent binds one
 * `event_key` (e.g. "language.profile.v1") to a single form. Submissions to
 * that form create a FormEventFill row, which the status API and webhook
 * pipeline read from.
 */
import type { PrismaClient } from '@prisma/client'

const EVENT_KEY_RE = /^[a-z][a-z0-9_.\-]{2,80}$/

export class EventService {
  constructor(private readonly prisma: PrismaClient) {}

  static validateEventKey(eventKey: string): void {
    if (!EVENT_KEY_RE.test(eventKey)) {
      const err = new Error(
        'eventKey must match /^[a-z][a-z0-9_.\\-]{2,80}$/ (lowercase, dot/dash/underscore, 3–80 chars)',
      )
      ;(err as Error & { code?: string }).code = 'invalid_event_key'
      throw err
    }
  }

  async createEvent(input: {
    eventKey: string
    formId: string
    optional?: boolean
    description?: string
  }) {
    EventService.validateEventKey(input.eventKey)

    const form = await this.prisma.formDefinition.findUnique({
      where: { id: input.formId },
      select: { id: true, currentVersion: true },
    })
    if (!form) {
      const err = new Error('Form not found') as Error & { code?: string }
      err.code = 'form_not_found'
      throw err
    }

    return this.prisma.formEvent.create({
      data: {
        eventKey: input.eventKey,
        formId: form.id,
        currentVersion: form.currentVersion,
        optional: input.optional ?? false,
        description: input.description ?? '',
      },
    })
  }

  async listEvents(input: { formId?: string } = {}) {
    return this.prisma.formEvent.findMany({
      where: input.formId ? { formId: input.formId } : {},
      orderBy: { createdAt: 'desc' },
    })
  }

  async getEvent(id: string) {
    return this.prisma.formEvent.findUnique({ where: { id } })
  }

  async getEventByKey(eventKey: string) {
    return this.prisma.formEvent.findUnique({
      where: { eventKey },
      include: {
        form: {
          select: {
            id: true,
            slug: true,
            title: true,
            type: true,
            currentVersion: true,
            archivedAt: true,
          },
        },
      },
    })
  }

  async updateEvent(
    id: string,
    patch: { optional?: boolean; description?: string; currentVersion?: number },
  ) {
    return this.prisma.formEvent.update({ where: { id }, data: patch })
  }

  async deleteEvent(id: string) {
    return this.prisma.formEvent.delete({ where: { id } })
  }
}
