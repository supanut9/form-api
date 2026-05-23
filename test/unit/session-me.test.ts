/**
 * Unit test: GET /admin/session/me with break-glass token.
 *
 * Builds a minimal Fastify app (no DB, no Redis, no external deps) that
 * registers only the authenticate decorator and the session routes.
 * Verifies that a break-glass bearer token returns the synthetic super-admin
 * payload.
 */

// Set env vars at the very top — before any import chain that loads env.ts.
process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:55438/test";
process.env["FORMS_JWT_SECRET"] = "session-me-test-secret-must-be-32chars!";
process.env["FORMS_ACCESS_TOKEN_TTL"] = "15m";
process.env["FORMS_REFRESH_TOKEN_TTL"] = "30d";
process.env["FORMS_OIDC_CLIENT_ID"] = "form-admin-test";
process.env["FORMS_SESSION_COOKIE_NAME"] = "forms_session";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";

// Mock @prisma/client so no real DB connection is attempted
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    auditLog = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (_data: any) => ({}),
    };
    $connect = async () => {};
    $disconnect = async () => {};
  },
}));

const TEST_EMERGENCY = "test-emergency-me";

let app: FastifyInstance;

async function buildTestApp(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  await server.register(cookie);

  // Stub prisma decorator — routes need fastify.prisma even though these
  // specific tests don't exercise DB paths
  server.decorate("prisma", {} as import("fastify").FastifyInstance["prisma"]);

  // Build authenticate inline (without the full auth.plugin.ts
  // dependency chain) so we can test it in isolation.
  const { checkBreakGlass } = await import(
    "../../src/core/auth/break-glass.js"
  );
  const { verifyAccessToken } = await import(
    "../../src/core/auth/session.js"
  );
  const { env } = await import("../../src/config/env.js");

  const testAuthPlugin = fp(
    async (fastify: FastifyInstance) => {
      fastify.decorate(
        "authenticate",
        async (request: FastifyRequest, reply: FastifyReply) => {
          const isEmergency = await checkBreakGlass(request, reply);
          if (isEmergency) return;

          const authHeader = request.headers.authorization;
          const token = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7).trim()
            : null;

          const cookieName = env.FORMS_SESSION_COOKIE_NAME;
          const cookieToken = (
            request.cookies as Record<string, string | undefined>
          )[cookieName];

          const finalToken = token ?? cookieToken ?? null;

          if (!finalToken) {
            return reply.status(401).send({
              error: { code: "unauthorized", message: "Missing token" },
            });
          }
          try {
            request.session = await verifyAccessToken(finalToken);
          } catch {
            return reply.status(401).send({
              error: { code: "unauthorized", message: "Invalid token" },
            });
          }
        }
      );
    },
    { name: "test-auth-session" }
  );

  await server.register(testAuthPlugin);

  const { adminSessionRoutes } = await import(
    "../../src/routes/admin/session.js"
  );
  await server.register(adminSessionRoutes);

  return server;
}

beforeAll(async () => {
  app = await buildTestApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env["FORMS_EMERGENCY_TOKEN"];
});

describe("GET /admin/session/me — break-glass", () => {
  it("returns 401 when no token is provided and emergency token is unset", async () => {
    delete process.env["FORMS_EMERGENCY_TOKEN"];
    const response = await app.inject({
      method: "GET",
      url: "/admin/session/me",
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 when FORMS_EMERGENCY_TOKEN is unset and bearer is not a valid JWT", async () => {
    delete process.env["FORMS_EMERGENCY_TOKEN"];
    const response = await app.inject({
      method: "GET",
      url: "/admin/session/me",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 200 with synthetic super-admin when break-glass token matches", async () => {
    process.env["FORMS_EMERGENCY_TOKEN"] = TEST_EMERGENCY;

    const response = await app.inject({
      method: "GET",
      url: "/admin/session/me",
      headers: { authorization: `Bearer ${TEST_EMERGENCY}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      sub: string;
      roles: string[];
      sid: string;
      granted_at: null;
    }>();
    expect(body.sub).toBe("emergency-break-glass");
    expect(body.roles).toContain("super-admin");
    expect(body.sid).toBe("break-glass");
    expect(body.granted_at).toBeNull();
  });

  it("returns 401 after FORMS_EMERGENCY_TOKEN is rotated away (no restart)", async () => {
    process.env["FORMS_EMERGENCY_TOKEN"] = TEST_EMERGENCY;

    // First call succeeds
    const res1 = await app.inject({
      method: "GET",
      url: "/admin/session/me",
      headers: { authorization: `Bearer ${TEST_EMERGENCY}` },
    });
    expect(res1.statusCode).toBe(200);

    // Rotate token in-place — no server restart
    process.env["FORMS_EMERGENCY_TOKEN"] = "new-emergency-value";

    // Old token now rejected
    const res2 = await app.inject({
      method: "GET",
      url: "/admin/session/me",
      headers: { authorization: `Bearer ${TEST_EMERGENCY}` },
    });
    expect(res2.statusCode).toBe(401);

    // New token accepted
    const res3 = await app.inject({
      method: "GET",
      url: "/admin/session/me",
      headers: { authorization: "Bearer new-emergency-value" },
    });
    expect(res3.statusCode).toBe(200);
    expect(res3.json<{ sub: string }>().sub).toBe("emergency-break-glass");
  });
});
