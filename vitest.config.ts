import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Wave 1: scaffold smoke tests (src/server.test.ts).
    // Wave 2 L5a: unit tests that do not need a live DB/Redis.
    // Phase 3A L7: integration tests (test/integration/**) — skipped automatically
    //   when DATABASE_URL is not set via describe.skipIf(!process.env.DATABASE_URL).
    include: ["src/**/*.test.ts", "test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
  },
});
