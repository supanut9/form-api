import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Wave 1: only run the scaffold smoke tests (src/server.test.ts).
    // Wave 2 L5a: also include unit tests that do not need a live DB/Redis.
    // Integration/e2e tests require a live Postgres + Redis + MinIO stack
    // and will be wired into CI in Wave 6 / Lane L16.
    include: ["src/**/*.test.ts", "test/unit/**/*.test.ts"],
  },
});
