/**
 * Shared hashing utilities used across public routes.
 *
 * hashIp    — day-bucketed SHA-256 of the raw IP; truncated to 32 hex chars.
 *             Moved here from submit.ts so the funnel ingest route reuses the
 *             same algorithm without duplication (non-breaking refactor).
 *
 * hashUserAgent — SHA-256 of the raw User-Agent string; truncated to 32 hex.
 */
import { createHash } from 'node:crypto'

/**
 * Returns a 32-char hex digest of `${ip}|${YYYY-MM-DD}`.
 * Rotates daily so long-term tracking across days is not possible.
 */
export function hashIp(ip: string | undefined): string {
  const day = new Date().toISOString().slice(0, 10)
  return createHash('sha256')
    .update(`${ip ?? ''}|${day}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Returns a 32-char hex digest of the raw User-Agent string.
 * Used for coarse device-fingerprint grouping only.
 */
export function hashUserAgent(ua: string | undefined): string {
  return createHash('sha256')
    .update(ua ?? '')
    .digest('hex')
    .slice(0, 32)
}
