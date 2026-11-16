import { describe, expect, it } from "vitest";
import {
  DEFAULT_HUB_DETECTOR_CONFIG,
  type HubDetectorState,
  type HubEffect,
  type HubReport,
  initialHubDetectorState,
  nextHubWakeAt,
  persistHubDetector,
  stepHubDetector,
} from "../src/index.ts";

const T0 = Date.UTC(2026, 10, 15, 10, 0, 0);
const s = (seconds: number) => T0 + seconds * 1000;

/** A report received at T0+`at` s from a hub booted at T0+`bootAt` s. */
function rep(at: number, fields: Partial<HubReport> & { bootAt?: number } = {}): HubReport {
  const { bootAt = 0, ...rest } = fields;
  return {
    t: s(at),
    boot: "b1",
    up: at - bootAt,
    rst: "poweron",
    mains: "on",
    mainsSince: 0.5,
    events: [],
    ...rest,
  };
}

function run(reports: (HubReport | { tick: number })[], start?: HubDetectorState) {
  let state = start ?? initialHubDetectorState();
  const effects: HubEffect[] = [];
  for (const r of reports) {
    const step = stepHubDetector(
      state,
      "tick" in r ? { type: "tick", t: s(r.tick) } : { type: "report", report: r },
    );
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

/** Effects with times in seconds from T0. */
function readable(effects: HubEffect[]) {
  const sec = (t: number) => (t - T0) / 1000;
  return effects.map((e) => {
    if (e.type === "power")
      return {
        [e.state]: sec(e.at),
        detected: sec(e.detectedAt),
        reason: e.reason,
        ...(e.approximate ? { approximate: true } : {}),
      };
    if (e.type === "hub-silent") return { silent: sec(e.since), detected: sec(e.detectedAt) };
    return {
      back: sec(e.at),
      silentFrom: sec(e.silentFrom),
      rebooted: e.rebooted,
      powerLoss: e.powerLoss,
    };
  });
}

describe("hub detector", () => {
  it("the first report sets the power from the hub's verdict, at the time the hub measured", () => {
    const { effects, state } = run([rep(30, { mainsSince: 0.5 })]);
    expect(readable(effects)).toEqual([{ on: 0.5, detected: 30, reason: "hub" }]);
    expect(state.power).toBe("on");
  });

  it("an outage and its end, at the plug's times", () => {
    const { effects } = run([
      rep(30),
      rep(60, { mains: "off", mainsSince: 58.2, events: [{ up: 58.2, mains: "off" }] }),
      rep(90, {
        mains: "on",
        mainsSince: 88.4,
        events: [
          { up: 58.2, mains: "off" }, // not acknowledged in time: resent
          { up: 88.4, mains: "on" },
        ],
      }),
    ]);
    expect(readable(effects)).toEqual([
      { on: 0.5, detected: 30, reason: "hub" },
      { off: 58.2, detected: 60, reason: "hub" },
      { on: 88.4, detected: 90, reason: "hub" },
    ]);
  });

  it("an outage during an internet gap arrives late but with its real times", () => {
    const { effects } = run([
      rep(30),
      { tick: 150 },
      rep(400, {
        events: [
          { up: 200.1, mains: "off" },
          { up: 300.7, mains: "on" },
        ],
        mainsSince: 300.7,
      }),
    ]);
    expect(readable(effects)).toEqual([
      { on: 0.5, detected: 30, reason: "hub" },
      { silent: 30, detected: 150 },
      { back: 400, silentFrom: 30, rebooted: false, powerLoss: false },
      { off: 200.1, detected: 400, reason: "hub" },
      { on: 300.7, detected: 400, reason: "hub" },
    ]);
  });

  it("silence alone is not an outage: one alert, the light stays as it was", () => {
    const { effects, state } = run([rep(30), { tick: 100 }, { tick: 150 }, { tick: 600 }]);
    expect(readable(effects)).toEqual([
      { on: 0.5, detected: 30, reason: "hub" },
      { silent: 30, detected: 150 },
    ]);
    expect(state.power).toBe("on");
  });

  it("the hub lost power itself: off around its last report, on when the plug answered after the boot", () => {
    const { effects } = run([
      rep(30),
      rep(60),
      // Back at 400 s after booting at 380 s; the plug answered 0.5 s after the boot.
      rep(400, { boot: "b2", bootAt: 380, rst: "poweron", mainsSince: 0.5 }),
    ]);
    expect(readable(effects)).toEqual([
      { on: 0.5, detected: 30, reason: "hub" },
      { off: 60, detected: 400, reason: "hub-reboot", approximate: true },
      { on: 380.5, detected: 400, reason: "hub-reboot" },
    ]);
  });

  it("the hub restarting itself says nothing about the mains", () => {
    const { effects } = run([rep(30), rep(60), rep(80, { boot: "b2", bootAt: 75, rst: "sw" })]);
    expect(readable(effects)).toEqual([{ on: 0.5, detected: 30, reason: "hub" }]);
  });

  it("a hub that lost power while the light was already off keeps it off", () => {
    const { effects } = run([
      rep(30),
      rep(60, { mains: "off", mainsSince: 55, events: [{ up: 55, mains: "off" }] }),
      rep(4000, { boot: "b2", bootAt: 3990, mains: "on", mainsSince: 0.6 }),
    ]);
    expect(readable(effects)).toEqual([
      { on: 0.5, detected: 30, reason: "hub" },
      { off: 55, detected: 60, reason: "hub" },
      { on: 3990.6, detected: 4000, reason: "hub-reboot" },
    ]);
  });

  it("an unknown verdict right after a boot changes nothing", () => {
    const { effects } = run([rep(5, { mains: "unknown", mainsSince: null })]);
    expect(effects).toEqual([]);
  });

  it("the power-loss inference survives a core restart", () => {
    const first = run([rep(30), rep(60)]);
    const restored = initialHubDetectorState(persistHubDetector(first.state));
    expect(restored.power).toBe("on");
    const { effects } = run([rep(500, { boot: "b2", bootAt: 480 })], restored);
    expect(readable(effects)).toEqual([
      { off: 60, detected: 500, reason: "hub-reboot", approximate: true },
      { on: 480.5, detected: 500, reason: "hub-reboot" },
    ]);
  });

  it("wakes once for the silence alert", () => {
    const { state } = run([rep(30)]);
    expect(nextHubWakeAt(state)).toBe(s(30) + DEFAULT_HUB_DETECTOR_CONFIG.silentAlertMs);
    const alerted = run([{ tick: 200 }], state).state;
    expect(nextHubWakeAt(alerted)).toBeNull();
  });
});
