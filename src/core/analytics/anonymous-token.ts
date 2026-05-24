/**
 * Shared anonymous-token cookie helpers.
 *
 * The same cookie name and maxAge are used by:
 *   - submit.ts        (already sets the cookie on first anonymous submit)
 *   - public/funnel.ts (sets the cookie on first batch ingest)
 *
 * Import from here rather than duplicating the constants.
 */

/** Cookie name shared across all public form routes. */
export const ANON_COOKIE = 'form_anon'

/** Cookie lifetime: 180 days in seconds. */
export const ANON_COOKIE_MAX_AGE = 60 * 60 * 24 * 180
