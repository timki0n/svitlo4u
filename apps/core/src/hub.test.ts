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
  }) => {
    const raw = JSON.stringify({
      v: 1,
      dev: "hub-2a4c11",
      boot: fields.boot ?? "b1",
      seq: seq++,
      up: fields.up,
      rst: fields.boot ? "sw" : "poweron",
      fw: fields.fw ?? "0.1.0",
      plug: { paired: true, mains: fields.mains, since: fields.since, voltage: 229, rssi: -60 },
      events: fields.events ?? [],
      ...(fields.ota === undefined ? {} : { ota: fields.ota }),
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

  it("a hub site gets the hub power service, not the ESP one", async () => {
    const c = await start(new ManualClock(T0));
    expect(c.hubs.has("hub-test")).toBe(true);
    expect(c.power.has("hub-test")).toBe(false);
  });
});
