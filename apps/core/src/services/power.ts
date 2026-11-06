/**
 * Power service of one site: runs the detector, wakes it exactly when needed, executes its effects
 * (plug reads, DB writes, bus events) and keeps per-minute heartbeat quality.
 */
import {
  type DetectorEffect,
  type DetectorInput,
  type DetectorState,
  initialDetectorState,
  nextWakeAt,
  persistDetector,
  stepDetector,
} from "@svitlo/domain";
import type { Store } from "@svitlo/storage";
import type { HeartbeatEvent } from "../adapters/heartbeat.ts";
import type { PlugEvent } from "../adapters/plug.ts";
import type { Bus } from "../runtime/bus.ts";
import type { Clock, Timer } from "../runtime/clock.ts";
import type { SiteConfig } from "../sites-config.ts";
import type { SiteStateStore } from "./state.ts";

const PERSIST_EVERY_MS = 5_000;
const MINUTE = 60_000;

type MinuteStats = { minute: number; packets: number; maxGapMs: number; reboots: number };

export type PowerServiceDeps = {
  site: SiteConfig;
  store: Store;
  bus: Bus;
  clock: Clock;
  state: SiteStateStore;
  /** Ask the site's plug for a reading; false when there is no plug or no connection. */
  probe: (siteId: string) => boolean;
  log?: { warn: (msg: string) => void };
};

export class PowerService {
  private readonly deps: PowerServiceDeps;
  private detector: DetectorState;
  private wakeTimer: Timer | null = null;
  private persistTimer: Timer | null = null;
  private dirty = false;
  private readonly heartbeat = new Map<
    string,
    MinuteStats & { lastT: number | null; lastUp: number | null; lastBoot: string | null }
  >();

  constructor(deps: PowerServiceDeps) {
    this.deps = deps;
    const persisted = deps.store.detector.load(deps.site.id);
    this.detector = initialDetectorState(deps.clock.now(), persisted);
    deps.state.update(deps.site.id, { power: this.detector.power, since: this.detector.since });
  }

  get siteId(): string {
    return this.deps.site.id;
  }

  get detectorState(): DetectorState {
    return this.detector;
  }

  start(): void {
    this.schedule();
    this.schedulePersist();
  }

  stop(): void {
    this.deps.clock.clearTimer(this.wakeTimer);
    this.deps.clock.clearTimer(this.persistTimer);
    this.wakeTimer = null;
    this.persistTimer = null;
    this.flushHeartbeat(true);
    this.persist();
  }

  onHeartbeat(event: HeartbeatEvent): void {
    this.trackHeartbeat(event);
    this.deps.state.update(this.siteId, { lastEspAt: event.t });
    this.input({
      type: "esp",
      t: event.t,
      up: event.up,
      boot: event.boot,
      resetReason: event.resetReason,
    });
  }

  onPlug(event: PlugEvent): void {
    this.deps.state.update(this.siteId, {
      lastPlugAt: event.t,
      ...(event.voltage !== null ? { lastVoltage: event.voltage } : {}),
    });
    if (event.voltage !== null) {
      this.deps.store.voltage.add(this.siteId, [{ t: event.t, voltage: event.voltage }]);
      this.deps.bus.emit("voltage.sample", {
        siteId: this.siteId,
        t: event.t,
        voltage: event.voltage,
      });
    }
    this.input({ type: "plug", t: event.t, voltage: event.voltage });
  }

  private input(input: DetectorInput): void {
    const before = this.detector;
    const step = stepDetector(before, input, this.deps.site.detector);
    this.detector = step.state;
    for (const effect of step.effects) this.apply(effect, before);
    if (
      step.state.lastEsp !== before.lastEsp ||
      step.state.power !== before.power ||
      step.state.lastPowerEvidence !== before.lastPowerEvidence
    ) {
      this.dirty = true;
    }
    this.schedule();
  }

