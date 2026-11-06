/**
 * Voltage watch of a site's plug: too low (below `low`) or too high (`high` and above).
 *
 * An abnormal reading starts a check: the plug is read every `readEveryMs`, and within
 * `confirmMs` the readings decide — an alert with the average voltage (as soon as
 * `minConfirmSamples` readings in a row are abnormal the same way, or when the minute is over and
 * its average is), or nothing (a single spike). After an alert the plug keeps being read; once the
 * voltage has stayed back inside the normal band (with a small margin against flapping) for a
 * whole `recoverWindowMs`, "stabilized" follows with the average of that window. A power outage
 * ends the episode silently — that is the outage detector's news.
 */
import type { Bus } from "../runtime/bus.ts";
import type { Clock, Timer } from "../runtime/clock.ts";

export type VoltageKind = "low" | "high";

export type VoltageWatchConfig = {
  /** Below this the voltage is low (V). */
  low: number;
  /** From this up the voltage is high (V). */
  high: number;
  /** Back to normal needs this far inside the band (V), against flapping at the edge. */
  margin: number;
  /** Readings at or below this mean no power at all — the outage detector's business (V). */
  noVoltageMax: number;
  confirmMs: number;
  minConfirmSamples: number;
  recoverWindowMs: number;
  readEveryMs: number;
};

export const DEFAULT_VOLTAGE_WATCH: VoltageWatchConfig = {
  low: 190,
  high: 245,
  margin: 3,
  noVoltageMax: 50,
  confirmMs: 60_000,
  minConfirmSamples: 3,
  recoverWindowMs: 2 * 60_000,
  readEveryMs: 15_000,
};

type Sample = { t: number; v: number };

export class VoltageMonitor {
  private readonly siteId: string;
  private readonly bus: Bus;
  private readonly clock: Clock;
  private readonly read: () => void;
  private readonly config: VoltageWatchConfig;
  private readonly unsubscribe: (() => void)[] = [];
  private phase: "idle" | "confirming" | "alerted" = "idle";
  private kind: VoltageKind = "low";
  private samples: Sample[] = [];
  private startedAt = 0;
  private readTimer: Timer | null = null;
  private deadline: Timer | null = null;

  constructor(deps: {
    siteId: string;
    bus: Bus;
    clock: Clock;
    /** Ask the plug for a reading (answers arrive as voltage.sample). */
    read: () => void;
    config?: Partial<VoltageWatchConfig>;
  }) {
    this.siteId = deps.siteId;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.read = deps.read;
    this.config = { ...DEFAULT_VOLTAGE_WATCH, ...deps.config };
    this.unsubscribe.push(
      deps.bus.on("voltage.sample", (e) => {
        if (e.siteId === this.siteId) this.onSample(e.t, e.voltage);
      }),
      deps.bus.on("power.changed", (e) => {
        if (e.siteId === this.siteId && e.state === "off") this.reset();
      }),
    );
  }

  get state(): "idle" | `confirming-${VoltageKind}` | `alerted-${VoltageKind}` {
    return this.phase === "idle" ? "idle" : `${this.phase}-${this.kind}`;
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.reset();
  }

  private abnormal(v: number): VoltageKind | null {
    if (v < this.config.low) return "low";
    if (v >= this.config.high) return "high";
    return null;
  }

  /** Comfortably back inside the normal band. */
  private stable(v: number): boolean {
    const { low, high, margin } = this.config;
    return v >= low + margin && v < high - margin;
  }

  private onSample(t: number, v: number): void {
    if (v <= this.config.noVoltageMax) return;
    if (this.phase === "idle") {
      const kind = this.abnormal(v);
      if (!kind) return;
      this.phase = "confirming";
      this.kind = kind;
      this.startedAt = t;
      this.samples = [{ t, v }];
      this.scheduleRead();
      this.deadline = this.clock.setTimer(t + this.config.confirmMs, () => {
        this.deadline = null;
        if (this.phase !== "confirming") return;
        if (this.abnormal(average(this.samples)) === this.kind) this.alert();
        else this.reset();
      });
      return;
    }
    if (this.phase === "confirming") {
      this.samples.push({ t, v });
      const recent = this.samples.slice(-this.config.minConfirmSamples);
      if (
        recent.length >= this.config.minConfirmSamples &&
        recent.every((s) => this.abnormal(s.v) === this.kind)
      ) {
        this.alert();
      }
      return;
    }
    // Alerted: `samples` is the current run of stable readings; anything else starts it over.
    if (!this.stable(v)) {
      this.samples = [];
      return;
    }
    this.samples.push({ t, v });
    const first = this.samples[0] as Sample;
    if (t - first.t >= this.config.recoverWindowMs) {
      this.bus.emit("voltage.stabilized", {
        siteId: this.siteId,
        kind: this.kind,
        voltage: Math.round(average(this.samples)),
        since: this.startedAt,
        at: t,
      });
      this.reset();
    }
  }

  private alert(): void {
    this.bus.emit("voltage.alert", {
      siteId: this.siteId,
      kind: this.kind,
      voltage: Math.round(average(this.samples)),
      since: this.startedAt,
    });
    this.phase = "alerted";
    this.samples = []; // the recovery is measured afresh
    this.clock.clearTimer(this.deadline);
    this.deadline = null;
  }

  private scheduleRead(): void {
    this.readTimer = this.clock.setTimer(this.clock.now() + this.config.readEveryMs, () => {
      this.readTimer = null;
      if (this.phase === "idle") return;
      this.read();
      this.scheduleRead();
    });
  }

  private reset(): void {
    this.phase = "idle";
    this.samples = [];
    this.clock.clearTimer(this.readTimer);
    this.clock.clearTimer(this.deadline);
    this.readTimer = null;
    this.deadline = null;
  }
}

function average(samples: readonly Sample[]): number {
  return samples.reduce((sum, s) => sum + s.v, 0) / Math.max(1, samples.length);
}
