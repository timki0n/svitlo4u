/**
 * Power detector: ESP32 heartbeat (primary) + Zigbee plug (confirmation).
 *
 * Pure reducer: stepDetector(state, input) → { state, effects }. The runtime feeds ESP packets,
 * plug messages and ticks, executes effects (read the plug, notify, store) and wakes the reducer
 * at nextWakeAt() — no fixed polling interval.
 *
 * Facts it relies on (verified 2026-11 on production logs and the real plug):
 * - the ESP reports its uptime in seconds; it grows 1:1 with wall time (drift < 0.5 s over hours),
 *   so "uptime continued" proves the ESP — and the mains — never went down, and "uptime reset"
 *   proves a real power loss; the ESP boot moment (t − uptime) is when power came back;
 * - Wi-Fi drops make the ESP silent for 10–12 s without any power loss;
 * - the plug (Zbeacon TS011F) is mains-powered with no battery: any message from it means power;
 *   it answers an attribute read (rmsVoltage) in 0.2–0.5 s, occasionally in 2.5–3 s when busy
 *   (hence two read attempts), ignores reporting settings and may stay silent for up to an hour on
 *   its own (hence the keep-alive reads); zigbee2mqtt itself does not notice it disappearing.
 */

export type PowerState = "unknown" | "on" | "off";

export type DetectorConfig = {
  /** Zigbee plug is configured for this site. */
  zigbee: boolean;
  /** ESP silent this long → read the plug (or, without a usable plug, start the ESP-only countdown). */
  suspectAfterMs: number;
  /** Wait this long for the plug to answer one read. */
  probeTimeoutMs: number;
  /** Reads before "no answer" means no power (a busy plug sometimes answers after 2.5–3 s). */
  probeAttempts: number;
  /** While the ESP stays silent but the plug says power is present, re-check the plug this often. */
  reprobeIntervalMs: number;
  /** Read the plug this often while everything is fine, so we know it is reachable. */
  plugKeepaliveMs: number;
  /** The plug counts as usable only if it said anything within this period. */
  zigbeeStaleMs: number;
  /** Without a usable plug: ESP silence this long → power is off. */
  espOnlyOffAfterMs: number;
  /** Plug voltage above this → power present; at or below → no power. */
  noVoltageMax: number;
  /** Allowed difference between ESP uptime growth and wall time before calling it a reboot. */
  uptimeToleranceMs: number;
};

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  zigbee: true,
  suspectAfterMs: 5_000,
  probeTimeoutMs: 2_000,
  probeAttempts: 2,
  reprobeIntervalMs: 30_000,
  plugKeepaliveMs: 60_000,
  zigbeeStaleMs: 3 * 60_000,
  espOnlyOffAfterMs: 20_000,
  noVoltageMax: 50,
  uptimeToleranceMs: 10_000,
};

export type EspSample = {
  t: number;
  up: number | null;
  boot: string | null;
  /** Why the ESP last booted (v2 firmware): poweron, brownout, sw, panic, wdt, … */
  resetReason?: string | null;
};

/** ESP reboots that are not caused by the mains (the ESP restarted itself). */
const NON_POWER_RESETS = new Set(["sw", "panic", "wdt", "deepsleep", "usb", "ext"]);

export type ProbePurpose =
  /** The ESP went silent: is there power? A timeout means no. */
  | "suspect"
  /** Routine check that the plug is reachable. A timeout only marks the plug unusable. */
  | "keepalive";

