/**
 * Shared auth types for the form-api admin session system.
 * Mirrors the cms-api auth types with FORMS_ prefixed names.
 *
 * These are imported by session.ts, rbac.ts, break-glass.ts,
 * and the auth-session plugin.
 */

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const FORM_ROLES = [
  "super-admin",
  "editor",
  "viewer",
] as const;

export type FormRole = (typeof FORM_ROLES)[number];

// ---------------------------------------------------------------------------
// Session / JWT payload
// ---------------------------------------------------------------------------

/**
 * Claims embedded in the HS256 local access JWT.
 * `sub` = auth-server `accounts.id` (UUID v7)
 * `roles` = form roles granted to this account
 * `sid` = form_session row id (= the opaque refresh token)
 */
export interface SessionPayload {
  sub: string;
  roles: FormRole[];
  sid: string;
  /** OIDC profile email claim — populated when known. */
  email?: string;
  /** OIDC profile name claim — populated when known. */
  name?: string;
  iat: number;
  exp: number;
}

// ---------------------------------------------------------------------------
// Account + roles (used by GET /admin/session/me)
// ---------------------------------------------------------------------------

export interface AccountWithRoles {
  sub: string;
  roles: FormRole[];
  sid: string;
  granted_at?: string | null;
}

// ---------------------------------------------------------------------------
// Session issue result (response body for POST /admin/session)
// ---------------------------------------------------------------------------

export interface SessionIssuedResult {
  access_token: string;
  expires_in: number; // seconds
  refresh_token: string;
  expires_at: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Synthetic super-admin (break-glass)
// ---------------------------------------------------------------------------

export const SYNTHETIC_SUPER_ADMIN: AccountWithRoles = {
  sub: "emergency-break-glass",
  roles: ["super-admin"],
  sid: "break-glass",
  granted_at: null,
};

export const SYNTHETIC_SUPER_ADMIN_SESSION: SessionPayload = {
  sub: "emergency-break-glass",
  roles: ["super-admin"],
  sid: "break-glass",
  iat: 0,
  exp: Number.MAX_SAFE_INTEGER,
};

// ---------------------------------------------------------------------------
// NOTE: Fastify module augmentation lives in src/types/fastify.d.ts
// (shared with the L1 auth.plugin.ts declarations).
// request.session is declared there; this file exports only the types.
// ---------------------------------------------------------------------------
