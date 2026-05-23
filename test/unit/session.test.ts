/**
 * Unit tests for session.ts (JWT sign/verify round-trip).
 *
 * No live DB is required — only the JWT functions are tested here.
 * Prisma-touching functions (issueSession, rotateRefreshToken, etc.) are
 * covered by integration tests in test/integration/.
 */

// Set env vars before any module that imports env.ts is evaluated.
// vitest hoists vi.mock calls but plain assignments happen in source order,
// so we set them here — at the very top of the file — before static imports.
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:55438/test";
process.env["FORMS_JWT_SECRET"] = "test-jwt-secret-must-be-at-least-32-chars!!";
process.env["FORMS_ACCESS_TOKEN_TTL"] = "15m";
process.env["FORMS_REFRESH_TOKEN_TTL"] = "30d";

import { describe, it, expect } from "vitest";
// Dynamic imports in tests so that env vars are set before modules load.
// We use top-level await (ESM) for setup.

const { signAccessToken, verifyAccessToken, parseTtlToSeconds } = await import(
  "../../src/core/auth/session.js"
);
import type { FormRole } from "../../src/core/auth/types.js";

describe("signAccessToken + verifyAccessToken", () => {
  it("round-trips a super-admin session payload", async () => {
    const roles: FormRole[] = ["super-admin"];
    const { token, expiresInSeconds, expiresAt } = await signAccessToken({
      sub: "user-uuid-v7-abc",
      roles,
      sid: "refresh-token-opaque-id",
    });

    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3); // three-part JWT
    expect(expiresInSeconds).toBe(15 * 60); // 900 seconds
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const payload = await verifyAccessToken(token);
    expect(payload.sub).toBe("user-uuid-v7-abc");
    expect(payload.roles).toEqual(["super-admin"]);
    expect(payload.sid).toBe("refresh-token-opaque-id");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("round-trips an editor session payload", async () => {
    const roles: FormRole[] = ["editor"];
    const { token } = await signAccessToken({
      sub: "editor-account-id",
      roles,
      sid: "sid-editor",
    });

    const payload = await verifyAccessToken(token);
    expect(payload.roles).toEqual(["editor"]);
    expect(payload.sub).toBe("editor-account-id");
  });

  it("rejects a tampered token", async () => {
    const { token } = await signAccessToken({
      sub: "legit-user",
      roles: ["viewer"],
      sid: "legit-sid",
    });

    // Tamper with the payload part (middle segment)
    const parts = token.split(".");
    parts[1] = Buffer.from(
      JSON.stringify({ sub: "attacker", roles: ["super-admin"], sid: "evil" })
    ).toString("base64url");
    const tampered = parts.join(".");

    await expect(verifyAccessToken(tampered)).rejects.toThrow();
  });

  it("rejects a JWT signed with a different secret", async () => {
    const { SignJWT } = await import("jose");
    const wrongSecret = new TextEncoder().encode(
      "wrong-secret-that-is-different-from-env-secret!!"
    );
    const bad = await new SignJWT({
      sub: "user",
      roles: ["super-admin"],
      sid: "sid",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(wrongSecret);

    await expect(verifyAccessToken(bad)).rejects.toThrow();
  });
});

describe("parseTtlToSeconds", () => {
  it("converts correctly", () => {
    expect(parseTtlToSeconds("15m")).toBe(900);
    expect(parseTtlToSeconds("30d")).toBe(30 * 86400);
    expect(parseTtlToSeconds("1h")).toBe(3600);
    expect(parseTtlToSeconds("60s")).toBe(60);
  });

  it("throws on invalid format", () => {
    expect(() => parseTtlToSeconds("15x")).toThrow(/Invalid TTL/);
    expect(() => parseTtlToSeconds("abc")).toThrow(/Invalid TTL/);
  });
});
