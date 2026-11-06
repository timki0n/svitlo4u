import { createSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signV2 } from "./adapters/heartbeat.ts";
import type { MqttLike } from "./adapters/plug.ts";
import { type Core, startCore } from "./app.ts";
import { loadConfig } from "./config.ts";
import type { CoreEvents } from "./runtime/bus.ts";
import { ManualClock, SystemClock } from "./runtime/clock.ts";

const LIVE = readFileSync(
  fileURLToPath(
    new URL("../../../packages/domain/test/fixtures/yasno/live-2026-11-06.json", import.meta.url),
  ),
  "utf8",
);
const fakeYasno = async () =>
  new Response(LIVE, { status: 200, headers: { "content-type": "application/json" } });
const SECRET = "test-secret";

class FakeMqtt extends EventEmitter {
  mains = true;
  subscribe() {}
  publish(topic: string) {
    // The plug answers a read only while it has power.
    if (topic === "zigbee2mqtt/4u-plug/set" && this.mains) {
      this.emit("message", "zigbee2mqtt/4u-plug", Buffer.from('{"voltage":231,"state":"ON"}'));
    }
  }
  end() {}
}

function sitesYaml(withPlug: boolean, detector = "") {
  return `
sites:
  - id: 4u
    name: ЖК 4U
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
      - { id: esp-4u, kind: esp, transport: udp, secretEnv: ESP_4U_SECRET }
${withPlug ? "      - { id: 4u-plug, kind: plug, zigbeeName: 4u-plug }\n" : ""}${detector}
`;
}

let dir: string;
let core: Core | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "svitlo-core-"));
});
afterEach(async () => {
  await core?.stop();
  core = null;
  rmSync(dir, { recursive: true, force: true });
});

async function start(yaml: string, clock: ManualClock | SystemClock, mqtt?: FakeMqtt) {
  writeFileSync(join(dir, "sites.yaml"), yaml);
  const config = {
    ...loadConfig({ LOG_LEVEL: "silent" }),
    dbPath: join(dir, "core.db"),
    sitesPath: join(dir, "sites.yaml"),
    udpPort: 0,
  };
  core = await startCore(config, {
    clock,
    env: { ESP_4U_SECRET: SECRET },
    fetch: fakeYasno,
    listen: false,
    ...(mqtt ? { mqtt: mqtt as unknown as MqttLike } : {}),
  });
  return core;
}

function sender(port: number) {
  const socket = createSocket("udp4");
  let seq = 0;
  return {
    send: (boot: string, up: number) =>
      new Promise<void>((resolve, reject) => {
        const s = seq++;
        const packet = JSON.stringify({
          v: 2,
          dev: "esp-4u",
          boot,
          seq: s,
          up,
          rst: "poweron",
          sig: signV2(SECRET, "esp-4u", boot, s, up, "poweron"),
        });
        socket.send(packet, port, "127.0.0.1", (e) => (e ? reject(e) : resolve()));
      }),
    close: () => socket.close(),
  };
}

const until = async (check: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("core (integration)", () => {
  it("UDP packets stop → 'power off' 9 s after the last packet; schedule stored; back on at ESP boot", async () => {
    const T0 = Date.UTC(2026, 10, 10, 6, 0, 0);
    const clock = new ManualClock(T0);
    const mqtt = new FakeMqtt();
    const c = await start(sitesYaml(true), clock, mqtt);
    const events: CoreEvents["power.changed"][] = [];
    c.bus.on("power.changed", (e) => {
      events.push(e);
    });
    await until(() => c.state.get("4u").schedule !== null); // Yasno answered (fake)
    clock.advanceTo(T0); // first keep-alive read → plug usable

    const esp = sender(c.udp?.port ?? 0);
    for (let s = 1; s <= 5; s++) {
      clock.advanceTo(T0 + s * 1000);
      await esp.send("b1", 1000 + s);
      await until(() => c.state.get("4u").lastEspAt === T0 + s * 1000);
    }
    mqtt.mains = false;
    clock.advanceTo(T0 + 20_000);
    expect(events).toMatchObject([
      { state: "off", at: T0 + 5000, detectedAt: T0 + 14_000, reason: "probe-timeout" },
    ]);

    clock.advanceTo(T0 + 60_000);
    mqtt.mains = true;
    await esp.send("b2", 3);
    await until(() => events.length === 2);
    expect(events[1]).toMatchObject({ state: "on", at: T0 + 57_000, reason: "esp-reboot" });
    esp.close();

    expect(c.store.outages.list("4u", { start: T0, end: T0 + 120_000 })).toEqual([
      { start: T0 + 5000, end: T0 + 57_000, falseAlarm: false },
    ]);
    expect(c.store.schedules.versions("4u", "2026-11-06", "2026-11-07")).toHaveLength(2);
    expect(c.state.get("4u").schedule?.today.status).toBe("EmergencyShutdowns");
    const health = await c.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
  });

  it("real timers: ESP-only site detects an outage after its configured silence", async () => {
    const c = await start(
      sitesYaml(false, "    detector: { suspectAfterMs: 100, espOnlyOffAfterMs: 300 }"),
      new SystemClock(),
    );
    const off = new Promise<CoreEvents["power.changed"]>((resolve) =>
      c.bus.on("power.changed", resolve),
    );
    const esp = sender(c.udp?.port ?? 0);
    for (let i = 1; i <= 5; i++) {
      await esp.send("b1", 100 + i);
      await new Promise((r) => setTimeout(r, 40));
    }
    esp.close();
    const event = await off;
    expect(event.state).toBe("off");
    expect(event.detectedAt - event.at).toBeGreaterThanOrEqual(300);
    expect(event.detectedAt - event.at).toBeLessThan(800);
  });

  it("starts without a sites file (degraded, health still answers)", async () => {
    const config = {
      ...loadConfig({ LOG_LEVEL: "silent" }),
      dbPath: join(dir, "x.db"),
      sitesPath: join(dir, "missing.yaml"),
    };
    core = await startCore(config, { listen: false, fetch: fakeYasno });
    expect(core.sites).toEqual([]);
    expect((await core.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});
