import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETECTOR_CONFIG,
  type DetectorEffect,
  initialDetectorState,
  nextWakeAt,
  persistDetector,
} from "../src/index.ts";
import { espPackets, plugReports, simulate } from "./detector-sim.ts";

const T0 = Date.UTC(2026, 10, 6, 8, 0, 0);
const s = (seconds: number) => T0 + seconds * 1000;
const UP0 = 1000; // ESP uptime at T0
const alive = { answer: () => 230 };
const dead = { answer: () => null };

/** Everything except routine keep-alive reads. */
const significant = (effects: DetectorEffect[]) =>
  effects.filter((e) => !(e.type === "probe" && e.purpose === "keepalive"));

/** Significant effects with times in seconds from T0 — readable expectations. */
function readable(effects: DetectorEffect[]) {
  const sec = (t: number) => (t - T0) / 1000;
  return significant(effects).map((e) => {
    switch (e.type) {
      case "power":
        return {
          [e.state]: sec(e.at),
          detected: sec(e.detectedAt),
          reason: e.reason,
          ...(e.approximate ? { approximate: true } : {}),
        };
      case "probe":
        return { probe: sec(e.t) };
      case "false-alarm":
        return { falseAlarm: sec(e.outageStartedAt), detected: sec(e.detectedAt) };
      case "network-gap":
        return { gap: [sec(e.from), sec(e.to)], by: e.confirmedBy };
      case "blip":
        return { blip: [sec(e.from), sec(e.to)] };
      default:
        throw new Error(`unexpected effect ${JSON.stringify(e)}`);
    }
  });
}

const keepaliveTimes = (effects: DetectorEffect[]) =>
  effects
    .filter((e) => e.type === "probe" && e.purpose === "keepalive")
    .map((e) => (e.type === "probe" ? Math.round((e.t - T0) / 100) / 10 : 0));