export type DetectorState = {
  power: PowerState;
  /** When the current power state began (best estimate). */
  since: number | null;
  /** Start of the light-on period before the current/last outage (restored on a false alarm). */
  onSinceBeforeOutage: number | null;
  /**
   * Outage not yet confirmed by the ESP uptime (reset = real, continued = false alarm).
   * `decidedAt`/`byTimeout`: when it was declared and whether only because the plug did not answer
   * (a plug message right after that is a late answer → false alarm). Absent in older saved states.
   */
  unverifiedOutage: { start: number; decidedAt?: number; byTimeout?: boolean } | null;
  lastEsp: EspSample | null;
  /** Latest instant power was known to be present (ESP packet or plug message). */
  lastPowerEvidence: number | null;
  lastPlugSeen: number | null;
  /** The plug confirmed power during the current ESP silence. */
  plugConfirmedSilence: boolean;
  probe: { sentAt: number; purpose: ProbePurpose; attempt: number } | null;
  lastSuspectProbeAt: number | null;
  lastKeepaliveAt: number | null;
  /** When this detector instance (the core process) started. */
  startedAt: number;
  /** At least one ESP packet arrived since startedAt. */
  espSeenSinceStart: boolean;
};

/** What survives a restart (stored every few seconds). */
export type PersistedDetector = Pick<
  DetectorState,
  "power" | "since" | "onSinceBeforeOutage" | "unverifiedOutage" | "lastEsp" | "lastPowerEvidence"
>;

export type DetectorInput =
  | { type: "esp"; t: number; up: number | null; boot?: string | null; resetReason?: string | null }
  /** Any message from the plug (report, announce, answer to a read). voltage null = not included. */
  | { type: "plug"; t: number; voltage: number | null }
  | { type: "tick"; t: number };

export type PowerReason =
  /** ESP came back with a fresh uptime: power returned at the ESP boot moment. */
  | "esp-reboot"
  /** ESP came back but its uptime cannot tell (no uptime in the packet). */
  | "esp-packet"
  /** The plug spoke while power was considered off. */
  | "plug"
  /** ESP silent and the plug did not answer. */
  | "probe-timeout"
  /** ESP silent and the plug measured no voltage. */
  | "probe-no-voltage"
  /** No usable plug: ESP silent for espOnlyOffAfterMs. */
  | "esp-timeout"
  /** The ESP rebooted while the core was down: an outage happened in between. */
  | "downtime";

export type DetectorEffect =
  | {
      type: "power";
      state: "on" | "off";
      /** When it happened (best estimate). */
      at: number;
      /** When the detector decided. */
      detectedAt: number;
      reason: PowerReason;
      /** `at` is only a bound: the change happened while the core was down. */
      approximate: boolean;
    }
  /** Read the plug (rmsVoltage). */
  | { type: "probe"; t: number; purpose: ProbePurpose }
  | { type: "false-alarm"; outageStartedAt: number; detectedAt: number }
  | { type: "network-gap"; from: number; to: number; confirmedBy: "zigbee" | "uptime" }
  | { type: "blip"; from: number; to: number };

export type DetectorStep = { state: DetectorState; effects: DetectorEffect[] };

export function initialDetectorState(
  now: number,
  persisted?: PersistedDetector | null,
): DetectorState {
  return {
    power: persisted?.power ?? "unknown",
    since: persisted?.since ?? null,
    onSinceBeforeOutage: persisted?.onSinceBeforeOutage ?? null,
    unverifiedOutage: persisted?.unverifiedOutage ?? null,
    lastEsp: persisted?.lastEsp ?? null,
    lastPowerEvidence: persisted?.lastPowerEvidence ?? null,
    lastPlugSeen: null,
    plugConfirmedSilence: false,
    probe: null,
    lastSuspectProbeAt: null,
    lastKeepaliveAt: null,
    startedAt: now,
    espSeenSinceStart: false,
  };
}

export function persistDetector(state: DetectorState): PersistedDetector {
  return {
    power: state.power,
    since: state.since,
    onSinceBeforeOutage: state.onSinceBeforeOutage,
    unverifiedOutage: state.unverifiedOutage,
    lastEsp: state.lastEsp,
    lastPowerEvidence: state.lastPowerEvidence,
  };
}

