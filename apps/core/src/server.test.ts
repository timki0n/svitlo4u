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
      dbPath: "data/svitlo4u.db",
      sitesPath: "config/sites.yaml",
      udpPort: 5005,
      mqttUrl: null,
      mqttUser: "core",
      mqttPassword: null,
      publicUrl: null,
      telegramUpdates: "polling",
      apiRatePerMinute: 120,
    });
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/Invalid PORT/);
  });

  it("uses Telegram webhooks once there is a public URL", () => {
    const config = loadConfig({ PUBLIC_URL: "https://svitlo4u.info/" });
    expect(config.publicUrl).toBe("https://svitlo4u.info");
    expect(config.telegramUpdates).toBe("webhook");
    expect(loadConfig({ TELEGRAM_UPDATES: "off" }).telegramUpdates).toBe("off");
    expect(() => loadConfig({ PUBLIC_URL: "http://svitlo4u.info" })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ PUBLIC_URL: "https://svitlo4u.info/app" })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ TELEGRAM_UPDATES: "webhook" })).toThrow(/needs PUBLIC_URL/);
  });
});
