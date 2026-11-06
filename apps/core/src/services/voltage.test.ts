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
    events.push(`${e.kind} ${e.voltage} since ${(e.since - T0) / 1000}`);
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

  it("a reading near the edge (190–192 V) or low again starts the 2 minutes over", () => {
    const { monitor, events, readings, reading } = setup();
    readings([
      [0, 185],
      [15, 186],
      [30, 184],
      [45, 205],
      [60, 191], // inside the band but within the 3 V margin
      [75, 205],
      [120, 206],
      [180, 205],
    ]);
    expect(monitor.state).toBe("alerted-low");
    reading(195, 206);
    expect(events.at(-1)).toBe("stabilized after low: 206 at 195"); // 205, 206, 205, 206
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
