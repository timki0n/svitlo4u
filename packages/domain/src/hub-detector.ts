/**
 * Power detector of a hub site (docs/hub-protocol.md): the hub sits on the router's UPS, watches
 * its Zigbee plug and decides itself when the mains went and came back. This reducer turns its
 * reports into power changes at the times the hub measured, alerts when the hub goes silent (on a
 * UPS that means no internet, not an outage) and infers an outage when the hub itself lost power.
 *
 * Pure reducer like the ESP detector: stepHubDetector(state, input) → { state, effects }.
 */
import type { PersistedDetector, PowerReason, PowerState } from "./power-detector.ts";

export type HubDetectorConfig = {
  /** No report from the hub this long → admin alert. */
  silentAlertMs: number;
};

export const DEFAULT_HUB_DETECTOR_CONFIG: HubDetectorConfig = {
  silentAlertMs: 2 * 60_000,
};

export type HubMains = "on" | "off" | "unknown";

export type HubReport = {
  /** When the core received it. */
  t: number;
  boot: string;
  /** Hub uptime, seconds (with milliseconds), when the report was built. */
  up: number;
  rst: string;
  /** The hub's current verdict about the mains. */
  mains: HubMains;
  /** Hub uptime (s) when the current verdict began. */
  mainsSince: number | null;
  /** Mains changes not yet acknowledged, by hub uptime (s). */
  events: readonly { up: number; mains: "on" | "off" }[];
};

export type HubInput = { type: "report"; report: HubReport } | { type: "tick"; t: number };

export type HubDetectorState = {
  power: PowerState;
  since: number | null;
  lastReport: { t: number; boot: string; up: number } | null;
  /** Latest event uptime applied in the current boot: resent events are skipped. */
  appliedUp: number | null;
  silentAlerted: boolean;
};

export type HubEffect =
  | {
      type: "power";
      state: "on" | "off";
      at: number;
      detectedAt: number;
      reason: PowerReason;
      approximate: boolean;
    }
  /** The hub has been silent since `since`. */
  | { type: "hub-silent"; since: number; detectedAt: number }
  /** The hub is back after a silence; `powerLoss`: it rebooted because it lost power. */
  | { type: "hub-back"; silentFrom: number; at: number; rebooted: boolean; powerLoss: boolean };

export type HubStep = { state: HubDetectorState; effects: HubEffect[] };

/** Reset reasons that mean the hub lost power (as in the ESP protocol). */
const POWER_LOSS_RESETS = new Set(["poweron", "brownout"]);

export function initialHubDetectorState(persisted?: PersistedDetector | null): HubDetectorState {
  const last = persisted?.lastEsp;
  return {
    power: persisted?.power ?? "unknown",
    since: persisted?.since ?? null,
    lastReport:
      last && last.boot !== null && last.up !== null
        ? { t: last.t, boot: last.boot, up: last.up }
        : null,
    appliedUp: null,
    silentAlerted: false,
  };
}

/** Stored in the same shape as the ESP detector: the last report rides in `lastEsp`. */
export function persistHubDetector(state: HubDetectorState): PersistedDetector {
  return {
    power: state.power,
    since: state.since,
    onSinceBeforeOutage: null,
    unverifiedOutage: null,
    lastEsp: state.lastReport
      ? { t: state.lastReport.t, up: state.lastReport.up, boot: state.lastReport.boot }
      : null,
    lastPowerEvidence: state.power === "on" && state.lastReport ? state.lastReport.t : null,
  };
}

export function stepHubDetector(
  state: HubDetectorState,
  input: HubInput,
  config: HubDetectorConfig = DEFAULT_HUB_DETECTOR_CONFIG,
): HubStep {
  if (input.type === "tick") {
    const last = state.lastReport;
    if (!last || state.silentAlerted || input.t - last.t < config.silentAlertMs) {
      return { state, effects: [] };
    }
    return {
      state: { ...state, silentAlerted: true },
      effects: [{ type: "hub-silent", since: last.t, detectedAt: input.t }],
    };
  }
  return report(state, input.report);
}

function report(state: HubDetectorState, r: HubReport): HubStep {
  const effects: HubEffect[] = [];
  const s: HubDetectorState = { ...state };
  const at = (up: number) => r.t - Math.round((r.up - up) * 1000);
  const change = (to: "on" | "off", when: number, reason: PowerReason, approximate: boolean) => {
    // Never before the current state began: the order of the timeline must hold.
    const t = s.since !== null && when < s.since ? s.since : Math.min(when, r.t);
    effects.push({ type: "power", state: to, at: t, detectedAt: r.t, reason, approximate });
    s.power = to;
    s.since = t;
  };

  const prev = state.lastReport;
  const newBoot = prev !== null && prev.boot !== r.boot;
  const powerLoss = newBoot && POWER_LOSS_RESETS.has(r.rst);
  if (newBoot) s.appliedUp = null;
  // The hub lost power: the mains went around its last report (the hub had no UPS or it ran out).
  if (powerLoss && prev && s.power === "on") change("off", prev.t, "hub-reboot", true);
  if (state.silentAlerted && prev) {
    effects.push({ type: "hub-back", silentFrom: prev.t, at: r.t, rebooted: newBoot, powerLoss });
    s.silentAlerted = false;
  }

  for (const event of [...r.events].sort((a, b) => a.up - b.up)) {
    if (s.appliedUp !== null && event.up <= s.appliedUp) continue;
    s.appliedUp = event.up;
    if (event.mains !== s.power) change(event.mains, at(event.up), "hub", false);
  }
  // The current verdict covers what no event said (e.g. the first report after a boot).
  if (r.mains !== "unknown" && r.mains !== s.power) {
    const when = r.mainsSince !== null ? at(r.mainsSince) : r.t;
    change(r.mains, when, powerLoss ? "hub-reboot" : "hub", r.mainsSince === null);
  }

  s.lastReport = { t: r.t, boot: r.boot, up: r.up };
  return { state: s, effects };
}

export function nextHubWakeAt(
  state: HubDetectorState,
  config: HubDetectorConfig = DEFAULT_HUB_DETECTOR_CONFIG,
): number | null {
  if (!state.lastReport || state.silentAlerted) return null;
  return state.lastReport.t + config.silentAlertMs;
}
