/**
 * Break-glass emergency token gate (bearer-header variant).
 *
 * Mirrors cms-api/src/core/auth/break-glass.ts using FORMS_EMERGENCY_TOKEN.
 *
 * When FORMS_EMERGENCY_TOKEN is set and an incoming Authorization: Bearer <token>
 * matches it exactly (constant-time compare), the request is granted a synthetic
 * super-admin session and an audit log entry is written loudly (level WARN).
 *
 * IMPORTANT: This reads process.env["FORMS_EMERGENCY_TOKEN"] directly on every
 * call — NOT the cached env object — so rotating the env var in production takes
 * effect without a process restart.
 *
 * Every single use must appear in the audit log.
 */

import { type FastifyRequest, type FastifyReply } from "fastify";
import { SYNTHETIC_SUPER_ADMIN_SESSION } from "./types.js";
import pino from "pino";

const logger = pino({ name: "form:break-glass" });

// ---------------------------------------------------------------------------
// Audit log helper
// ---------------------------------------------------------------------------

interface AuditEntry {
  action: string;
  actor_account_id: string | null;
  subject_type: string;
  subject_id: string;
  diff_json: Record<string, unknown>;
}

/**
 * Writes a loud audit log entry. Persists to form_audit_log when available.
 */
async function auditLog(entry: AuditEntry): Promise<void> {
  logger.warn(
    {
      audit: true,
      action: entry.action,
      actor_account_id: entry.actor_account_id,
      subject_type: entry.subject_type,
      subject_id: entry.subject_id,
      diff_json: entry.diff_json,
    },
    `AUDIT: ${entry.action}`
  );

  // Persist to DB if available (graceful degradation if L4 not yet ready)
  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).auditLog.create({
      data: {
        actorAccountId: entry.actor_account_id,
        action: entry.action,
        subjectType: entry.subject_type,
        subjectId: entry.subject_id,
        diffJson: entry.diff_json,
      },
    });
    await prisma.$disconnect();
  } catch {
    logger.warn(
      "Audit log persistence failed (DB unavailable) — logged to stdout only"
    );
  }
}

// ---------------------------------------------------------------------------
// Break-glass check
// ---------------------------------------------------------------------------

function extractBearer(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

/**
 * Checks if the request carries the emergency token.
 * If so, sets request.session to the synthetic super-admin and fires an audit log.
 * Returns true if break-glass was activated, false otherwise.
 *
 * Must be called as the FIRST step in any auth preHandler.
 *
 * Reads process.env["FORMS_EMERGENCY_TOKEN"] directly (not the compiled env
 * singleton) so token rotation takes effect without restarting the server.
 */
export async function checkBreakGlass(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<boolean> {
  // Direct process.env read — intentional. Do NOT use env.FORMS_EMERGENCY_TOKEN
  // here because the env singleton is evaluated once at startup.
  const emergencyToken = process.env["FORMS_EMERGENCY_TOKEN"];

  if (!emergencyToken) {
    return false;
  }

  const bearer = extractBearer(request);
  if (!bearer) return false;

  if (!safeEqual(bearer, emergencyToken)) {
    return false;
  }

  // BREAK-GLASS ACTIVATED
  request.session = {
    ...SYNTHETIC_SUPER_ADMIN_SESSION,
    iat: Math.floor(Date.now() / 1000),
  };

  await auditLog({
    action: "EMERGENCY_ACCESS",
    actor_account_id: null,
    subject_type: "system",
    subject_id: "emergency-token",
    diff_json: {
      route: request.url,
      method: request.method,
      ip: request.ip,
      timestamp: new Date().toISOString(),
    },
  });

  return true;
}

/**
 * Constant-time string comparison (prevents timing side-channels).
 */
function safeEqual(a: string, b: string): boolean {
  let diff = 0;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  // Also factor in length difference so equal-prefix strings don't match
  diff |= a.length ^ b.length;
  return diff === 0;
}
