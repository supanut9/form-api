import { defineConfig, env } from "prisma/config";

// Prisma 7 config file.
// The datasource URL is provided here (for `prisma migrate` / introspection)
// rather than in schema.prisma, which is the Prisma 7 requirement.
// The PrismaClient itself receives the URL via a driver adapter; see src/lib/prisma.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
