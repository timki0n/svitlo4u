import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signHub, signHubOffer } from "./adapters/hub.ts";
import { type Core, startCore } from "./app.ts";
import { loadConfig } from "./config.ts";
import type { CoreEvents } from "./runtime/bus.ts";
import { ManualClock } from "./runtime/clock.ts";
import { fakeHubImage } from "./services/firmware-fixture.ts";

const SECRET = "hub-secret";
const T0 = Date.UTC(2026, 10, 15, 10, 0, 0);

const SITES = `
sites:
  - id: 4u
    name: ЖК 4U
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
      - { id: esp-4u, kind: esp, transport: udp, secretEnv: ESP_4U_SECRET }
  - id: hub-test
    name: Тест хаб
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
      - { id: hub-2a4c11, kind: hub, secretEnv: HUB_TEST_SECRET }
`;

let dir: string;
let core: Core | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "svitlo-hub-"));
});
afterEach(async () => {
  await core?.stop();
  core = null;
  rmSync(dir, { recursive: true, force: true });
});

async function start(clock: ManualClock) {
  writeFileSync(join(dir, "sites.yaml"), SITES);
  core = await startCore(
    {
      ...loadConfig({ LOG_LEVEL: "silent" }),
      dbPath: join(dir, "core.db"),
      sitesPath: join(dir, "sites.yaml"),
      udpPort: 0,
    },
    {
      clock,
      // The firmware cache is <dir>/firmware; no GitHub in tests.
      env: { ESP_4U_SECRET: "s", HUB_TEST_SECRET: SECRET, FIRMWARE_REPO: "off" },
      fetch: async () => new Response("{}", { status: 500 }),
      listen: false,
      images: null,
    },
  );
  return core;
}

/** A hub that booted at T0 and reports by its uptime. */
function hub(c: Core) {
  let seq = 0;
  return async (fields: {
    up: number;
    mains: string;
    since: number | null;
    events?: unknown[];
    boot?: string;
    fw?: string;
    ota?: unknown;
    gaps?: number;
    wifi?: unknown;
  }) => {
    const raw = JSON.stringify({
      v: 1,
      dev: "hub-2a4c11",
      boot: fields.boot ?? "b1",
      seq: seq++,
      up: fields.up,
      rst: fields.boot ? "sw" : "poweron",
      fw: fields.fw ?? "0.1.0",
      plug: {
        paired: true,
        mains: fields.mains,
        since: fields.since,
        voltage: 229,
        rssi: -60,
        ...(fields.gaps === undefined
          ? {}
          : { gaps: fields.gaps, longestGap: 15.2, delay: 12, rssiAvg: -66 }),
      },
      events: fields.events ?? [],
      ...(fields.ota === undefined ? {} : { ota: fields.ota }),
      ...(fields.wifi === undefined ? {} : { wifi: fields.wifi }),
    });
    return c.app.inject({
      method: "POST",
      url: "/iot/hub",
      headers: { "content-type": "application/json", "x-signature": signHub(SECRET, raw) },
      payload: raw,
    });
  };
}

