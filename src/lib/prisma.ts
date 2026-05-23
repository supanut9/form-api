// Prisma 7 requires a driver adapter — the database URL is passed via the adapter,
// not in schema.prisma. We use @prisma/adapter-pg backed by the pg connection string.
//
// Lane L5a (OIDC) wires the Fastify onClose hook to call prisma.$disconnect().
// This module only exposes the singleton; do NOT register lifecycle hooks here.
// Do NOT import auth code from this file — that is L5's surface.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

// Validate DATABASE_URL at import time so startup fails loudly if unset.
const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

// Extend globalThis to hold the singleton across hot-reloads in development.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function buildPrismaClient(): PrismaClient {
  // PrismaPg accepts a connection string directly.
  const adapter = new PrismaPg(connectionString as string);

  return new PrismaClient({
    adapter,
    log:
      process.env["NODE_ENV"] === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? buildPrismaClient();

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.prisma = prisma;
}