export function stepDetector(
  state: DetectorState,
  input: DetectorInput,
  config: DetectorConfig,
): DetectorStep {
  switch (input.type) {
    case "esp":
      return onEsp(
        state,
        {
          t: input.t,
          up: input.up,
          boot: input.boot ?? null,
          resetReason: input.resetReason ?? null,
        },
        config,
      );
    case "plug":
      return onPlug(state, input.t, input.voltage, config);
    case "tick":
      return onTick(state, input.t, config);
  }
}

/** Earliest moment a tick can change anything — schedule the next wake-up here. */
export function nextWakeAt(state: DetectorState, config: DetectorConfig): number | null {
  if (state.probe) return state.probe.sentAt + config.probeTimeoutMs;
  if (state.power === "off") return null;
  const candidates = [checkDueAt(state, config)];
  const keepalive = keepaliveDueAt(state, config);
  if (keepalive !== null) candidates.push(keepalive);
  return Math.min(...candidates);
}

// ───────────────────────── internals ─────────────────────────

function silenceAnchor(state: DetectorState): number {
  // Give the ESP time after a restart instead of counting the core's own downtime as silence.
  return state.espSeenSinceStart && state.lastEsp ? state.lastEsp.t : state.startedAt;
}

/** The plug is trusted only after it has said something recently. */
function plugUsable(state: DetectorState, at: number, config: DetectorConfig): boolean {
  if (!config.zigbee || state.lastPlugSeen === null) return false;
  return at - state.lastPlugSeen < config.zigbeeStaleMs;
}

/** When the ESP silence must be acted upon (suspect probe, re-probe or ESP-only off). */
function checkDueAt(state: DetectorState, config: DetectorConfig): number {
  const anchor = silenceAnchor(state);
  if (plugUsable(state, anchor, config)) {
    if (!state.plugConfirmedSilence) return anchor + config.suspectAfterMs;
    return (state.lastSuspectProbeAt ?? anchor) + config.reprobeIntervalMs;
  }
  return anchor + config.espOnlyOffAfterMs;
}

function keepaliveDueAt(state: DetectorState, config: DetectorConfig): number | null {
  if (!config.zigbee) return null;
  const lastContact = Math.max(
    state.lastPlugSeen ?? state.startedAt - config.plugKeepaliveMs,
    state.lastKeepaliveAt ?? Number.NEGATIVE_INFINITY,
  );
  return lastContact + config.plugKeepaliveMs;
}

/** true = ESP rebooted since `last`, false = uptime continued, null = cannot tell. */
function isReboot(
  last: EspSample | null,
  sample: EspSample,
  config: DetectorConfig,
): boolean | null {
  if (!last) return null;
  if (sample.boot !== null && last.boot !== null && sample.boot !== last.boot) return true;
  if (sample.up === null || last.up === null) return null;
  const expectedUp = last.up + (sample.t - last.t) / 1000;
  return sample.up < expectedUp - config.uptimeToleranceMs / 1000;
}

function powerEffect(
  state: "on" | "off",
  at: number,
  detectedAt: number,
  reason: PowerReason,
  approximate = false,
): DetectorEffect {
  return { type: "power", state, at, detectedAt, reason, approximate };
}

function turnOff(s: DetectorState, now: number, reason: PowerReason): DetectorStep {
  const at = s.lastPowerEvidence ?? s.lastEsp?.t ?? s.startedAt;
  const approximate = !s.espSeenSinceStart && at <= s.startedAt;
  const next: DetectorState = {
    ...s,
    power: "off",
    onSinceBeforeOutage: s.power === "on" ? s.since : s.onSinceBeforeOutage,
    since: at,
    unverifiedOutage: { start: at, decidedAt: now, byTimeout: reason === "probe-timeout" },
    probe: null,
    plugConfirmedSilence: false,
  };
  return { state: next, effects: [powerEffect("off", at, now, reason, approximate)] };
}