describe("hub site (integration)", () => {
  it("the hub's reports drive the site's power at the hub's times; silence only alerts", async () => {
    const clock = new ManualClock(T0 + 30_000);
    const c = await start(clock);
    const changes: CoreEvents["power.changed"][] = [];
    const silent: CoreEvents["hub.silent"][] = [];
    c.bus.on("power.changed", (e) => {
      if (e.siteId === "hub-test") changes.push(e);
    });
    c.bus.on("hub.silent", (e) => {
      silent.push(e);
    });
    const report = hub(c);

    expect((await report({ up: 30, mains: "on", since: 0.6 })).json()).toEqual({
      ok: true,
      ack: 0,
    });
    expect(c.state.get("hub-test")).toMatchObject({
      power: "on",
      since: T0 + 600,
      lastVoltage: 229,
    });

    clock.advanceTo(T0 + 62_000);
    await report({ up: 62, mains: "off", since: 60.25, events: [{ up: 60.25, mains: "off" }] });
    expect(c.state.get("hub-test")).toMatchObject({ power: "off", since: T0 + 60_250 });
    expect(changes.map((e) => [e.state, e.at, e.reason])).toEqual([
      ["on", T0 + 600, "hub"],
      ["off", T0 + 60_250, "hub"],
    ]);

    // The hub falls silent: an alert after 2 minutes, the light stays as it was.
    clock.advanceBy(3 * 60_000);
    expect(silent).toHaveLength(1);
    expect(c.state.get("hub-test").power).toBe("off");
    expect(changes).toHaveLength(2);
  });

  it("offers a newer firmware in the reply, signed for this report, and serves it", async () => {
    const image = fakeHubImage("0.2.1");
    mkdirSync(join(dir, "firmware"));
    writeFileSync(join(dir, "firmware", "hub-0.2.1.bin"), image);
    const clock = new ManualClock(T0 + 30_000);
    const c = await start(clock);
    const updated: CoreEvents["hub.updated"][] = [];
    const rejected: CoreEvents["hub.update-rejected"][] = [];
    c.bus.on("hub.updated", (e) => {
      updated.push(e);
    });
    c.bus.on("hub.update-rejected", (e) => {
      rejected.push(e);
    });
    const report = hub(c);
    const idle = { state: "idle", version: null, error: null, rejected: null };

    // Firmware without updates gets no offer.
    expect((await report({ up: 30, mains: "on", since: 1 })).json()).toEqual({ ok: true, ack: 0 });

    const reply = (await report({ up: 60, mains: "on", since: 1, fw: "0.2.0", ota: idle })).json();
    expect(reply).toMatchObject({
      ok: true,
      ack: 1,
      ota: { version: "0.2.1", url: "/iot/hub/firmware/hub-0.2.1.bin", size: image.length },
    });
    expect(reply.ota.sig).toBe(
      signHubOffer(SECRET, { deviceId: "hub-2a4c11", boot: "b1", seq: 1 }, reply.ota),
    );
    const download = await c.app.inject({ method: "GET", url: reply.ota.url });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(image)).toBe(true);
    expect(
      (await c.app.inject({ method: "GET", url: "/iot/hub/firmware/hub-9.9.9.bin" })).statusCode,
    ).toBe(404);

    // Not while the light is off.
    expect(
      (
        await report({
          up: 70,
          mains: "off",
          since: 65,
          events: [{ up: 65, mains: "off" }],
          fw: "0.2.0",
          ota: idle,
        })
      ).json(),
    ).toEqual({ ok: true, ack: 2 });

    // Back on the new image: an admin note; a later rollback: another one, and no more offers.
    await report({ up: 5, mains: "on", since: 2, boot: "b2", fw: "0.2.1", ota: idle });
    expect(updated.map((e) => [e.from, e.to])).toEqual([["0.2.0", "0.2.1"]]);
    const back = await report({
      up: 5,
      mains: "on",
      since: 2,
      boot: "b3",
      fw: "0.2.0",
      ota: { ...idle, rejected: "0.2.1" },
    });
    expect(back.json()).toEqual({ ok: true, ack: 4 });
    expect(rejected.map((e) => [e.version, e.fw])).toEqual([["0.2.1", "0.2.0"]]);
    expect(updated).toHaveLength(1);
  });

  it("a gap of the plug's radio (the hub's own judgement) only tells the admin", async () => {
    const clock = new ManualClock(T0 + 30_000);
    const c = await start(clock);
    const gaps: CoreEvents["hub.link-gap"][] = [];
    const changes: CoreEvents["power.changed"][] = [];
    c.bus.on("hub.link-gap", (e) => {
      gaps.push(e);
    });
    c.bus.on("power.changed", (e) => {
      if (e.siteId === "hub-test") changes.push(e);
    });
    const report = hub(c);
    await report({ up: 30, mains: "on", since: 1, gaps: 0 });
    await report({ up: 60, mains: "on", since: 1, gaps: 0 });
    await report({ up: 90, mains: "on", since: 1, gaps: 1 });
    expect(gaps).toEqual([
      { siteId: "hub-test", deviceId: "hub-2a4c11", gaps: 1, longest: 15.2, rssi: -60 },
    ]);
    expect(changes.map((e) => e.state)).toEqual(["on"]);
    expect(c.hubs.get("hub-test")?.status()).toMatchObject({
      linkGaps: 1,
      alertDelay: 12,
      rssi: -66,
    });
  });

  it("the hub's Wi-Fi: the signal for «Мої будинки», every change into its history", async () => {
    const clock = new ManualClock(T0 + 30_000);
    const c = await start(clock);
    const report = hub(c);
    const wifi = { rssi: -68, ch: 8, drops: 0, reason: 0, down: 0, kicks: 0, lost: 0, redone: 0 };
    const history = () =>
      c.store.hubHealth
        .list("hub-2a4c11", { start: 0, end: T0 + 3_600_000 })
        .map((r) => [r.t - T0, r.wifiRssi, r.wifiChannel, r.drops, r.lastDown, r.redone]);

    // firmware before 0.2.5 says nothing of its Wi-Fi
    await report({ up: 30, mains: "on", since: 1 });
    expect(c.hubs.get("hub-test")?.status().wifiRssi).toBeNull();
    expect(history()).toEqual([]);

    await report({ up: 60, mains: "on", since: 1, wifi });
    expect(c.hubs.get("hub-test")?.status().wifiRssi).toBe(-68);
    // the same counters: nothing new for 10 minutes, whatever the signal does
    clock.advanceBy(30_000);
    await report({ up: 90, mains: "on", since: 1, wifi: { ...wifi, rssi: -74 } });
    // a report that went through on a second try, then a drop onto another channel
    clock.advanceBy(30_000);
    await report({ up: 120, mains: "on", since: 1, wifi: { ...wifi, redone: 1 } });
    clock.advanceBy(30_000);
    await report({
      up: 150,
      mains: "on",
      since: 1,
      wifi: { ...wifi, ch: 3, drops: 1, reason: 200, down: 4.6, redone: 1 },
    });
    clock.advanceBy(600_000);
    await report({
      up: 750,
      mains: "on",
      since: 1,
      wifi: { ...wifi, rssi: -80, ch: 3, drops: 1, reason: 200, down: 4.6, redone: 1 },
    });
    expect(history()).toEqual([
      [30_000, -68, 8, 0, 0, 0],
      [90_000, -68, 8, 0, 0, 1],
      [120_000, -68, 3, 1, 4.6, 1],
      [720_000, -80, 3, 1, 4.6, 1],
    ]);
    expect(c.hubs.get("hub-test")?.status().wifiRssi).toBe(-80);

    // a strange `wifi` costs nothing
    clock.advanceBy(30_000);
    const odd = await report({ up: 780, mains: "on", since: 1, wifi: { rssi: "loud", drops: -1 } });
    expect(odd.json()).toMatchObject({ ok: true });
    expect(c.hubs.get("hub-test")?.status().wifiRssi).toBeNull();
  });

  it("a hub site gets the hub power service, not the ESP one", async () => {
    const c = await start(new ManualClock(T0));
    expect(c.hubs.has("hub-test")).toBe(true);
    expect(c.power.has("hub-test")).toBe(false);
  });
});
