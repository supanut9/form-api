import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "./server.js";

describe("GET /healthz", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with { status: 'ok', service: 'form-api', version }", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      status: string;
      service: string;
      version: string;
    }>();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("form-api");
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });
});
