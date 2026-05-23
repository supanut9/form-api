/**
 * Local smoke test for the webhook pipeline.
 *
 *   1. Creates a webhook on form-1 pointing at http://localhost:4299
 *   2. Calls POST /public/forms/form-1/submit to trigger delivery
 *   3. Polls form_webhook_deliveries until the row is delivered/failed
 *   4. Calls replay endpoint and verifies a fresh row lands
 *
 * Run alongside the echo receiver:
 *
 *   node /tmp/wh-echo.mjs
 *   pnpm tsx scripts/webhook-smoke.ts
 */
import 'dotenv/config'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { WebhookService } from '../src/core/webhooks/webhook.service.js'

const adapter = new PrismaPg(
  new pg.Pool({ connectionString: process.env['DATABASE_URL']!, max: 5 }),
)
const prisma = new PrismaClient({ adapter })

async function main() {
  const slug = process.env['SLUG'] ?? 'form-1'
  const form = await prisma.formDefinition.findUnique({ where: { slug } })
  if (!form) throw new Error(`form ${slug} not found`)

  const service = new WebhookService(prisma)

  // Wipe prior smoke webhooks pointing at the echo URL.
  const existing = await prisma.formWebhook.findMany({
    where: { formId: form.id, url: 'http://localhost:4299' },
  })
  for (const w of existing) await service.deleteWebhook(w.id)

  const created = await service.createWebhook({
    formId: form.id,
    url: 'http://localhost:4299',
    events: ['submitted'],
    active: true,
  })
  console.log(`[smoke] webhook created id=${created.id} secret=${created.secret.slice(0, 8)}…`)

  // Submit a row via raw API to exercise the wired dispatcher.
  const submitRes = await fetch(`http://localhost:4200/public/forms/${slug}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { _smoke: 'hello' } }),
  })
  const submitJson = (await submitRes.json()) as { submission_id: string }
  console.log(`[smoke] submit_id=${submitJson.submission_id}`)

  const deliveryId = await waitFor(
    async () => {
      const row = await prisma.formWebhookDelivery.findFirst({
        where: { webhookId: created.id, submissionId: submitJson.submission_id },
        orderBy: { scheduledAt: 'desc' },
      })
      if (row && row.status !== 'pending') return row
      return null
    },
    'delivery to leave pending',
  )
  console.log(
    `[smoke] delivery #${deliveryId.attempt} status=${deliveryId.status} code=${deliveryId.responseCode ?? '-'}`,
  )

  if (deliveryId.status !== 'delivered') {
    throw new Error('[smoke] FAIL — first delivery did not succeed')
  }

  // Force a replay
  const { newDeliveryId } = await service.replayDelivery(deliveryId.id)
  console.log(`[smoke] replay_id=${newDeliveryId}`)

  const replayRow = await waitFor(
    async () => {
      const row = await prisma.formWebhookDelivery.findUnique({
        where: { id: newDeliveryId },
      })
      if (row && row.status !== 'pending') return row
      return null
    },
    'replay to land',
  )
  console.log(
    `[smoke] replay #${replayRow.attempt} status=${replayRow.status} code=${replayRow.responseCode ?? '-'}`,
  )

  if (replayRow.status !== 'delivered') {
    throw new Error('[smoke] FAIL — replay did not deliver')
  }

  console.log('[smoke] PASS')
}

async function waitFor<T>(probe: () => Promise<T | null>, label: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const out = await probe()
    if (out) return out
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`[smoke] timed out waiting for ${label}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
