/**
 * E2E — Stripe CLI payment flow smoke test.
 *
 * GATED: This spec is SKIPPED unless STRIPE_CLI_TEST=true is set in the
 * environment. It is intentionally NOT run in CI (no STRIPE_WEBHOOK_SECRET
 * or real Stripe CLI available there). Its purpose is a manual pre-release
 * smoke test by a developer.
 *
 * Prerequisites (must all be running before executing this spec):
 *
 *   1. form-api on http://localhost:4200
 *      PORT=4200 node dist/server.js
 *      (or: npm run dev)
 *
 *   2. form-web on http://localhost:4202
 *      (standard Next.js dev/start)
 *
 *   3. Stripe CLI forwarding webhook events to form-api:
 *      stripe listen --forward-to http://localhost:4200/v1/internal/stripe/webhook
 *      → Copy the "whsec_..." webhook signing secret printed by the CLI and set
 *        it as STRIPE_WEBHOOK_SECRET in form-api's .env, then restart form-api.
 *
 *   4. Environment variables:
 *      STRIPE_CLI_TEST=true          — enables this spec
 *      STRIPE_SECRET_KEY=sk_test_... — test-mode restricted secret key
 *      E2E_ADMIN_TOKEN=<token>       — break-glass or API token for seeding
 *      DATABASE_URL=...              — direct Prisma access for post-run assertion
 *
 * Real test-mode card: 4242 4242 4242 4242 | exp: 12/29 | cvc: 123
 *
 * This spec walks:
 *   open public form-web → fill required fields → advance to payment page
 *   → fill Stripe Elements card iframe → click Pay → expect thank-you page
 *   → read form_payments row via direct Prisma and assert status='succeeded'
 */

import { test, expect, Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

// ── Env gate ──────────────────────────────────────────────────────────────────

const STRIPE_CLI_TEST = process.env['STRIPE_CLI_TEST'] === 'true'

// ── Constants ─────────────────────────────────────────────────────────────────

const FORM_API     = 'http://localhost:4200'
const FORM_WEB     = 'http://localhost:4202'
const ADMIN_TOKEN  = process.env['E2E_ADMIN_TOKEN'] ?? ''

// Stripe test-mode card details
const TEST_CARD_NUMBER = '4242 4242 4242 4242'
const TEST_CARD_EXPIRY = '12 / 29'
const TEST_CARD_CVC    = '123'
const TEST_CARD_ZIP    = '10001'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${FORM_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`apiPost ${path} failed ${res.status}: ${text}`)
  }
  return res.json()
}

async function fillStripeElements(page: Page, cardNumber: string, expiry: string, cvc: string, zip?: string) {
  // Stripe Elements renders inside an iframe. The iframe's name attribute
  // begins with "__privateStripeFrame" in test mode.
  // We locate the iframe via its title or name, then fill each field.
  const cardFrame = page.frameLocator('iframe[title*="Secure card"]').first()
    ?? page.frameLocator('iframe[name*="privateStripe"]').first()

  // Card number field
  const cardInput = cardFrame.locator('[placeholder="1234 1234 1234 1234"]')
    .or(cardFrame.locator('[name="cardnumber"]'))
    .or(cardFrame.locator('[autocomplete="cc-number"]'))
  await cardInput.fill(cardNumber)

  // Expiry
  const expiryInput = cardFrame.locator('[placeholder="MM / YY"]')
    .or(cardFrame.locator('[name="exp-date"]'))
    .or(cardFrame.locator('[autocomplete="cc-exp"]'))
  await expiryInput.fill(expiry)

  // CVC
  const cvcInput = cardFrame.locator('[placeholder="CVC"]')
    .or(cardFrame.locator('[name="cvc"]'))
    .or(cardFrame.locator('[autocomplete="cc-csc"]'))
  await cvcInput.fill(cvc)

  // Postal code (Stripe Elements shows this for US cards)
  if (zip) {
    const zipInput = cardFrame.locator('[placeholder="ZIP"]').or(cardFrame.locator('[name="postal"]'))
    if (await zipInput.count() > 0) {
      await zipInput.fill(zip)
    }
  }
}

