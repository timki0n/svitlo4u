/**
 * Power service of a hub site (docs/hub-protocol.md): runs the hub detector on the hub's reports,
 * executes its effects (DB writes, bus events) and wakes it for the silence alert.
 */
import {
  type HubDetectorState,
  type HubEffect,
  type HubInput,
  initialHubDetectorState,
  nextHubWakeAt,
  persistHubDetector,
  stepHubDetector,
} from "@svitlo/domain";
import type { Store } from "@svitlo/storage";
import type { HubReportEvent } from "../adapters/hub.ts";
import type { Bus } from "../runtime/bus.ts";
import type { Clock, Timer } from "../runtime/clock.ts";
import type { HubDeviceConfig, SiteConfig } from "../sites-config.ts";
import type { HubStatus } from "./ownership.ts";
import type { SiteStateStore } from "./state.ts";

/** Saved at least this often while reports come (the last report survives a core restart). */
const PERSIST_EVERY_MS = 60_000;

export type HubPowerServiceDeps = {
  site: SiteConfig;
  hub: HubDeviceConfig;
  store: Store;
  bus: Bus;
  clock: Clock;
  state: SiteStateStore;
};

export class HubPowerService {
  private readonly deps: HubPowerServiceDeps;
  private detector: HubDetectorState;
  private wakeTimer: Timer | null = null;
  private savedAt = Number.NEGATIVE_INFINITY;
  /** The previous report's boot / firmware / rolled-back version (this core run). */
  private last: { boot: string; fw: string | null; rejected: string | null } | null = null;
  /** The last report as «Мої будинки» shows it. */
  private latest: HubReportEvent | null = null;

  constructor(deps: HubPowerServiceDeps) {
    this.deps = deps;
    this.detector = initialHubDetectorState(deps.store.detector.load(deps.site.id));
    deps.state.update(deps.site.id, { power: this.detector.power, since: this.detector.since });
  }

  get siteId(): string {
    return this.deps.site.id;
  }

  get detectorState(): HubDetectorState {
    return this.detector;
  }

  start(): void {
    this.schedule();
  }

  stop(): void {
    this.deps.clock.clearTimer(this.wakeTimer);
    this.wakeTimer = null;
    this.persist();
  }

  /** What the owner sees in «Мої будинки». */
  status(): HubStatus {
    const r = this.latest;
    return {
      lastReportAt: r?.t ?? null,
      fw: r?.fw ?? null,
      paired: r?.paired ?? null,
      mains: r?.mains ?? null,
      voltage: r?.voltage ?? null,
      linkGaps: r?.linkGaps ?? null,
      alertDelay: r?.alertDelay ?? null,
      rssi: r?.rssiAvg ?? r?.rssi ?? null,
    };
  }

  onReport(event: HubReportEvent): void {
    const { state, store, bus } = this.deps;
    this.noticeFirmware(event);
    this.noticeLinkGaps(event);
    this.latest = event;
    state.update(this.siteId, {
      lastEspAt: event.t,
      ...(event.mains === "on" ? { lastPlugAt: event.t } : {}),
      ...(event.voltage !== null && event.mains === "on" ? { lastVoltage: event.voltage } : {}),
    });
    if (event.voltage !== null && event.mains === "on") {
      store.voltage.add(this.siteId, [{ t: event.t, voltage: event.voltage }]);
      bus.emit("voltage.sample", { siteId: this.siteId, t: event.t, voltage: event.voltage });
    }
    this.input({
      type: "report",
      report: {
        t: event.t,
        boot: event.boot,
        up: event.up,
        rst: event.rst,
        mains: event.mains,
        mainsSince: event.mainsSince,
        events: event.events,
      },
    });
    if (this.deps.clock.now() - this.savedAt >= PERSIST_EVERY_MS) this.persist();
  }

  /** The plug fell silent for a while but the hub judged it the radio, not the mains. */
  private noticeLinkGaps(event: HubReportEvent): void {
    const before = this.latest;
    if (event.linkGaps === null || !before || before.boot !== event.boot) return;
    const was = before.linkGaps ?? 0;
    if (event.linkGaps <= was) return;
    this.deps.bus.emit("hub.link-gap", {
      siteId: this.siteId,
      deviceId: this.deps.hub.id,
      gaps: event.linkGaps,
      longest: event.longestGap,
      rssi: event.rssi,
    });
  }

  /** A new boot on another firmware: updated, or a new image rolled back. */
  private noticeFirmware(event: HubReportEvent): void {
    const rejected = event.ota?.rejected ?? null;
    const last = this.last;
    this.last = { boot: event.boot, fw: event.fw, rejected };
    if (!last || last.boot === event.boot) return;
    const deviceId = this.deps.hub.id;
    if (rejected && rejected !== last.rejected) {
      this.deps.bus.emit("hub.update-rejected", {
        siteId: this.siteId,
        deviceId,
        version: rejected,
        fw: event.fw,
      });
    } else if (last.fw && event.fw && event.fw !== last.fw) {
      this.deps.bus.emit("hub.updated", {
        siteId: this.siteId,
        deviceId,
        from: last.fw,
        to: event.fw,
      });
    }
  }

  private input(input: HubInput): void {
    const before = this.detector;
    const step = stepHubDetector(before, input, { silentAlertMs: this.deps.hub.silentAlertMs });
    this.detector = step.state;
    let previous = { power: before.power, since: before.since };
    for (const effect of step.effects) {
      this.apply(effect, previous);
      if (effect.type === "power") previous = { power: effect.state, since: effect.at };
    }
    this.schedule();
  }

  private apply(effect: HubEffect, previous: Pick<HubDetectorState, "power" | "since">): void {
    const { bus, store, clock, state } = this.deps;
    const siteId = this.siteId;
    switch (effect.type) {
      case "power":
        store.power.record(siteId, effect, clock.now());
        this.persist(); // a power change must survive a crash right away
        state.update(siteId, { power: effect.state, since: effect.at });
        bus.emit("power.changed", {
          siteId,
          state: effect.state,
          at: effect.at,
          detectedAt: effect.detectedAt,
          reason: effect.reason,
          approximate: effect.approximate,
          previous: previous.power,
          previousSince: previous.since,
        });
        break;
      case "hub-silent":
        bus.emit("hub.silent", {
          siteId,
          deviceId: this.deps.hub.id,
          since: effect.since,
          detectedAt: effect.detectedAt,
        });
        break;
      case "hub-back":
        bus.emit("hub.back", {
          siteId,
          deviceId: this.deps.hub.id,
          silentFrom: effect.silentFrom,
          at: effect.at,
          rebooted: effect.rebooted,
          powerLoss: effect.powerLoss,
        });
        break;
    }
  }

  private schedule(): void {
    const { clock } = this.deps;
    clock.clearTimer(this.wakeTimer);
    this.wakeTimer = null;
    const wake = nextHubWakeAt(this.detector, { silentAlertMs: this.deps.hub.silentAlertMs });
    if (wake === null) return;
    this.wakeTimer = clock.setTimer(wake, () => {
      this.wakeTimer = null;
      this.input({ type: "tick", t: Math.max(wake, clock.now()) });
    });
  }

  private persist(): void {
    const now = this.deps.clock.now();
    this.deps.store.detector.save(this.siteId, persistHubDetector(this.detector), now);
    this.savedAt = now;
  }
}