describe("power detector — ESP + Zigbee plug", () => {
  it("steady heartbeat produces nothing but keep-alive reads", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [...espPackets(s(0), s(300), UP0), ...plugReports(s(1), s(300))],
      plug: alive,
    });
    expect(significant(effects)).toEqual([]);
  });

  it("keep-alive: the plug is read once a minute after its last message", () => {
    const { effects } = simulate({ start: T0, inputs: espPackets(s(0), s(250), UP0), plug: alive });
    expect(keepaliveTimes(effects)).toEqual([0, 60.3, 120.6, 180.9, 241.2]);
    expect(significant(effects)).toEqual([]);
  });

  it("an unreachable plug never turns the power off by itself", () => {
    const { effects } = simulate({ start: T0, inputs: espPackets(s(0), s(250), UP0), plug: dead });
    expect(keepaliveTimes(effects)).toEqual([0, 60, 120, 180, 240]);
    expect(significant(effects)).toEqual([]);
  });

  it("Wi-Fi gap of 11 s: plug confirms power → no outage, gap logged", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(60), UP0),
        ...espPackets(s(71), s(120), UP0 + 71),
        ...plugReports(s(1), s(120)),
      ],
      plug: alive,
    });
    expect(readable(effects)).toEqual([{ probe: 65 }, { gap: [60, 71], by: "zigbee" }]);
  });

  it("right after a start the first keep-alive makes the plug usable", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [...espPackets(s(0), s(30), UP0), ...espPackets(s(41), s(60), UP0 + 41)],
      plug: alive,
    });
    expect(readable(effects)).toEqual([{ probe: 35 }, { gap: [30, 41], by: "zigbee" }]);
  });

  it("real outage: plug silent for two reads → off 9 s after the last packet; back at the ESP boot moment", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(60), UP0),
        ...plugReports(s(1), s(60)),
        ...espPackets(s(600), s(620), 5),
      ],
      plug: dead,
    });
    expect(readable(effects)).toEqual([
      { probe: 65 },
      { probe: 67 },
      { off: 60, detected: 69, reason: "probe-timeout" },
      { on: 595, detected: 600, reason: "esp-reboot" },
    ]);
  });

  it("plug answers with no voltage → off right away", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [...espPackets(s(0), s(60), UP0), ...plugReports(s(1), s(60))],
      plug: { answer: (t) => (t < s(61) ? 230 : 0), latencyMs: 500 },
      until: s(120),
    });
    expect(readable(effects)).toEqual([
      { probe: 65 },
      { off: 60, detected: 65.5, reason: "probe-no-voltage" },
    ]);
  });

  it("plug speaks before the ESP reconnects → on from the plug", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(60), UP0),
        ...plugReports(s(1), s(60)),
        { type: "plug", t: s(590), voltage: 228 },
        ...espPackets(s(600), s(620), 5),
      ],
      plug: dead,
    });
    expect(readable(effects)).toEqual([
      { probe: 65 },
      { probe: 67 },
      { off: 60, detected: 69, reason: "probe-timeout" },
      { on: 590, detected: 590, reason: "plug" },
    ]);
  });

  it("plug glitch during a Wi-Fi gap → off, then uptime proves it was a false alarm", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(60), UP0),
        ...plugReports(s(1), s(60)),
        { type: "plug", t: s(75), voltage: 231 },
        ...espPackets(s(80), s(100), UP0 + 80),
      ],
      plug: dead,
    });
    expect(readable(effects)).toEqual([
      { probe: 65 },
      { probe: 67 },
      { off: 60, detected: 69, reason: "probe-timeout" },
      { on: 75, detected: 75, reason: "plug" },
      // Uptime proves the false alarm; the plug message at 75 s already vouched for power in the gap.
      { falseAlarm: 60, detected: 80 },
      { gap: [60, 80], by: "zigbee" },
    ]);
  });

  it("the plug speaks just after the reads gave up → false alarm, not a new 'power on'", () => {
    // Seen live: the plug ignored two reads but sent a report 0.1 s after the decision.
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(60), UP0),
        ...plugReports(s(1), s(60)),
        { type: "plug", t: s(69.1), voltage: 231 },
        ...espPackets(s(80), s(100), UP0 + 80),
      ],
      plug: dead,
    });
    expect(readable(effects)).toEqual([
      { probe: 65 },
      { probe: 67 },
      { off: 60, detected: 69, reason: "probe-timeout" },
      { falseAlarm: 60, detected: 69.1 },
      { gap: [60, 80], by: "zigbee" },
    ]);
  });

  it("0 V from the plug while the ESP is silent → off at once, even after the plug vouched for power", () => {
    // Seen live: the plug confirmed the power during the ESP silence, then the power went: 0 V.
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(60), UP0),
        ...plugReports(s(1), s(60)),
        { type: "plug", t: s(72), voltage: 0 },
        ...espPackets(s(100), s(110), 4),
      ],
      plug: { answer: (t) => (t < s(70) ? 230 : null), latencyMs: 300 },
    });
    expect(readable(effects)).toEqual([
      { probe: 65 },
      { off: 65.3, detected: 72, reason: "probe-no-voltage" },
      { on: 96, detected: 100, reason: "esp-reboot" },
    ]);
  });

  it("a stray 0 V while the ESP keeps talking changes nothing", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(60), UP0),
        ...plugReports(s(1), s(60)),
        { type: "plug", t: s(30), voltage: 0 },
      ],
      plug: alive,
    });
    expect(readable(effects)).toEqual([]);
  });

  it("ESP silent for minutes while the plug keeps confirming → re-check every 30 s, off when the plug goes quiet", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [...espPackets(s(0), s(60), UP0), ...plugReports(s(1), s(60))],
      plug: { answer: (t) => (t < s(150) ? 230 : null) },
      until: s(300),
    });
    expect(readable(effects)).toEqual([
      { probe: 65 },
      { probe: 95 },
      { probe: 125 },
      { probe: 155 },
      { probe: 157 },
      { off: 125.3, detected: 159, reason: "probe-timeout" },
    ]);
  });

  it("ESP restarts within a few seconds → blip, no outage", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(60), UP0),
        ...espPackets(s(63), s(80), 1),
        ...plugReports(s(1), s(80)),
      ],
      plug: alive,
    });
    expect(readable(effects)).toEqual([{ blip: [60, 62] }]);
  });

  it("plug unreachable for 3+ min → ESP-only rule (20 s), an 11 s gap stays a gap", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(700), UP0),
        ...espPackets(s(711), s(760), UP0 + 711),
        { type: "plug", t: s(1), voltage: 230 },
      ],
      plug: dead,
    });
    expect(readable(effects)).toEqual([{ gap: [700, 711], by: "uptime" }]);
  });

  it("a slow answer (2.6 s) arrives during the second read → no false outage", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(60), UP0),
        ...espPackets(s(71), s(100), UP0 + 71),
        ...plugReports(s(1), s(100)),
      ],
      plug: { answer: () => 230, latencyMs: 2_600 },
    });
    expect(readable(effects)).toEqual([
      { probe: 65 },
      { probe: 67 },
      { gap: [60, 71], by: "zigbee" },
    ]);
  });
});

