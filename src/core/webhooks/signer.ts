/**
 * Webhook payload signing.
 *
 * Header format (matches docs/forms/integration-guide.md):
 *
 *   X-Form-Signature: t=<unix-seconds>,v1=<hex(hmac-sha256)>
 *
 * The signed string is `${t}.${canonicalJson(payload)}` so receivers can
 * recompute it from the request body + the timestamp header. Use canonical
 * (sorted-keys) JSON so payload reformatting doesn't break verification.
 */
import { createHmac } from 'node:crypto'

/**
 * Canonical JSON: keys sorted at every depth so signatures are stable across
 * JSON.stringify reorderings. Pure utility — no special escaping.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in payload')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']'
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
      '}'
    )
  }
  // undefined / function / symbol → drop
  return 'null'
}

export interface SignedRequest {
  header: string
  timestamp: number
  body: string
  signature: string
}

export function signPayload(payload: unknown, secret: string, now: Date = new Date()): SignedRequest {
  const timestamp = Math.floor(now.getTime() / 1000)
  const body = canonicalJson(payload)
  const signedString = `${timestamp}.${body}`
  const signature = createHmac('sha256', secret).update(signedString).digest('hex')
  return {
    header: `t=${timestamp},v1=${signature}`,
    timestamp,
    body,
    signature,
  }
}

/**
 * Verify a delivery payload. Used by tests and by receivers that want to copy
 * the canonical algorithm.
 */
export function verifyPayload(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
): { ok: true } | { ok: false; reason: string } {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const eq = p.indexOf('=')
      return [p.slice(0, eq).trim(), p.slice(eq + 1).trim()] as [string, string]
    }),
  )
  const t = Number(parts['t'])
  const v1 = parts['v1']
  if (!t || !v1) return { ok: false, reason: 'malformed signature header' }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - t) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp outside tolerance' }
  }
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  if (expected !== v1) return { ok: false, reason: 'signature mismatch' }
  return { ok: true }
}
