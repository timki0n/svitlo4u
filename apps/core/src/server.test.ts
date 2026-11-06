import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
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

describe("web app", () => {
  const dir = mkdtempSync(join(tmpdir(), "svitlo-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>svitlo4u</title>");
  writeFileSync(join(dir, "assets", "app-1a2b3c.js"), "console.log(1)");
  const app = buildServer({ ...loadConfig({}), logLevel: "silent", webDir: dir });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves index.html at / for revalidation, with a CSP", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("svitlo4u");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("caches hashed assets forever; /health stays an API route", async () => {
    const asset = await app.inject({ method: "GET", url: "/assets/app-1a2b3c.js" });
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.headers["cache-control"]).toBe("no-store");
  });

  it("is off without a built app", async () => {
    const bare = buildServer({ ...loadConfig({}), logLevel: "silent", webDir: join(dir, "nope") });
    expect((await bare.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    await bare.close();
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
      webDir: null,
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
