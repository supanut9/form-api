/**
 * Stripe SDK singleton + Connect helpers.
 *
 * Usage:
 *   import { getStripe, withConnect } from './stripe.client.js'
 *
 *   const stripe = getStripe()
 *   const intent = await stripe.paymentIntents.create({ ... }, withConnect(accountId))
 */
import Stripe from 'stripe'
import { env } from '../../config/env.js'

/** @internal exposed for test teardown only — do not use in production code */
export let _stripe: Stripe | null = null
export function _resetStripeForTests() { _stripe = null }

/**
 * Returns the singleton platform Stripe client.
 * Throws `payments_not_configured` if STRIPE_SECRET_KEY is not present.
 */
export function getStripe(): Stripe {
  if (_stripe) return _stripe

  if (!env.STRIPE_SECRET_KEY) {
    const err = new Error(
      'Stripe is not configured: STRIPE_SECRET_KEY is missing',
    ) as Error & { code?: string }
    err.code = 'payments_not_configured'
    throw err
  }

  _stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-04-22.dahlia',
  })

  return _stripe
}

/**
 * Returns a Stripe request-options bag for connected-account operations when
 * `account` is non-null, or an empty object for platform-level operations.
 *
 * Pass the returned value as the final argument to any stripe SDK call:
 *   stripe.paymentIntents.create({ ... }, withConnect(acctId))
 */
export function withConnect(account: string | null | undefined): Stripe.RequestOptions {
  if (account) return { stripeAccount: account }
  return {}
}
