/**
 * RBAC policy engine using @casl/ability v6.
 *
 * Mirrors cms-api/src/core/auth/rbac.ts for the form-api admin domain.
 *
 * `buildAbilityFromRoles(roles)` builds a CASL MongoAbility from the session roles.
 * `requirePermission(action, subject)` returns a Fastify preHandler.
 *
 * request.session must be set by the auth-session plugin before requirePermission
 * preHandlers run.
 */

import {
  AbilityBuilder,
  createMongoAbility,
  type MongoAbility,
  type SubjectType,
} from "@casl/ability";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { type FormRole } from "./types.js";
import pino from "pino";

const logger = pino({ name: "form:rbac" });

// ---------------------------------------------------------------------------
// Form subjects and actions
// ---------------------------------------------------------------------------

export type FormAction =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "publish"
  | "manage";

export type FormSubject =
  | "Form"
  | "FormVersion"
  | "FormTemplate"
  | "Submission"
  | "FormEvent"
  | "Webhook"
  | "ApiToken"
  | "Role"
  | "Permission"
  | "AuditLog"
  | "all";

export type FormAbility = MongoAbility<[FormAction, FormSubject]>;

// ---------------------------------------------------------------------------
// Static role definitions
// Phase 1: static abilities; Phase 2 will layer in form_permission DB rows.
// ---------------------------------------------------------------------------

function buildStaticAbility(roles: FormRole[]): FormAbility {
  const { can, cannot, build } = new AbilityBuilder<FormAbility>(
    createMongoAbility
  );

  for (const role of roles) {
    switch (role) {
      case "super-admin":
        can("manage", "all");
        break;

      case "editor":
        can("read", "Form");
        can(["create", "read", "update", "delete", "publish"], "FormVersion");
        can(["create", "read", "update", "delete", "publish"], "Form");
        can(["read", "delete"], "Submission");
        can("read", "AuditLog");
        can("manage", "FormEvent");
        can("manage", "Webhook");
        can("manage", "FormTemplate");
        cannot("manage", "ApiToken");
        cannot("manage", "Role");
        cannot("manage", "Permission");
        break;

      case "viewer":
        can("read", "Form");
        can("read", "FormVersion");
        can("read", "FormTemplate");
        can("read", "Submission");
        break;
    }
  }

  return build();
}

// ---------------------------------------------------------------------------
// Per-request ability cache
// ---------------------------------------------------------------------------

const abilityCache = new WeakMap<FastifyRequest, FormAbility>();

export async function getAbility(
  request: FastifyRequest
): Promise<FormAbility> {
  const cached = abilityCache.get(request);
  if (cached) return cached;

  const session = request.session;
  const roles: FormRole[] = session?.roles ?? [];

  let ability: FormAbility;
  try {
    ability = buildStaticAbility(roles);

    // Phase 2 extension point: merge with form_permission rows from DB
    try {
      ability = await buildAbilityWithDbPermissions(roles, ability);
    } catch {
      logger.debug(
        "DB permissions unavailable, using static role abilities"
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to build ability — defaulting to deny-all");
    ability = buildStaticAbility([]);
  }

  abilityCache.set(request, ability);
  return ability;
}

/**
 * Augments the base ability with custom permissions from the form_permission table.
 * Phase 1: returns the static ability unchanged if no DB permissions exist.
 */
async function buildAbilityWithDbPermissions(
  roles: FormRole[],
  baseAbility: FormAbility
): Promise<FormAbility> {
  const { PrismaClient } = await import("@prisma/client");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma = new PrismaClient() as any;

  try {
    const dbRoles = await prisma.role.findMany({
      where: { name: { in: roles } },
      include: { permissions: true },
    });

    if (!dbRoles || dbRoles.length === 0) return baseAbility;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allPermissions = dbRoles.flatMap((r: any) => r.permissions ?? []);
    if (allPermissions.length === 0) return baseAbility;

    const { can, build } = new AbilityBuilder<FormAbility>(createMongoAbility);

    for (const role of roles) {
      applyStaticRules(role, can, () => {});
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const perm of allPermissions) {
      can(perm.action as FormAction, perm.subject as FormSubject);
    }

    return build();
  } finally {
    await prisma.$disconnect();
  }
}

type CanFn = (
  action: FormAction | FormAction[],
  subject: FormSubject | SubjectType
) => void;

function applyStaticRules(
  role: FormRole,
  can: CanFn,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _cannot: CanFn
): void {
  switch (role) {
    case "super-admin":
      can("manage", "all");
      break;
    case "editor":
      can("read", "Form");
      can(["create", "read", "update", "delete", "publish"], "FormVersion");
      can(["create", "read", "update", "delete", "publish"], "Form");
      can(["read", "delete"], "Submission");
      can("read", "AuditLog");
      can("manage", "FormEvent");
      can("manage", "Webhook");
      can("manage", "FormTemplate");
      break;
    case "viewer":
      can("read", "Form");
      can("read", "FormVersion");
      can("read", "FormTemplate");
      can("read", "Submission");
      break;
  }
}

// ---------------------------------------------------------------------------
// requirePermission — Fastify preHandler factory
// ---------------------------------------------------------------------------

/**
 * Returns a Fastify preHandler that enforces the given action + subject.
 * request.session must already be set (by fastify.authenticate).
 *
 * Usage:
 *   fastify.delete('/admin/forms/:id', {
 *     preHandler: [fastify.authenticate, requirePermission('delete', 'Form')],
 *   }, handler)
 */
export function requirePermission(
  action: FormAction,
  subject: FormSubject
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const ability = await getAbility(request);

    if (ability.cannot(action, subject)) {
      logger.warn(
        {
          sub: request.session?.sub,
          roles: request.session?.roles,
          action,
          subject,
        },
        "RBAC: access denied"
      );
      return reply.status(403).send({
        error: {
          code: "forbidden",
          message: `You do not have permission to ${action} ${subject}`,
        },
      });
    }
  };
}

/**
 * Convenience export for building an ability directly from role names.
 * Useful for tests and non-request contexts.
 */
export function buildAbilityFromRoles(roleNames: FormRole[]): FormAbility {
  return buildStaticAbility(roleNames);
}

/**
 * Convenience for tests — equivalent to `buildAbilityFromRoles(['super-admin'])`.
 * Returns an ability that passes every `can(action, subject)` check.
 */
export function buildSuperAdminAbility(): FormAbility {
  return buildStaticAbility(["super-admin"] as FormRole[]);
}
