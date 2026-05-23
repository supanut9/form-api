/**
 * Unit tests for break-glass.ts
 *
 * These tests do not require a live DB — the audit log persistence is
 * gracefully skipped when Prisma is not connected (handled by the try/catch
 * in break-glass.ts).
 */

// Set required env vars before any module importing env.ts is loaded.
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:55438/test";
process.env["FORMS_JWT_SECRET"] = "break-glass-test-secret-32-chars!!!";
process.env["FORMS_ACCESS_TOKEN_TTL"] = "15m";
process.env["FORMS_REFRESH_TOKEN_TTL"] = "30d";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We mock the PrismaClient import inside break-glass.ts so DB calls
// are no-ops in unit tests.
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    auditLog = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (_data: any) => ({}),
    };
    $disconnect = async () => {};
  },
}));

import { checkBreakGlass } from "../../src/core/auth/break-glass.js";
import { SYNTHETIC_SUPER_ADMIN_SESSION } from "../../src/core/auth/types.js";

// Minimal FastifyRequest stub
function makeRequest(overrides: {
  authorization?: string;
  url?: string;
  method?: string;
  ip?: string;
}) {
  return {
    headers: {
      authorization: overrides.authorization,
    },
    url: overrides.url ?? "/admin/session/me",
    method: overrides.method ?? "GET",
    ip: overrides.ip ?? "127.0.0.1",
    session: undefined as unknown,
  };
}

// Minimal FastifyReply stub
const fakeReply = {} as import("fastify").FastifyReply;

describe("checkBreakGlass", () => {
  const ORIGINAL_ENV = process.env["FORMS_EMERGENCY_TOKEN"];

  beforeEach(() => {
    delete process.env["FORMS_EMERGENCY_TOKEN"];
  });

  afterEach(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env["FORMS_EMERGENCY_TOKEN"] = ORIGINAL_ENV;
    } else {
      delete process.env["FORMS_EMERGENCY_TOKEN"];
    }
  });

  it("returns false when FORMS_EMERGENCY_TOKEN is not set", async () => {
    const req = makeRequest({ authorization: "Bearer some-token" });
    const result = await checkBreakGlass(
      req as unknown as import("fastify").FastifyRequest,
      fakeReply
    );
    expect(result).toBe(false);
    expect(req.session).toBeUndefined();
  });

  it("returns false when Authorization header is missing", async () => {
    process.env["FORMS_EMERGENCY_TOKEN"] = "secret-emergency";
    const req = makeRequest({});
    const result = await checkBreakGlass(
      req as unknown as import("fastify").FastifyRequest,
      fakeReply
    );
    expect(result).toBe(false);
  });

  it("returns false when bearer token does not match", async () => {
    process.env["FORMS_EMERGENCY_TOKEN"] = "correct-secret";
    const req = makeRequest({ authorization: "Bearer wrong-secret" });
    const result = await checkBreakGlass(
      req as unknown as import("fastify").FastifyRequest,
      fakeReply
    );
    expect(result).toBe(false);
    expect(req.session).toBeUndefined();
  });

  it("grants access and sets synthetic session when token matches", async () => {
    process.env["FORMS_EMERGENCY_TOKEN"] = "test-emergency-token";
    const req = makeRequest({
      authorization: "Bearer test-emergency-token",
    });
    const result = await checkBreakGlass(
      req as unknown as import("fastify").FastifyRequest,
      fakeReply
    );
    expect(result).toBe(true);
    const session = req.session as typeof SYNTHETIC_SUPER_ADMIN_SESSION;
    expect(session.sub).toBe("emergency-break-glass");
    expect(session.roles).toContain("super-admin");
    expect(session.sid).toBe("break-glass");
    expect(session.exp).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("constant-time compare rejects prefix-matching shorter token", async () => {
    process.env["FORMS_EMERGENCY_TOKEN"] = "longersecret";
    const req = makeRequest({ authorization: "Bearer longer" });
    const result = await checkBreakGlass(
      req as unknown as import("fastify").FastifyRequest,
      fakeReply
    );
    expect(result).toBe(false);
  });

  it("picks up a rotated token without module reload", async () => {
    process.env["FORMS_EMERGENCY_TOKEN"] = "first-token";
    const req1 = makeRequest({ authorization: "Bearer first-token" });
    expect(
      await checkBreakGlass(
        req1 as unknown as import("fastify").FastifyRequest,
        fakeReply
      )
    ).toBe(true);

    // Rotate the token
    process.env["FORMS_EMERGENCY_TOKEN"] = "second-token";

    // Old token no longer works
    const req2 = makeRequest({ authorization: "Bearer first-token" });
    expect(
      await checkBreakGlass(
        req2 as unknown as import("fastify").FastifyRequest,
        fakeReply
      )
    ).toBe(false);

    // New token works immediately (no restart)
    const req3 = makeRequest({ authorization: "Bearer second-token" });
    expect(
      await checkBreakGlass(
        req3 as unknown as import("fastify").FastifyRequest,
        fakeReply
      )
    ).toBe(true);
  });
});
