import { env } from './env.js'

// Sentry is initialized lazily only when SENTRY_DSN is set.
// This avoids importing the heavy @sentry/node package in dev/test
// where no DSN is configured.

let captureExceptionImpl: ((err: unknown) => void) | null = null

export async function initSentry(): Promise<void> {
  if (!env.SENTRY_DSN) return

  const Sentry = await import('@sentry/node')
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
  })
  captureExceptionImpl = Sentry.captureException.bind(Sentry)
}

export function captureException(err: unknown): void {
  if (captureExceptionImpl) {
    captureExceptionImpl(err)
  }
}