// ── Spec ─────────────────────────────────────────────────────────────────────

test.describe('Stripe CLI payment flow', () => {
  test.skip(!STRIPE_CLI_TEST, 'Set STRIPE_CLI_TEST=true and run stripe listen before executing this spec')

  let formSlug: string
  let formId: string

  test.beforeAll(async () => {
    // Create a payment-gated form via admin API
    const slug = `stripe-e2e-smoke-${Date.now()}`
    const spec = {
      id: 'tmp',
      version: 1,
      title: 'Stripe E2E Payment Form',
      type: 'dynamic',
      access: { mode: 'public_anonymous', require_account: false, anonymous_allowed: true },
      pages: [
        {
          id: 'pg_info',
          title: 'Your Info',
          fields: [
            { id: 'fld_name', type: 'text', label: 'Full name', required: true },
          ],
        },
      ],
      payment: {
        mode: 'fixed',
        amount_minor: 1500,   // $15.00 USD in test mode
        currency: 'usd',
        capture_intent: 'on_submit',
        required_for_submit: true,
      },
      thank_you: {
        title: 'Payment received!',
        body_md: 'Thank you for your payment.',
        redirect_url_template: '',
      },
      submit: { post_actions: [] },
    }

    const form = await apiPost('/v1/admin/forms', {
      title: 'Stripe E2E Payment Form',
      type: 'dynamic',
      slug,
      access: { mode: 'public_anonymous', require_account: false, anonymous_allowed: true },
      spec,
    })

    formId   = form.id ?? form.data?.id
    formSlug = form.slug ?? form.data?.slug ?? slug
  })

  test('fill form → pay with test card → assert thank-you page + DB succeeded status', async ({ page }) => {
    // ── Navigate to public form ───────────────────────────────────────────────
    await page.goto(`${FORM_WEB}/forms/${formSlug}`)
    await expect(page).toHaveTitle(/stripe e2e/i, { timeout: 15_000 })

    // ── Fill required text field ──────────────────────────────────────────────
    const nameField = page.getByLabel(/full name/i).or(page.locator('[data-field-id="fld_name"] input'))
    await nameField.fill('Integration Tester')

    // ── Advance to payment page ───────────────────────────────────────────────
    const nextBtn = page.getByRole('button', { name: /next|continue|pay/i }).first()
    await nextBtn.click()

    // Wait for Stripe Elements iframe to appear
    await page.waitForSelector('iframe[title*="Secure card"], iframe[name*="privateStripe"]', {
      timeout: 20_000,
    })

    // ── Fill Stripe Elements ──────────────────────────────────────────────────
    await fillStripeElements(page, TEST_CARD_NUMBER, TEST_CARD_EXPIRY, TEST_CARD_CVC, TEST_CARD_ZIP)

    // ── Submit payment ────────────────────────────────────────────────────────
    const payBtn = page.getByRole('button', { name: /pay|submit|complete/i }).first()
    await payBtn.click()

    // ── Assert thank-you page ─────────────────────────────────────────────────
    await expect(
      page.getByText(/payment received|thank you/i),
      'Thank-you message should appear after successful payment',
    ).toBeVisible({ timeout: 30_000 })

    // ── Assert DB row via direct Prisma ───────────────────────────────────────
    // Allow up to 10 s for the Stripe webhook to arrive and be processed.
    const prisma = new PrismaClient({ datasourceUrl: process.env['DATABASE_URL'] })

    let dbRow: { status: string } | null = null
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const prismaAny = prisma as unknown as Record<string, any>
      dbRow = await prismaAny['formPayment'].findFirst({
        where: {
          status: 'succeeded',
          submission: { formId },
        },
        select: { status: true },
      })
      if (dbRow) break
      await new Promise((r) => setTimeout(r, 500))
    }

    await prisma.$disconnect()

    expect(dbRow, 'Expected a succeeded FormPayment row in DB within 10 s of thank-you page').not.toBeNull()
    expect(dbRow!.status).toBe('succeeded')
  })
})
