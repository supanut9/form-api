/**
 * Session service — issue / verify / rotate local JWTs and refresh tokens.
 *
 * Mirrors cms-api/src/core/auth/session.ts using FORMS_ env vars and
 * L4's Prisma model names: prisma.session, prisma.accountRole, prisma.role.
 *
 * Access token: short-lived HS256 JWT signed with FORMS_JWT_SECRET.
 * Refresh token: opaque nanoid stored as form_session.id (PK).
 *
 * All functions that touch the DB accept a `db` parameter (type `any` until
 * L4's generated PrismaClient is available). Callers pass fastify.prisma.
 *
 * Prisma model names (L4 camelCase):
 *   session    { id, accountId, issuedAt, expiresAt, revokedAt?, userAgent, ipHash }
 *   accountRole { accountId, roleId, grantedAt, grantedBy, scopeJson, role }
 *   role        { id, name, description, isSystem }
 *   auditLog    { actorAccountId, action, subjectType, subjectId, diffJson }
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { nanoid } from "nanoid";
import { env } from "../../config/env.js";
import {
  type SessionPayload,
  type FormRole,
  type SessionIssuedResult,
  FORM_ROLES,
} from "./types.js";
import pino from "pino";

const logger = pino({ name: "form:session" });

// ---------------------------------------------------------------------------
// TTL helpers
// ---------------------------------------------------------------------------

export function parseTtlToSeconds(ttl: string): number {
  const units: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Invalid TTL format: ${ttl}. Expected e.g. "15m", "30d"`);
  }
  const value = parseInt(match[1], 10);
  const unitSeconds = units[match[2]];
  if (unitSeconds === undefined) {
    throw new Error(`Unknown TTL unit in: ${ttl}`);
  }
  return value * unitSeconds;
}

export function getJwtSecret(): Uint8Array {
  const secret = env.FORMS_JWT_SECRET;
  if (!secret) {
    throw new Error("FORMS_JWT_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

// ---------------------------------------------------------------------------
// Access token — sign / verify
// ---------------------------------------------------------------------------

/**
 * Signs a local HS256 access JWT.
 * `sid` is the opaque Session.id (= the refresh token value).
 */
export async function signAccessToken(payload: {
  sub: string;
  roles: FormRole[];
  sid: string;
  email?: string;
  name?: string;
}): Promise<{ token: string; expiresInSeconds: number; expiresAt: Date }> {
  const ttlSeconds = parseTtlToSeconds(env.FORMS_ACCESS_TOKEN_TTL);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  // Build claims lazily so empty profile fields don't bloat the JWT.
  const claims: Record<string, unknown> = {
    sub: payload.sub,
    roles: payload.roles,
    sid: payload.sid,
  };
  if (payload.email) claims["email"] = payload.email;
  if (payload.name) claims["name"] = payload.name;

  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getJwtSecret());

  return { token, expiresInSeconds: ttlSeconds, expiresAt };
}

/**
 * Verifies and decodes a local access JWT.
 * Throws JWTError (from jose) if invalid or expired.
 */
export async function verifyAccessToken(
  token: string
): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, getJwtSecret(), {
    algorithms: ["HS256"],
  });

  assertSessionPayload(payload);
  return payload as unknown as SessionPayload;
}