describe("power detector — firmware reset reason (v2)", () => {
  it("a crash/watchdog restart of the ESP is not a blip", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(60), UP0),
        { type: "esp", t: s(63), up: 1, boot: "b2", resetReason: "panic" },
        ...plugReports(s(1), s(80)),
      ],
      plug: alive,
    });
    expect(readable(effects)).toEqual([]);
  });

  it("a power-on reset still is", () => {
    const { effects } = simulate({
      start: T0,
      inputs: [
        ...espPackets(s(0), s(60), UP0),
        { type: "esp", t: s(63), up: 1, boot: "b2", resetReason: "poweron" },
        ...plugReports(s(1), s(80)),
      ],
      plug: alive,
    });
    expect(readable(effects)).toEqual([{ blip: [60, 62] }]);
  });

  it("an ESP watchdog restart while the core was down is not an outage", () => {
    const persisted = persistDetector(
      simulate({ config: { zigbee: false }, start: T0, inputs: espPackets(s(0), s(60), UP0) })
        .state,
    );
    const { effects } = simulate({
      config: { zigbee: false },
      start: s(600),
      persisted,
      inputs: [{ type: "esp", t: s(601), up: 30, boot: "b3", resetReason: "wdt" }],
    });
    expect(effects).toEqual([]);
  });
});

describe("power detector — outage taken over from the legacy bot (no earlier ESP packet)", () => {
  const adopted = {
    power: "off" as const,
    since: s(-3 * 3600),
    onSinceBeforeOutage: null,
    unverifiedOutage: null,
    lastEsp: null,
    lastPowerEvidence: null,
  };

  it("an ESP that booted after the outage began → power back at its boot moment", () => {
    const { effects } = simulate({
      config: { zigbee: false },
      start: s(0),
      persisted: adopted,
      inputs: [{ type: "esp", t: s(100), up: 6 }],
    });
    expect(readable(effects)).toEqual([{ on: 94, detected: 100, reason: "esp-reboot" }]);
  });

  it("an ESP up since before the outage cannot date the return → the packet time", () => {
    const { effects } = simulate({
      config: { zigbee: false },
      start: s(0),
      persisted: adopted,
      inputs: [{ type: "esp", t: s(100), up: 4 * 3600 }],
    });
    expect(readable(effects)).toEqual([{ on: 100, detected: 100, reason: "esp-packet" }]);
  });
});

describe("power detector — ESP only (no plug)", () => {
  const config = { zigbee: false };

  it("Wi-Fi gap of 11 s is not an outage", () => {
    const { effects } = simulate({
      config,
      start: T0,
      inputs: [...espPackets(s(0), s(60), UP0), ...espPackets(s(71), s(120), UP0 + 71)],
    });
    expect(readable(effects)).toEqual([{ gap: [60, 71], by: "uptime" }]);
  });

  it("real outage → off after 20 s of silence", () => {
    const { effects } = simulate({
      config,
      start: T0,
      inputs: [...espPackets(s(0), s(60), UP0), ...espPackets(s(600), s(620), 5)],
    });
    expect(readable(effects)).toEqual([
      { off: 60, detected: 80, reason: "esp-timeout" },
      { on: 595, detected: 600, reason: "esp-reboot" },
    ]);
  });

  it("25 s Wi-Fi gap → off, then uptime retracts it and the light-on period continues", () => {
    const { effects, state } = simulate({
      config,
      start: T0,
      inputs: [...espPackets(s(0), s(60), UP0), ...espPackets(s(85), s(100), UP0 + 85)],
    });
    expect(readable(effects)).toEqual([
      { off: 60, detected: 80, reason: "esp-timeout" },
      { falseAlarm: 60, detected: 85 },
      { gap: [60, 85], by: "uptime" },
    ]);
    expect(state.power).toBe("on");
    expect(state.since).toBe(s(-UP0)); // since the ESP booted, as before the false alarm
  });
});

