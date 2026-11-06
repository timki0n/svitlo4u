import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

describe("GET /health", () => {
  const app = buildServer({ ...loadConfig({}), logLevel: "silent", version: "test" });
  afterEach(async () => {
    await app.close();
  });

  it("reports ok, version and disables caching", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ status: "ok", version: "test" });
  });
});

describe("loadConfig", () => {
  it("uses defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "0.0.0.0",
      port: 8080,
      version: "dev",
      logLevel: "info",
    });
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/Invalid PORT/);
  });
});
