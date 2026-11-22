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

  it("takes an event from before the boot, why the hub restarted and the plug's silences (0.2.6)", () => {
    const full = {
      up: 12.5,
      len: 15.22,
      ok: 3,
      fail: 12,
      held: 0,
      reports: 1,
      conns: 0,
      drops: 0,
      sinceReport: 2.1,
      endSinceReport: 0.2,
      end: "read",
      off: false,
      saved: true,
      rssi: -36,
    };
    const raw = body({
      rst: "sw",
      why: "Wi-Fi went silent",
      events: [{ up: -179.9, mains: "off" }],
      silences: [
        full,
        { up: 99, len: 4, end: "read" }, // after the report itself: skipped
        { up: 20, len: 6.5, end: "sneeze" }, // an end the core does not know: skipped
        { up: 21, len: 6.5, end: "announce", sinceReport: null, off: true },
      ],
    });
    const result = verify(new HubVerifier([device]), raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.why).toBe("Wi-Fi went silent");
    expect(result.event.events).toEqual([{ up: -179.9, mains: "off" }]);
    expect(result.event.silences).toEqual([
      {
        up: 12.5,
        len: 15.22,
        readsOk: 3,
        readsFailed: 12,
        held: 0,
        reports: 1,
        conns: 0,
        drops: 0,
        sinceReport: 2.1,
        endSinceReport: 0.2,
        end: "read",
        off: false,
        saved: true,
        rssi: -36,
      },
      {
        up: 21,
        len: 6.5,
        readsOk: 0,
        readsFailed: 0,
        held: 0,
        reports: 0,
        conns: 0,
        drops: 0,
        sinceReport: null,
        endSinceReport: null,
        end: "announce",
        off: true,
        saved: false,
        rssi: null,
      },
    ]);

    // firmware before 0.2.6 says none of it; a strange journal costs nothing
    const old = verify(new HubVerifier([device]), body({ silences: "many" }));
    expect(old.ok && [old.event.why, old.event.silences]).toEqual([null, []]);
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
      body({ events: [{ up: -3e6, mains: "off" }] }), // over a month before the boot
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
