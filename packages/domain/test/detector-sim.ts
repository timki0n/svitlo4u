/** Event-driven runtime simulation for the power detector (what apps/core will do for real). */
import {
  DEFAULT_DETECTOR_CONFIG,
  type DetectorConfig,
  type DetectorEffect,
  type DetectorInput,
  type DetectorState,
  initialDetectorState,
  nextWakeAt,
  type PersistedDetector,
  stepDetector,
} from "../src/index.ts";

export type SimPlug = {
  /** Voltage the plug answers a read with at time t, or null when it does not answer. */
  answer: (t: number) => number | null;
  latencyMs?: number;
};

export type SimOptions = {
  config?: Partial<DetectorConfig>;
  start: number;
  persisted?: PersistedDetector | null;
  inputs: DetectorInput[];
  plug?: SimPlug;
  /** Stop waking the detector after this instant (default: last input). */
  until?: number;
};

export function simulate(options: SimOptions): {
  state: DetectorState;
  effects: DetectorEffect[];
  ticks: number;
} {
  const config: DetectorConfig = { ...DEFAULT_DETECTOR_CONFIG, ...options.config };
  const queue = [...options.inputs].sort((a, b) => a.t - b.t);
  const until = options.until ?? queue.at(-1)?.t ?? options.start;
  let state = initialDetectorState(options.start, options.persisted);
  const effects: DetectorEffect[] = [];
  let ticks = 0;
  let clock = options.start;
  let idleTicksAtSameTime = 0;

  const insert = (input: DetectorInput) => {
    const index = queue.findIndex((q) => q.t > input.t);
    if (index === -1) queue.push(input);
    else queue.splice(index, 0, input);
  };

  const apply = (input: DetectorInput) => {
    clock = Math.max(clock, input.t);
    const step = stepDetector(state, input, config);
    const changed = step.state !== state;
    state = step.state;
    if (input.type === "tick") {
      // A real runtime would spin forever on a tick that changes nothing at the same instant.
      idleTicksAtSameTime = changed || step.effects.length > 0 ? 0 : idleTicksAtSameTime + 1;
      if (idleTicksAtSameTime > 3)
        throw new Error(`detector keeps waking at ${input.t} without progress`);
    }
    for (const effect of step.effects) {
      effects.push(effect);
      if (effect.type === "probe" && options.plug) {
        const voltage = options.plug.answer(effect.t);
        if (voltage !== null) {
          insert({ type: "plug", t: effect.t + (options.plug.latencyMs ?? 300), voltage });
        }
      }
    }
  };

  for (;;) {
    const next = queue[0];
    const wake = nextWakeAt(state, config);
    if (wake !== null && wake <= until && (next === undefined || wake < next.t)) {
      // A wake-up time already in the past means "now", exactly like a timer with a negative delay.
      ticks++;
      apply({ type: "tick", t: Math.max(wake, clock) });
      continue;
    }
    if (!next) break;
    queue.shift();
    apply(next);
  }
  return { state, effects, ticks };
}

/** ESP packets every `intervalMs` from `from` to `to` (inclusive), uptime growing 1:1. */
export function espPackets(
  from: number,
  to: number,
  upFrom: number,
  intervalMs = 2_000,
): DetectorInput[] {
  const packets: DetectorInput[] = [];
  for (let t = from; t < to; t += intervalMs) {
    packets.push({ type: "esp", t, up: upFrom + Math.floor((t - from) / 1000) });
  }
  packets.push({ type: "esp", t: to, up: upFrom + Math.floor((to - from) / 1000) });
  return packets;
}

/** Unsolicited plug messages every `everyMs` in [from, to]. */
export function plugReports(
  from: number,
  to: number,
  voltage = 230,
  everyMs = 60_000,
): DetectorInput[] {
  const reports: DetectorInput[] = [];
  for (let t = from; t <= to; t += everyMs) reports.push({ type: "plug", t, voltage });
  return reports;
}