  private apply(effect: DetectorEffect, before: DetectorState): void {
    const { bus, store, clock } = this.deps;
    const siteId = this.siteId;
    if (effect.type === "probe") {
      this.deps.probe(siteId);
      return;
    }
    store.power.record(siteId, effect, clock.now());
    switch (effect.type) {
      case "power":
        this.persist(); // a power change must survive a crash right away
        this.deps.state.update(siteId, { power: effect.state, since: effect.at });
        bus.emit("power.changed", {
          siteId,
          state: effect.state,
          at: effect.at,
          detectedAt: effect.detectedAt,
          reason: effect.reason,
          approximate: effect.approximate,
          previous: before.power,
          previousSince: before.since,
        });
        break;
      case "false-alarm":
        this.persist();
        this.deps.state.update(siteId, { power: this.detector.power, since: this.detector.since });
        bus.emit("power.false-alarm", {
          siteId,
          outageStartedAt: effect.outageStartedAt,
          detectedAt: effect.detectedAt,
        });
        break;
      case "blip":
        bus.emit("power.blip", { siteId, from: effect.from, to: effect.to });
        break;
      case "network-gap":
        bus.emit("power.network-gap", {
          siteId,
          from: effect.from,
          to: effect.to,
          confirmedBy: effect.confirmedBy,
        });
        break;
    }
  }

  /** Wake the detector exactly when it asked to (immediately if that moment has passed). */
  private schedule(): void {
    const { clock } = this.deps;
    clock.clearTimer(this.wakeTimer);
    this.wakeTimer = null;
    const wake = nextWakeAt(this.detector, this.deps.site.detector);
    if (wake === null) return;
    this.wakeTimer = clock.setTimer(wake, () => {
      this.wakeTimer = null;
      this.input({ type: "tick", t: Math.max(wake, clock.now()) });
    });
  }

  private schedulePersist(): void {
    this.persistTimer = this.deps.clock.setTimer(this.deps.clock.now() + PERSIST_EVERY_MS, () => {
      if (this.dirty) this.persist();
      this.flushHeartbeat(false);
      this.schedulePersist();
    });
  }

  private persist(): void {
    this.deps.store.detector.save(
      this.siteId,
      persistDetector(this.detector),
      this.deps.clock.now(),
    );
    this.dirty = false;
  }

  private trackHeartbeat(event: HeartbeatEvent): void {
    const minute = Math.floor(event.t / MINUTE) * MINUTE;
    let stats = this.heartbeat.get(event.deviceId);
    if (!stats) {
      stats = {
        minute,
        packets: 0,
        maxGapMs: 0,
        reboots: 0,
        lastT: null,
        lastUp: null,
        lastBoot: null,
      };
      this.heartbeat.set(event.deviceId, stats);
    }
    if (stats.minute !== minute) {
      this.writeMinute(event.deviceId, stats);
      Object.assign(stats, { minute, packets: 0, maxGapMs: 0, reboots: 0 });
    }
    stats.packets++;
    if (stats.lastT !== null) stats.maxGapMs = Math.max(stats.maxGapMs, event.t - stats.lastT);
    const rebooted =
      (event.boot !== null && stats.lastBoot !== null && event.boot !== stats.lastBoot) ||
      (event.up !== null && stats.lastUp !== null && event.up < stats.lastUp);
    if (rebooted) stats.reboots++;
    stats.lastT = event.t;
    stats.lastUp = event.up;
    stats.lastBoot = event.boot;
  }

  /** Write finished minutes (all of them on shutdown). */
  private flushHeartbeat(all: boolean): void {
    const current = Math.floor(this.deps.clock.now() / MINUTE) * MINUTE;
    for (const [deviceId, stats] of this.heartbeat) {
      if (stats.packets === 0) continue;
      if (!all && stats.minute >= current) continue;
      this.writeMinute(deviceId, stats);
      Object.assign(stats, { packets: 0, maxGapMs: 0, reboots: 0 });
    }
  }

  private writeMinute(deviceId: string, stats: MinuteStats): void {
    if (stats.packets === 0) return;
    this.deps.store.heartbeat.addMinute(this.siteId, deviceId, stats.minute, {
      packets: stats.packets,
      maxGapMs: stats.maxGapMs,
      reboots: stats.reboots,
    });
  }
}
