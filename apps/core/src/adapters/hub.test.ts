import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { HubDeviceConfig } from "../sites-config.ts";
import { type HubReportEvent, HubVerifier, registerHubRoutes, signHub } from "./hub.ts";

const SECRET = "hub-secret";
const device: HubDeviceConfig = {
  id: "hub-2a4c11",
  kind: "hub",
  secretEnv: "HUB_SECRET",
  silentAlertMs: 120_000,
  firmware: "latest",
  siteId: "test",
  secret: SECRET,
};

function body(fields: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    dev: "hub-2a4c11",
    boot: "9f3a1c2e",
    seq: 0,
    up: 30.5,
    rst: "poweron",
    fw: "0.1.0",
    plug: { paired: true, mains: "on", since: 0.6, voltage: 228.4, rssi: -61 },
    events: [],
    ...fields,
  });
}

const verify = (v: HubVerifier, raw: string, sig = signHub(SECRET, raw)) =>
  v.verify(Buffer.from(raw), sig, "1.2.3.4", 1000);

describe("hub verifier", () => {
  it("accepts a signed report and translates it", () => {
    const v = new HubVerifier([device]);
    const raw = body({ events: [{ up: 12.25, mains: "on" }] });
    const result = verify(v, raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      siteId: "test",
      deviceId: "hub-2a4c11",
      t: 1000,
      boot: "9f3a1c2e",
      seq: 0,
      up: 30.5,
      rst: "poweron",
      fw: "0.1.0",
      paired: true,
      mains: "on",
      mainsSince: 0.6,
      voltage: 228.4,
      rssi: -61,
      events: [{ up: 12.25, mains: "on" }],
    } satisfies Partial<HubReportEvent>);
  });

  it("rejects a wrong or missing signature and unknown devices", () => {
    const v = new HubVerifier([device]);
    const raw = body();
    expect(verify(v, raw, signHub("other", raw))).toMatchObject({
      ok: false,
      reason: "bad-signature",
    });
    expect(v.verify(Buffer.from(raw), undefined, "x", 1)).toMatchObject({
      reason: "bad-signature",
    });
    const stranger = body({ dev: "hub-ffffff" });
    expect(verify(v, stranger)).toMatchObject({ ok: false, reason: "unknown-device" });
  });

  it("rejects replays: the same seq of a boot, and a boot it has moved past", () => {
    const v = new HubVerifier([device]);
    expect(verify(v, body({ seq: 5 })).ok).toBe(true);
    expect(verify(v, body({ seq: 5 }))).toMatchObject({ reason: "replay" });
    expect(verify(v, body({ seq: 6 })).ok).toBe(true);
    expect(verify(v, body({ boot: "aaaa", seq: 0 })).ok).toBe(true);
    expect(verify(v, body({ seq: 7 }))).toMatchObject({ reason: "replay" });
  });

  it("rejects malformed reports even when signed", () => {
    const v = new HubVerifier([device]);
    for (const bad of [
      body({ v: 2 }),
      body({ boot: "not hex!" }),
      body({ seq: -1 }),
      body({ plug: { mains: "maybe" } }),
      body({ events: [{ up: 99, mains: "off" }] }), // after the report itself
      body({ events: [{ up: 1, mains: "dim" }] }),
      "[1,2]",
    ]) {
      expect(verify(v, bad).ok).toBe(false);
    }
  });
});

describe("POST /iot/hub", () => {
  async function server() {
    const app = Fastify();
    const reports: HubReportEvent[] = [];
    const rejects: string[] = [];
    registerHubRoutes(app, {
      verifier: new HubVerifier([device]),
      onReport: (e) => reports.push(e),
      onReject: (reason) => rejects.push(reason),
      now: () => 5000,
    });
    await app.ready();
    return { app, reports, rejects };
  }

  const post = (app: Awaited<ReturnType<typeof server>>["app"], raw: string, sig?: string) =>
    app.inject({
      method: "POST",
      url: "/iot/hub",
      headers: { "content-type": "application/json", ...(sig ? { "x-signature": sig } : {}) },
      payload: raw,
    });

  it("acknowledges the seq of a good report", async () => {
    const { app, reports } = await server();
    const raw = body({ seq: 3 });
    const res = await post(app, raw, signHub(SECRET, raw));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ack: 3 });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.t).toBe(5000);
  });

  it("401 without a signature, 403 with a wrong one, 400 for garbage, 409 for a replay", async () => {
    const { app, rejects } = await server();
    const raw = body();
    expect((await post(app, raw)).statusCode).toBe(401);
    expect((await post(app, raw, "00")).statusCode).toBe(403);
    expect((await post(app, "{", "00")).statusCode).toBe(400);
    expect((await post(app, raw, signHub(SECRET, raw))).statusCode).toBe(200);
    expect((await post(app, raw, signHub(SECRET, raw))).statusCode).toBe(409);
    expect(rejects).toEqual(["bad-signature", "bad-signature", "malformed", "replay"]);
  });
});
