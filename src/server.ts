import { env } from "./config/env.js";

import pino from "pino";
import * as Sentry from "@sentry/node";
import Fastify, { type FastifyError } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";

import prismaPlugin from "./plugins/prisma.plugin.js";
import authSessionPlugin from "./plugins/auth.js";
import workspaceScopePlugin from "./plugins/workspace-scope.js";
import { adminSessionRoutes } from "./routes/admin/session.js";
import { formsAdminRoutes } from "./routes/admin/forms.js";
import { versionsAdminRoutes } from "./routes/admin/versions.js";
import { renderSpecPublicRoutes } from "./routes/public/render-spec.js";
import { submitPublicRoutes } from "./routes/public/submit.js";
import { submissionsAdminRoutes } from "./routes/admin/submissions.js";
import { eventsAdminRoutes } from "./routes/admin/events.js";
import { eventStatusPublicRoutes } from "./routes/public/event-status.js";
import { webhooksAdminRoutes } from "./routes/admin/webhooks.js";
import { filesPublicRoutes } from "./routes/public/files.js";
import { filesAdminRoutes } from "./routes/admin/files.js";
import { auditAdminRoutes } from "./routes/admin/audit.js";
import { tokensAdminRoutes } from "./routes/admin/tokens.js";
import { rolesAdminRoutes } from "./routes/admin/roles.js";
import { eventStatusInternalRoutes } from "./routes/internal/event-status.js";
import { publicAuthRoutes } from "./routes/public/auth.js";
import { prefillPublicRoutes } from "./routes/public/prefill.js";
import { templatesAdminRoutes } from "./routes/admin/templates.js";
import { paymentsAdminRoutes } from "./routes/admin/payments.js";
import { experimentsAdminRoutes } from "./routes/admin/experiments.js";
import { plansAdminRoutes } from "./routes/admin/plans.js"
import { billingAdminRoutes } from "./routes/admin/billing.js"
import { stripeWebhookInternalRoutes } from "./routes/internal/stripe-webhook.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function buildLogger() {
  if (env.NODE_ENV === "development" || env.LOG_LEVEL === "debug") {
    return pino(
      { level: env.LOG_LEVEL },
      pino.transport({ target: "pino-pretty", options: { colorize: true } })
    );
  }
  return pino({ level: env.LOG_LEVEL });
}

const logger = buildLogger();

// ---------------------------------------------------------------------------
// Sentry (optional — only initialised when SENTRY_DSN is set)
// ---------------------------------------------------------------------------

let sentryActive = false;

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
  });
  sentryActive = true;
  logger.info("Sentry initialised");
}

// ---------------------------------------------------------------------------
// Server factory — exported for integration tests via inject()
// ---------------------------------------------------------------------------

export async function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ---------------------------------------------------------------------------
  // Plugins (transport + security)
  // ---------------------------------------------------------------------------

  await app.register(cors, {
    origin: env.NODE_ENV === "production" ? false : true,
    credentials: true,
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });

  // ---------------------------------------------------------------------------
  // App plugins (DB + auth)
  // ---------------------------------------------------------------------------

  await app.register(prismaPlugin);
  await app.register(authSessionPlugin);
  // Phase 3C – L17: workspace scope middleware (AFTER auth, BEFORE admin routes)
  await app.register(workspaceScopePlugin);

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  app.get(
    "/healthz",
    {
      schema: {
        tags: ["ops"],
        description: "Liveness probe — always 200 when the process is up",
        response: {
          200: z.object({
            status: z.literal("ok"),
            service: z.literal("form-api"),
            version: z.string(),
          }),
        },
      },
    },
    async () => ({
      status: "ok" as const,
      service: "form-api" as const,
      version: "0.0.1",
    })
  );

  app.get("/readyz", async (_req, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      return { status: "ok" as const, checks: { db: "ok" } };
    } catch (err) {
      logger.error({ err }, "[readyz] db ping failed");
      return reply
        .status(503)
        .send({ status: "not_ready", checks: { db: "fail" } });
    }
  });

  // Admin surface — Wave 2 lanes.
  // No /v1 prefix: matches the cms-api convention and what form-admin expects.
  await app.register(adminSessionRoutes);
  await app.register(formsAdminRoutes);
  await app.register(templatesAdminRoutes);
  await app.register(versionsAdminRoutes);
  await app.register(renderSpecPublicRoutes);
  await app.register(submitPublicRoutes);
  await app.register(submissionsAdminRoutes);
  await app.register(eventsAdminRoutes);
  await app.register(eventStatusPublicRoutes);
  await app.register(webhooksAdminRoutes);
  await app.register(filesPublicRoutes);
  await app.register(filesAdminRoutes);
  await app.register(auditAdminRoutes);
  await app.register(tokensAdminRoutes);
  await app.register(rolesAdminRoutes);
  await app.register(eventStatusInternalRoutes);
  await app.register(publicAuthRoutes);
  await app.register(prefillPublicRoutes);
  await app.register(paymentsAdminRoutes);
  await app.register(experimentsAdminRoutes);
  await app.register(plansAdminRoutes);
  await app.register(billingAdminRoutes);
  await app.register(stripeWebhookInternalRoutes);

  // ---------------------------------------------------------------------------
  // Global error handler — uniform { error: { code, message } } envelope
  // ---------------------------------------------------------------------------

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500 && sentryActive) {
      Sentry.captureException(error);
    }
    logger.error({ err: error }, "Request error");
    return reply.status(statusCode).send({
      error: {
        code:
          statusCode === 500
            ? "internal"
            : (error.code ?? String(statusCode)),
        message:
          env.NODE_ENV === "production" && statusCode >= 500
            ? "Internal server error"
            : error.message,
      },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({
      error: { code: "not_found", message: "Route not found" },
    })
  );

  return app;
}

// ---------------------------------------------------------------------------
// Entrypoint — only runs when this module is executed directly, not in tests
// ---------------------------------------------------------------------------

async function main() {
  const server = await buildServer();

  const shutdown = async (signal: string) => {
    server.log.info({ signal }, "Shutdown signal received");
    await server.close();
    if (sentryActive) {
      await Sentry.close(2000);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await server.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    server.log.fatal({ err }, "Failed to start server");
    process.exit(1);
  }
}

const isMain =
  process.argv[1] != null &&
  (await import("url")).fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  await main();
}