function assertSessionPayload(p: JWTPayload): void {
  if (typeof p["sub"] !== "string" || !p["sub"]) {
    throw new Error("JWT missing or invalid sub");
  }
  if (!Array.isArray(p["roles"])) {
    throw new Error("JWT missing roles array");
  }
  if (typeof p["sid"] !== "string" || !p["sid"]) {
    throw new Error("JWT missing sid");
  }
  for (const r of p["roles"] as unknown[]) {
    if (!FORM_ROLES.includes(r as FormRole)) {
      throw new Error(`JWT contains unknown role: ${r}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Refresh token — create / rotate / revoke
// ---------------------------------------------------------------------------

export class RefreshTokenError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RefreshTokenError";
  }
}

export interface RotateResult {
  accessToken: string;
  expiresInSeconds: number;
  expiresAt: Date;
  newRefreshToken: string;
}

/**
 * Looks up the refresh token, verifies it's active, rotates atomically,
 * and issues a new access token.
 */
export async function rotateRefreshToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  refreshToken: string,
  params?: { ipHash?: string; userAgent?: string }
): Promise<RotateResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await db.$transaction(async (tx: any) => {
    const existing = await tx.session.findUnique({
      where: { id: refreshToken },
    });

    if (!existing) {
      throw new RefreshTokenError(
        "invalid_refresh_token",
        "Refresh token not found"
      );
    }
    if (existing.revokedAt !== null) {
      throw new RefreshTokenError(
        "refresh_token_revoked",
        "Refresh token has been revoked"
      );
    }
    if (existing.expiresAt < new Date()) {
      throw new RefreshTokenError(
        "refresh_token_expired",
        "Refresh token has expired"
      );
    }

    // Revoke old token
    await tx.session.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    // Re-fetch roles for this account
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accountRoles = await tx.accountRole.findMany({
      where: { accountId: existing.accountId },
      include: { role: true },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roles: FormRole[] = accountRoles.map((ar: any) => ar.role.name as FormRole);

    // Issue new refresh token
    const newRefreshToken = nanoid(32);
    const ttlSeconds = parseTtlToSeconds(env.FORMS_REFRESH_TOKEN_TTL);
    const now = new Date();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await tx.session.create({
      data: {
        id: newRefreshToken,
        accountId: existing.accountId,
        issuedAt: now,
        expiresAt,
        userAgent: params?.userAgent ?? existing.userAgent,
        ipHash: params?.ipHash ?? existing.ipHash,
      },
    });

    return {
      accountId: existing.accountId,
      roles,
      newRefreshToken,
    };
  });

  const { token, expiresInSeconds, expiresAt } = await signAccessToken({
    sub: result.accountId,
    roles: result.roles,
    sid: result.newRefreshToken,
  });

  logger.debug({ sub: result.accountId }, "Refresh token rotated");

  return {
    accessToken: token,
    expiresInSeconds,
    expiresAt,
    newRefreshToken: result.newRefreshToken,
  };
}

/**
 * Revokes a refresh token by setting revokedAt. Silently succeeds if not found.
 */
export async function revokeRefreshToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  refreshToken: string
): Promise<void> {
  await db.session.updateMany({
    where: { id: refreshToken, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  logger.debug("Refresh token revoked");
}

// ---------------------------------------------------------------------------
// Bootstrap: look up or create account_role
// ---------------------------------------------------------------------------

export class NoRoleMappingError extends Error {
  readonly code = "not_authorized";
  constructor(sub: string) {
    super(`No role mapping for account: ${sub}`);
    this.name = "NoRoleMappingError";
  }
}

/**
 * Looks up the account's form roles, bootstrapping super-admin if configured.
 * Throws NoRoleMappingError if no roles found and bootstrap doesn't apply.
 */
export async function lookupOrBootstrapRoles(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  sub: string
): Promise<{ roles: FormRole[]; grantedAt?: Date | null }> {
  const rows = await db.accountRole.findMany({
    where: { accountId: sub },
    include: { role: true },
  });

  if (rows.length > 0) {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      roles: rows.map((r: any) => r.role.name as FormRole),
      grantedAt: rows[0]?.grantedAt ?? null,
    };
  }

  // No roles — attempt bootstrap
  if (env.FORMS_BOOTSTRAP_ADMIN_SUB && env.FORMS_BOOTSTRAP_ADMIN_SUB === sub) {
    logger.info({ sub }, "Bootstrapping super-admin role");

    const superAdminRole = await db.role.upsert({
      where: { name: "super-admin" },
      create: {
        name: "super-admin",
        description: "Full access to all form resources",
        isSystem: true,
      },
      update: {},
    });

    const now = new Date();
    await db.accountRole.create({
      data: {
        accountId: sub,
        roleId: superAdminRole.id,
        scopeJson: {},
        grantedBy: "system-bootstrap",
        grantedAt: now,
      },
    });

    return { roles: ["super-admin"], grantedAt: now };
  }

  throw new NoRoleMappingError(sub);
}

// ---------------------------------------------------------------------------
// Composite: issue access + refresh token together
// ---------------------------------------------------------------------------

export async function issueSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  params: {
    sub: string;
    roles: FormRole[];
    ipHash?: string;
    userAgent?: string;
    email?: string;
    name?: string;
  }
): Promise<SessionIssuedResult & { sessionId: string }> {
  const refreshToken = nanoid(32);
  const ttlSeconds = parseTtlToSeconds(env.FORMS_REFRESH_TOKEN_TTL);
  const now = new Date();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await db.session.create({
    data: {
      id: refreshToken,
      accountId: params.sub,
      issuedAt: now,
      expiresAt,
      userAgent: params.userAgent ?? "unknown",
      ipHash: params.ipHash ?? "unknown",
    },
  });

  const { token, expiresInSeconds, expiresAt: accessExpiresAt } =
    await signAccessToken({
      sub: params.sub,
      roles: params.roles,
      sid: refreshToken,
      email: params.email,
      name: params.name,
    });

  logger.debug({ sub: params.sub }, "Session issued");

  return {
    access_token: token,
    expires_in: expiresInSeconds,
    refresh_token: refreshToken,
    expires_at: accessExpiresAt.toISOString(),
    sessionId: refreshToken,
  };
}
