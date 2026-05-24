// Prisma 7 requires a driver adapter — the database URL is passed via the adapter,
// not in schema.prisma. We use @prisma/adapter-pg backed by the pg connection string.
//
// Lane L5a (OIDC) wires the Fastify onClose hook to call prisma.$disconnect().
// This module only exposes the singleton; do NOT register lifecycle hooks here.
// Do NOT import auth code from this file — that is L5's surface.
//
// Phase 3C – L17: workspace-scope query extension injected here via $extends.
// The extension reads workspaceId from AsyncLocalStorage and appends a
// `where: { workspaceId }` clause on queries for workspace-owned models.
// Queries executed OUTSIDE a workspace context are untouched, preserving
// backward compatibility with Phase 1 / 3A / 3B code paths.
//
// Models scoped: FormDefinition, FormTemplate, FormWebhook, ApiToken, AuditLog.
// Backfilled rows have workspaceId = null; they stay invisible to workspace-scoped
// queries until 3C.3 adds the NOT NULL constraint.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@prisma/client";
import { getWorkspaceId } from "./workspace-context.js";

// ---------------------------------------------------------------------------
// Workspace-scoped models
// ---------------------------------------------------------------------------

const WORKSPACE_SCOPED_MODELS: ReadonlySet<string> = new Set([
  "FormDefinition",
  "FormTemplate",
  "FormWebhook",
  "ApiToken",
  "AuditLog",
])

// Operations that accept a `where` argument
const WHERE_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
])

// ---------------------------------------------------------------------------
// Prisma $extends query extension
// ---------------------------------------------------------------------------

const workspaceScopeExtension = Prisma.defineExtension({
  name: "workspace-scope",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const workspaceId = getWorkspaceId()

        if (
          workspaceId &&
          model != null &&
          WORKSPACE_SCOPED_MODELS.has(model) &&
          WHERE_OPS.has(operation)
        ) {
          // Inject workspaceId filter without clobbering existing where clauses
          const extArgs = args as { where?: Record<string, unknown> }
          extArgs.where = {
            ...(extArgs.where ?? {}),
            workspaceId,
          }
          return query(extArgs)
        }

        return query(args)
      },
    },
  },
})

// ---------------------------------------------------------------------------
// Build the extended client
// ---------------------------------------------------------------------------

// Validate DATABASE_URL at import time so startup fails loudly if unset.
const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

type ExtendedPrismaClient = ReturnType<typeof buildPrismaClient>

// Extend globalThis to hold the singleton across hot-reloads in development.
const globalForPrisma = globalThis as unknown as {
  prisma: ExtendedPrismaClient | undefined;
};

function buildPrismaClient() {
  const adapter = new PrismaPg(connectionString as string);

  const base = new PrismaClient({
    adapter,
    log:
      process.env["NODE_ENV"] === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

  return base.$extends(workspaceScopeExtension)
}

export const prisma: ExtendedPrismaClient =
  globalForPrisma.prisma ?? buildPrismaClient();

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.prisma = prisma;
}

// Re-export context helpers so callers can import from one place
export { withWorkspaceContext, getWorkspaceId } from "./workspace-context.js";
