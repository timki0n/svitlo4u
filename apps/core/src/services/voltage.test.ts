import { describe, expect, it } from "vitest";
import { type CoreEvents, EventBus } from "../runtime/bus.ts";
import { ManualClock } from "../runtime/clock.ts";
import { VoltageMonitor } from "./voltage.ts";

const T0 = Date.UTC(2026, 10, 6, 17, 0, 0);
const s = (seconds: number) => T0 + seconds * 1000;

function setup() {
  const clock = new ManualClock(T0);
  const bus = new EventBus<CoreEvents>((_type, error) => {
    throw error;
  });
  const reads: number[] = [];
  const monitor = new VoltageMonitor({
    siteId: "4u",
    bus,
    clock,
    read: () => reads.push(Math.round((clock.now() - T0) / 1000)),
  });
  const events: string[] = [];
  bus.on("voltage.alert", (e) => {
    events.push(
      `${e.critical ? "critical " : ""}${e.kind} ${e.voltage} since ${(e.since - T0) / 1000}`,
    );
  });
  bus.on("voltage.stabilized", (e) => {
    events.push(`stabilized after ${e.kind}: ${e.voltage} at ${(e.at - T0) / 1000}`);
  });
  /** The plug's reading at second `sec` (moves the clock there first). */
  const reading = (sec: number, voltage: number) => {
    clock.advanceTo(s(sec));
    bus.emit("voltage.sample", { siteId: "4u", t: s(sec), voltage });
  };
  const readings = (list: readonly (readonly [number, number])[]) => {
    for (const [sec, v] of list) reading(sec, v);
  };
  return { clock, bus, monitor, reads, events, reading, readings };
}

describe("voltage watch", () => {
  it("normal is 190 V up to (not including) 245 V", () => {
    const { monitor, readings } = setup();
    readings([
      [0, 190],
      [10, 244],
      [20, 207],
    ]);
    expect(monitor.state).toBe("idle");
  });

  it("a single dip is not news: reads for a minute, the average is fine, back to idle", () => {
    const { clock, monitor, reads, events, readings } = setup();
    readings([
      [0, 185],
      [15, 226],
      [30, 228],
    ]);
    expect(monitor.state).toBe("confirming-low");
    clock.advanceTo(s(61));
    expect(events).toEqual([]);
    expect(monitor.state).toBe("idle");
    expect(reads).toEqual([15, 30, 45]);
    clock.advanceTo(s(300));
    expect(reads).toHaveLength(3); // no more reads when idle
  });

  it("three low readings in a row → alert at once with their average", () => {
    const { events, readings } = setup();
    readings([
      [0, 189],
      [15, 188],
      [30, 190 - 0.5],
    ]);
    expect(events).toEqual(["low 189 since 0"]);
  });

  it("mixed readings: the minute's average decides", () => {
    const { clock, events, readings } = setup();
    readings([
      [0, 180],
      [15, 195],
      [30, 186],
      [45, 185],
    ]);
    clock.advanceTo(s(60));
    expect(events).toEqual(["low 187 since 0"]);
  });

  it("stabilized once the voltage has stayed normal for 2 minutes, with that average", () => {
    const { events, readings, reading } = setup();
    readings([
      [0, 189],
      [15, 186],
      [30, 184], // alert at 30 s
      [45, 205],
      [60, 206],
      [120, 207],
      [150, 206],
    ]);
    expect(events).toEqual(["low 186 since 0"]); // normal since 45 s: not 2 minutes yet
    reading(165, 206);
    expect(events.at(-1)).toBe("stabilized after low: 206 at 165");
  });

  it("after low voltage only 200 V and up is normal again: 190–199 V starts the 2 minutes over", () => {
    const { monitor, events, readings, reading } = setup();
    readings([
      [0, 185],
      [15, 186],
      [30, 184], // alert
      [45, 195],
      [100, 198],
      [165, 199], // 2 minutes of 195–199 V: still low
    ]);
    expect(monitor.state).toBe("alerted-low");
    expect(events).toEqual(["low 185 since 0"]);
    readings([
      [180, 200],
      [195, 205],
      [240, 199], // starts it over
      [255, 200],
      [300, 206],
      [360, 205],
    ]);
    expect(monitor.state).toBe("alerted-low");
    reading(375, 206);
    expect(events.at(-1)).toBe("stabilized after low: 204 at 375"); // 200, 206, 205, 206
    expect(monitor.state).toBe("idle");
  });

  it("after high voltage 242 V and up starts the 2 minutes over (3 V margin)", () => {
    const { monitor, events, readings, reading } = setup();
    readings([
      [0, 250],
      [15, 251],
      [30, 252], // alert
      [45, 236],
      [60, 242], // inside the band but within the margin
      [75, 236],
      [120, 237],
      [180, 236],
    ]);
    expect(monitor.state).toBe("alerted-high");
    reading(195, 236);
    expect(events.at(-1)).toBe("stabilized after high: 236 at 195");
  });

  it("high voltage from 245 V works the same way", () => {
    const { events, readings } = setup();
    readings([
      [0, 245],
      [15, 251],
      [30, 252], // alert
      [45, 236],
      [100, 237],
      [165, 236],
    ]);
    expect(events).toEqual(["high 249 since 0", "stabilized after high: 236 at 165"]);
  });

  it("below 170 V: a second, critical alert once three readings in a row fall that far", () => {
    // 2026-11-07 06:05: 189 V, then 104–170 V for half an hour with no word about it.
    const { events, readings } = setup();
    readings([
      [0, 189],
      [15, 188],
      [30, 187],
      [45, 160], // one reading is not enough
      [60, 182],
      [75, 109],
      [90, 104],
      [105, 111],
      [120, 120],
      [135, 140],
    ]);
    expect(events).toEqual(["low 188 since 0", "critical low 108 since 0"]);
  });

  it("critical straight away when the check itself is below 170 V", () => {
    const { events, readings } = setup();
    readings([
      [0, 150],
      [15, 140],
      [30, 145],
      [45, 120],
      [60, 110],
      [75, 100],
    ]);
    expect(events).toEqual(["critical low 145 since 0"]);
  });

  it("quiet for 2 minutes after the power returns, watched again afterwards", () => {
    const { bus, monitor, events, readings } = setup();
    bus.emit("power.changed", {
      siteId: "4u",
      state: "on",
      at: s(0),
      detectedAt: s(0),
      reason: "plug",
      approximate: false,
      previous: "off",
      previousSince: s(-3600),
    });
    // 2026-11-07 07:13: 181 V at the return, 232 V two minutes later.
    readings([
      [1, 181],
      [11, 181],
      [60, 216],
      [100, 229],
    ]);
    expect(monitor.state).toBe("idle");
    readings([
      [121, 185],
      [136, 184],
      [151, 183],
    ]);
    expect(events).toEqual(["low 184 since 121"]);
  });

  it("an outage ends the episode silently; 0 V is the outage detector's business", () => {
    const { bus, monitor, events, readings } = setup();
    readings([[0, 0]]);
    expect(monitor.state).toBe("idle");
    readings([
      [10, 185],
      [25, 186],
      [40, 184],
    ]);
    bus.emit("power.changed", {
      siteId: "4u",
      state: "off",
      at: s(45),
      detectedAt: s(54),
      reason: "probe-timeout",
      approximate: false,
      previous: "on",
      previousSince: s(-3600),
    });
    expect(monitor.state).toBe("idle");
    expect(events).toEqual(["low 185 since 10"]);
  });
});