function onEsp(s: DetectorState, sample: EspSample, config: DetectorConfig): DetectorStep {
  const effects: DetectorEffect[] = [];
  const last = s.lastEsp;
  const rebooted = isReboot(last, sample, config);
  const bootAt = sample.up !== null ? sample.t - sample.up * 1000 : sample.t;
  const gapStart = last?.t ?? null;
  const gapIncludesDowntime = gapStart !== null && !s.espSeenSinceStart && gapStart < s.startedAt;
  let next: DetectorState = {
    ...s,
    lastEsp: sample,
    lastPowerEvidence: sample.t,
    espSeenSinceStart: true,
    // The ESP is back: a pending "is there power?" read is moot; a keep-alive read still counts.
    probe: s.probe?.purpose === "keepalive" ? s.probe : null,
    lastSuspectProbeAt: null,
    plugConfirmedSilence: false,
  };

  // An unverified outage gets its verdict from the uptime.
  let falseAlarm = false;
  if (s.unverifiedOutage && last && last.t <= s.unverifiedOutage.start && rebooted !== null) {
    falseAlarm = rebooted === false;
    if (falseAlarm) {
      effects.push({
        type: "false-alarm",
        outageStartedAt: s.unverifiedOutage.start,
        detectedAt: sample.t,
      });
    }
    next = { ...next, unverifiedOutage: null };
  }

  if (s.power === "off") {
    if (falseAlarm) {
      if (gapStart !== null) {
        effects.push({ type: "network-gap", from: gapStart, to: sample.t, confirmedBy: "uptime" });
      }
      next = { ...next, power: "on", since: s.onSinceBeforeOutage ?? s.since };
      return { state: next, effects };
    }
    // No earlier packet to compare with (state taken over from the legacy bot): an ESP that booted
    // after the outage began still proves power came back at its boot moment.
    const bootedDuringOutage =
      rebooted === null &&
      last === null &&
      sample.up !== null &&
      s.since !== null &&
      bootAt >= s.since;
    const fromBoot = rebooted === true || bootedDuringOutage;
    const at = fromBoot ? Math.max(s.since ?? Number.NEGATIVE_INFINITY, bootAt) : sample.t;
    effects.push(powerEffect("on", at, sample.t, fromBoot ? "esp-reboot" : "esp-packet"));
    next = { ...next, power: "on", since: at };
    return { state: next, effects };
  }

  if (s.power === "unknown") {
    // First evidence after a fresh start: power is on, at least since the ESP booted.
    next = { ...next, power: "on", since: bootAt };
    return { state: next, effects };
  }

  // Power was "on".
  if (rebooted === true && gapStart !== null) {
    // The firmware says why it booted: a crash or watchdog restart is not a power event.
    if (sample.resetReason && NON_POWER_RESETS.has(sample.resetReason)) {
      return { state: next, effects };
    }
    if (gapIncludesDowntime) {
      // The mains went down while the core was not running.
      const offAt = s.lastPowerEvidence ?? gapStart;
      effects.push(powerEffect("off", offAt, sample.t, "downtime", true));
      effects.push(powerEffect("on", bootAt, sample.t, "esp-reboot"));
      next = { ...next, since: bootAt, onSinceBeforeOutage: s.since, unverifiedOutage: null };
    } else if (!s.plugConfirmedSilence) {
      // Power loss shorter than our decision time. If the plug vouched for power during the gap,
      // the ESP restarted on its own (watchdog, firmware update) — not a power event.
      effects.push({ type: "blip", from: gapStart, to: Math.max(gapStart, bootAt) });
    }
    return { state: next, effects };
  }

  // Uptime that continued proves power since the ESP booted — an earlier start than the plug may
  // have reported first after a restart.
  if (sample.up !== null && s.since !== null && bootAt < s.since) next = { ...next, since: bootAt };

  if (gapStart !== null && !gapIncludesDowntime && sample.t - gapStart >= config.suspectAfterMs) {
    effects.push({
      type: "network-gap",
      from: gapStart,
      to: sample.t,
      confirmedBy: s.plugConfirmedSilence ? "zigbee" : "uptime",
    });
  }
  return { state: next, effects };
}