describe("power detector — restarts of the core", () => {
  const persistedOn = () => {
    const { state } = simulate({
      config: { zigbee: false },
      start: T0,
      inputs: espPackets(s(0), s(60), UP0),
    });
    return persistDetector(state);
  };

  it("fresh start: first packet sets power on since the ESP booted, without an event", () => {
    const { effects, state } = simulate({
      start: T0,
      inputs: [{ type: "esp", t: s(1), up: 3600 }],
    });
    expect(significant(effects)).toEqual([]);
    expect(state.power).toBe("on");
    expect(state.since).toBe(s(1 - 3600));
  });

  it("restart, ESP uptime continued over the downtime → nothing happened", () => {
    const { effects } = simulate({
      config: { zigbee: false },
      start: s(600),
      persisted: persistedOn(),
      inputs: espPackets(s(601), s(640), UP0 + 601),
    });
    expect(effects).toEqual([]);
  });

  it("restart, ESP rebooted meanwhile → outage during the downtime (start approximate)", () => {
    const { effects } = simulate({
      config: { zigbee: false },
      start: s(600),
      persisted: persistedOn(),
      inputs: espPackets(s(601), s(640), 30),
    });
    expect(readable(effects)).toEqual([
      { off: 60, detected: 601, reason: "downtime", approximate: true },
      { on: 571, detected: 601, reason: "esp-reboot" },
    ]);
  });

  it("restart into silence → off from the last known evidence, not from the restart (legacy bug)", () => {
    const { effects } = simulate({
      config: { zigbee: false },
      start: s(600),
      persisted: persistedOn(),
      inputs: [],
      until: s(700),
    });
    expect(readable(effects)).toEqual([
      { off: 60, detected: 620, reason: "esp-timeout", approximate: true },
    ]);
  });

  it("restart during an outage: the plug brings the power back, then the ESP boots → one 'on'", () => {
    // 2026-11-07 05:18: the core restarted at night while the power was off; the plug spoke first,
    // the ESP's fresh boot then looked like "an outage while the core was down".
    const { state } = simulate({
      start: T0,
      inputs: espPackets(s(0), s(60), UP0),
      plug: dead,
      until: s(100),
    });
    expect(state.power).toBe("off");
    const { effects, state: after } = simulate({
      start: s(900),
      persisted: persistDetector(state),
      inputs: [...plugReports(s(1000), s(1100)), ...espPackets(s(1007), s(1100), 4)],
      plug: alive,
    });
    expect(readable(effects).filter((e) => !("probe" in e))).toEqual([
      { on: 1000, detected: 1000, reason: "plug" },
    ]);
    expect(after.power).toBe("on");
  });

  it("an outage during the downtime never ends before it starts, even after a plug report", () => {
    const { effects } = simulate({
      start: s(600),
      persisted: { ...persistedOn(), lastPowerEvidence: s(60) },
      inputs: [...plugReports(s(601), s(640)), ...espPackets(s(605), s(640), 30)],
      plug: alive,
    });
    const power = readable(effects).filter((e) => "reason" in e);
    expect(power).toEqual([
      { off: 60, detected: 605, reason: "downtime", approximate: true },
      { on: 575, detected: 605, reason: "esp-reboot" },
    ]);
  });

  it("restart while an outage was open → the next ESP boot closes it", () => {
    const { state } = simulate({
      config: { zigbee: false },
      start: T0,
      inputs: espPackets(s(0), s(60), UP0),
      until: s(100),
    });
    expect(state.power).toBe("off");
    const { effects } = simulate({
      config: { zigbee: false },
      start: s(900),
      persisted: persistDetector(state),
      inputs: espPackets(s(1000), s(1010), 4),
    });
    expect(readable(effects)).toEqual([{ on: 996, detected: 1000, reason: "esp-reboot" }]);
  });
});

describe("nextWakeAt — no polling, exact wake-ups", () => {
  it("suspect moment, probe deadline, keep-alive or ESP-only deadline; nothing while off", () => {
    const config = DEFAULT_DETECTOR_CONFIG;
    const state = {
      ...initialDetectorState(T0),
      power: "on" as const,
      lastEsp: { t: s(10), up: 10, boot: null },
      espSeenSinceStart: true,
      lastPlugSeen: s(5),
    };
    expect(nextWakeAt(state, config)).toBe(s(15)); // suspect
    expect(
      nextWakeAt({ ...state, probe: { sentAt: s(15), purpose: "suspect", attempt: 1 } }, config),
    ).toBe(s(17));
    // Plug never heard from: keep-alive right away, otherwise the ESP-only deadline.
    expect(nextWakeAt({ ...state, lastPlugSeen: null }, config)).toBe(T0);
    expect(nextWakeAt({ ...state, lastPlugSeen: null, lastKeepaliveAt: s(10) }, config)).toBe(
      s(30),
    );
    expect(nextWakeAt({ ...state, power: "off" }, config)).toBeNull();
  });
});
