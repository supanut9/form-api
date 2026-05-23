/**
 * Fastify auth-session plugin (cms-api mirror).
 *
 * Registers @fastify/jwt and decorates:
 *   fastify.authenticate(request, reply)
 *     — checks break-glass first, then verifies local JWT, sets request.session
 *
 * This plugin is separate from the existing auth.plugin.ts (which handles the
 * /v1/auth/callback flow and decorates request.account). Both co-exist:
 *   - request.account  → used by /v1/auth/* routes (L1 pattern)
 *   - request.session  → used by /admin/session/* routes (this plugin)
 *
 * NOTE: @fastify/jwt is already registered by auth.plugin.ts. This plugin
 * skips re-registering it to avoid duplicate plugin errors — it reads the
 * secret from env for its own jose-based verification.
 */

import fp from "fastify-plugin";
import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../core/auth/session.js";
import { checkBreakGlass } from "../core/auth/break-glass.js";
import pino from "pino";

const logger = pino({ name: "form:auth-session-plugin" });

async function authSessionPlugin(fastify: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Decorate fastify with authenticate preHandler
  // -------------------------------------------------------------------------

  fastify.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // 1. Check break-glass first (reads process.env directly for rotation)
        const isEmergency = await checkBreakGlass(request, reply);
        if (isEmergency) return;

        // 2. Extract token from Authorization header or cookie
        const token = extractToken(request);

        if (!token) {
          return reply.status(401).send({
            error: {
              code: "unauthorized",
              message: "Missing authentication token",
            },
          });
        }

        // 3. Verify local JWT (FORMS_JWT_SECRET)
        const session = await verifyAccessToken(token);
        request.session = session;
      } catch (err) {
        logger.debug({ err }, "Session authentication failed");
        return reply.status(401).send({
          error: {
            code: "unauthorized",
            message: "Invalid or expired authentication token",
          },
        });
      }
    }
  );

  // Optional auth: populates request.session if a valid token is present,
  // otherwise silently continues. Used on routes that serve both authenticated
  // and anonymous traffic (e.g. /public/forms/:slug/submit). Never returns a
  // 401 — bad tokens are treated the same as no token.
  fastify.decorate(
    "maybeAuthenticate",
    async (request: FastifyRequest) => {
      const token = extractToken(request);
      if (!token) return;
      try {
        request.session = await verifyAccessToken(token);
      } catch (err) {
        logger.debug({ err }, "maybeAuthenticate: ignoring invalid token");
      }
    }
  );
}

declare module "fastify" {
  interface FastifyInstance {
    maybeAuthenticate(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<void>;
  }
}

/**
 * Extracts the JWT from:
 *   1. Authorization: Bearer <token> header
 *   2. Cookie named FORMS_SESSION_COOKIE_NAME
 */
function extractToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  const cookieName = env.FORMS_SESSION_COOKIE_NAME;
  const cookies = request.cookies as Record<string, string | undefined>;
  const cookieToken = cookies[cookieName];
  if (cookieToken) return cookieToken;

  return null;
}

export default fp(authSessionPlugin, {
  name: "form-auth-session",
  fastify: "5.x",
  // prisma-plugin must be registered before this one so request.prisma is
  // available when the auth plugin queries sessions / roles.
  dependencies: ["prisma-plugin"],
});