function onTick(s: DetectorState, now: number, config: DetectorConfig): DetectorStep {
  if (s.probe) {
    if (now - s.probe.sentAt < config.probeTimeoutMs) return { state: s, effects: [] };
    const cleared: DetectorState = { ...s, probe: null };
    // A missed keep-alive only means the plug is not reachable right now.
    if (s.probe.purpose === "keepalive" || s.power === "off")
      return { state: cleared, effects: [] };
    if (s.probe.attempt < config.probeAttempts) {
      const attempt = s.probe.attempt + 1;
      return {
        state: { ...s, probe: { sentAt: now, purpose: "suspect", attempt } },
        effects: [{ type: "probe", t: now, purpose: "suspect" }],
      };
    }
    return turnOff(cleared, now, "probe-timeout");
  }
  if (s.power === "off") return { state: s, effects: [] };

  if (now >= checkDueAt(s, config)) {
    if (plugUsable(s, silenceAnchor(s), config)) {
      return {
        state: {
          ...s,
          probe: { sentAt: now, purpose: "suspect", attempt: 1 },
          lastSuspectProbeAt: now,
        },
        effects: [{ type: "probe", t: now, purpose: "suspect" }],
      };
    }
    return turnOff(s, now, "esp-timeout");
  }

  const keepalive = keepaliveDueAt(s, config);
  if (keepalive !== null && now >= keepalive) {
    return {
      state: {
        ...s,
        probe: { sentAt: now, purpose: "keepalive", attempt: 1 },
        lastKeepaliveAt: now,
      },
      effects: [{ type: "probe", t: now, purpose: "keepalive" }],
    };
  }
  return { state: s, effects: [] };
}

function onPlug(
  s: DetectorState,
  now: number,
  voltage: number | null,
  config: DetectorConfig,
): DetectorStep {
  const present = voltage === null || voltage > config.noVoltageMax;
  const pending = s.probe;
  const base: DetectorState = { ...s, lastPlugSeen: now, probe: null };

  if (pending?.purpose === "suspect" && !present) {
    return s.power === "off"
      ? { state: base, effects: [] }
      : turnOff(base, now, "probe-no-voltage");
  }
  const espSilent = now - silenceAnchor(s) >= config.suspectAfterMs;
  if (!present) {
    // No voltage while the ESP is silent too: the power is gone (even if the plug vouched for it
    // a moment ago). A stray 0 V reading while the ESP keeps talking is not enough on its own.
    if (espSilent && s.power === "on") return turnOff(base, now, "probe-no-voltage");
    return {
      state: { ...base, probe: pending?.purpose === "keepalive" ? null : pending },
      effects: [],
    };
  }

  // The plug is alive → power is present. While the ESP is silent this is a confirmed check:
  // re-check after reprobeIntervalMs instead of treating the old silence as a fresh suspicion.
  const withEvidence: DetectorState = {
    ...base,
    lastPowerEvidence: Math.max(s.lastPowerEvidence ?? now, now),
    plugConfirmedSilence: espSilent,
    lastSuspectProbeAt: espSilent
      ? pending?.purpose === "suspect"
        ? pending.sentAt
        : now
      : s.lastSuspectProbeAt,
  };
  if (s.power === "off") {
    const outage = s.unverifiedOutage;
    if (
      outage?.byTimeout &&
      outage.decidedAt !== undefined &&
      now - outage.decidedAt <= config.probeTimeoutMs
    ) {
      // The plug answered just after we gave up waiting: the power never went away.
      return {
        state: {
          ...withEvidence,
          power: "on",
          since: s.onSinceBeforeOutage ?? s.since,
          unverifiedOutage: null,
        },
        effects: [{ type: "false-alarm", outageStartedAt: outage.start, detectedAt: now }],
      };
    }
    return {
      state: { ...withEvidence, power: "on", since: now },
      effects: [powerEffect("on", now, now, "plug")],
    };
  }
  if (s.power === "unknown") {
    return { state: { ...withEvidence, power: "on", since: now }, effects: [] };
  }
  return { state: withEvidence, effects: [] };
}
