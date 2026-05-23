/**
 * Admin session routes (cms-api mirror):
 *   POST   /admin/session           — exchange id_token for local JWT + refresh
 *   POST   /admin/session/refresh   — rotate refresh token
 *   POST   /admin/session/logout    — revoke refresh token + clear cookies
 *   GET    /admin/session/me        — return current session account + roles
 */

import { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  verifyIdToken,
  OidcDiscoveryError,
  OidcTokenVerificationError,
} from "../../core/auth/oidc.js";
import {
  lookupOrBootstrapRoles,
  issueSession,
  rotateRefreshToken,
  revokeRefreshToken,
  NoRoleMappingError,
  RefreshTokenError,
} from "../../core/auth/session.js";
import { env } from "../../config/env.js";
import { SYNTHETIC_SUPER_ADMIN } from "../../core/auth/types.js";
import pino from "pino";

const logger = pino({ name: "form:routes:session" });

// ---------------------------------------------------------------------------
// Cookie helper
// ---------------------------------------------------------------------------

interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  domain?: string;
  maxAge?: number;
}

function cookieOptions(maxAgeSeconds?: number): CookieOptions {
  const opts: CookieOptions = {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
  if (env.FORMS_SESSION_COOKIE_DOMAIN) {
    opts.domain = env.FORMS_SESSION_COOKIE_DOMAIN;
  }
  if (maxAgeSeconds !== undefined) {
    opts.maxAge = maxAgeSeconds;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function adminSessionRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /admin/session
  // Request body: { id_token: string }
  // Response: { access_token, expires_in, refresh_token, expires_at }
  // -------------------------------------------------------------------------

  fastify.post(
    "/admin/session",
    {
      schema: {
        tags: ["admin-session"],
        summary: "Exchange OIDC id_token for a form-api local JWT + refresh token",
        body: z.object({
          id_token: z.string().min(1),
        }),
        response: {
          200: z.object({
            access_token: z.string(),
            expires_in: z.number(),
            refresh_token: z.string(),
            expires_at: z.string(),
          }),
          401: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
          403: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
          503: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id_token } = request.body as { id_token: string };

      // Step 1: Verify ID token against auth-server JWKS
      let claims: Awaited<ReturnType<typeof verifyIdToken>>;
      try {
        claims = await verifyIdToken(id_token);
      } catch (err) {
        if (err instanceof OidcDiscoveryError) {
          return reply.status(503).send({
            error: {
              code: "oidc_discovery_failed",
              message:
                "Auth server is currently unreachable. Please try again later.",
            },
          });
        }
        if (err instanceof OidcTokenVerificationError) {
          return reply.status(401).send({
            error: {
              code: "invalid_id_token",
              message: err.message,
            },
          });
        }
        throw err;
      }

      const { sub } = claims;

      // Step 2: Look up form roles (or bootstrap super-admin)
      let roles: Awaited<ReturnType<typeof lookupOrBootstrapRoles>>;
      try {
        roles = await lookupOrBootstrapRoles(fastify.prisma, sub);
      } catch (err) {
        if (err instanceof NoRoleMappingError) {
          return reply.status(403).send({
            error: {
              code: "not_authorized",
              message: "No role mapping for this account",
            },
          });
        }
        throw err;
      }

      // Step 3: Issue access JWT + refresh token
      const session = await issueSession(fastify.prisma, {
        sub,
        roles: roles.roles,
        userAgent: request.headers["user-agent"],
        ipHash: request.ip,
      });

      logger.info({ sub, roles: roles.roles }, "Session issued");

      // Step 4: Set HttpOnly cookies
      void reply.setCookie(
        env.FORMS_SESSION_COOKIE_NAME,
        session.access_token,
        cookieOptions(session.expires_in)
      );
      void reply.setCookie(
        `${env.FORMS_SESSION_COOKIE_NAME}_refresh`,
        session.refresh_token,
        cookieOptions(30 * 24 * 3600) // 30 days
      );

      return reply.status(200).send({
        access_token: session.access_token,
        expires_in: session.expires_in,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /admin/session/refresh
  // -------------------------------------------------------------------------

  fastify.post(
    "/admin/session/refresh",
    {
      schema: {
        tags: ["admin-session"],
        summary: "Rotate the refresh token and issue a new access token",
        body: z.object({
          refresh_token: z.string().optional(),
        }),
        response: {
          200: z.object({
            access_token: z.string(),
            expires_in: z.number(),
            refresh_token: z.string(),
            expires_at: z.string(),
          }),
          401: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { refresh_token?: string } | null;
      const cookies = request.cookies as Record<string, string | undefined>;

      const refreshToken =
        body?.refresh_token ??
        cookies[`${env.FORMS_SESSION_COOKIE_NAME}_refresh`] ??
        null;

      if (!refreshToken) {
        return reply.status(401).send({
          error: {
            code: "unauthorized",
            message: "Refresh token required",
          },
        });
      }

      try {
        const result = await rotateRefreshToken(
          fastify.prisma,
          refreshToken,
          {
            userAgent: request.headers["user-agent"],
            ipHash: request.ip,
          }
        );

        void reply.setCookie(
          env.FORMS_SESSION_COOKIE_NAME,
          result.accessToken,
          cookieOptions(result.expiresInSeconds)
        );
        void reply.setCookie(
          `${env.FORMS_SESSION_COOKIE_NAME}_refresh`,
          result.newRefreshToken,
          cookieOptions(30 * 24 * 3600)
        );

        return reply.status(200).send({
          access_token: result.accessToken,
          expires_in: result.expiresInSeconds,
          refresh_token: result.newRefreshToken,
          expires_at: result.expiresAt.toISOString(),
        });
      } catch (err) {
        if (err instanceof RefreshTokenError) {
          return reply.status(401).send({
            error: {
              code: err.code,
              message: err.message,
            },
          });
        }
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // POST /admin/session/logout
  // -------------------------------------------------------------------------

  fastify.post(
    "/admin/session/logout",
    {
      schema: {
        tags: ["admin-session"],
        summary: "Revoke the refresh token and clear session cookies",
        body: z.object({
          refresh_token: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as { refresh_token?: string } | null;
      const cookies = request.cookies as Record<string, string | undefined>;

      const refreshToken =
        body?.refresh_token ??
        cookies[`${env.FORMS_SESSION_COOKIE_NAME}_refresh`] ??
        null;

      if (refreshToken) {
        try {
          await revokeRefreshToken(fastify.prisma, refreshToken);
        } catch {
          logger.warn(
            "Refresh token revocation failed (DB error) — clearing cookies anyway"
          );
        }
      }

      void reply.clearCookie(env.FORMS_SESSION_COOKIE_NAME, { path: "/" });
      void reply.clearCookie(`${env.FORMS_SESSION_COOKIE_NAME}_refresh`, {
        path: "/",
      });

      return reply.status(204).send();
    }
  );

  // -------------------------------------------------------------------------
  // GET /admin/session/me
  // -------------------------------------------------------------------------

  fastify.get(
    "/admin/session/me",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["admin-session"],
        summary: "Return the current session account and roles",
        response: {
          200: z.object({
            sub: z.string(),
            roles: z.array(z.string()),
            sid: z.string(),
            granted_at: z.string().nullable().optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      const session = request.session;

      // Break-glass synthetic super-admin
      if (session.sid === "break-glass") {
        return reply.status(200).send({
          sub: SYNTHETIC_SUPER_ADMIN.sub,
          roles: SYNTHETIC_SUPER_ADMIN.roles,
          sid: SYNTHETIC_SUPER_ADMIN.sid,
          granted_at: null,
        });
      }

      return reply.status(200).send({
        sub: session.sub,
        roles: session.roles,
        sid: session.sid,
        granted_at: null,
      });
    }
  );
}
