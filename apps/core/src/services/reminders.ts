/**
 * Reminders "outage / restore in N minutes": one exact timer per due reminder, rebuilt whenever the
 * schedule changes. Each reminder is claimed in the DB first, so a restart never repeats it.
 * Like the legacy bot, a reminder that the actual power state makes pointless is skipped.
 */
import {
  buildReminderEvents,
  DEFAULT_BEHAVIOR,
  formatIsoOffset,
  localDate,
  REMINDER_TRIGGER_WINDOW_MS,
  type ReminderEvent,
  reminderWindows,
} from "@svitlo/domain";
import type { Store } from "@svitlo/storage";
import type { Bus } from "../runtime/bus.ts";
import type { Clock, Timer } from "../runtime/clock.ts";
import type { SiteConfig } from "../sites-config.ts";
import type { SiteStateStore } from "./state.ts";

const KEEP_LOG_MS = 2 * 24 * 3_600_000;

export type ReminderServiceDeps = {
  site: SiteConfig;
  store: Store;
  bus: Bus;
  clock: Clock;
  state: SiteStateStore;
};

export function reminderKey(event: ReminderEvent, tz: string): string {
  return `${event.kind}:${formatIsoOffset(event.start, tz)}:${event.leadMinutes}`;
}

export class ReminderService {
  private readonly deps: ReminderServiceDeps;
  private timers: Timer[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(deps: ReminderServiceDeps) {
    this.deps = deps;
  }

  start(): void {
    this.unsubscribe = this.deps.bus.on("schedule.updated", ({ siteId }) => {
      if (siteId === this.deps.site.id) this.reschedule();
    });
    this.reschedule();
  }

  stop(): void {
    this.unsubscribe?.();
    this.clear();
  }

  /** Planned reminders currently waiting for their moment (for tests and diagnostics). */
  pending(): number {
    return this.timers.length;
  }

  reschedule(): void {
    this.clear();
    const { site, clock, state, store } = this.deps;
    const schedule = state.get(site.id).schedule;
    if (!schedule) return;
    const now = clock.now();
    store.reminders.prune(now - KEEP_LOG_MS);
    const windows = reminderWindows(schedule, localDate(now, site.tz), site.tz, DEFAULT_BEHAVIOR);
    for (const event of buildReminderEvents(windows, now)) {
      this.timers.push(clock.setTimer(Math.max(event.triggerAt, now), () => this.fire(event)));
    }
  }

  private fire(event: ReminderEvent): void {
    const { site, clock, state, store, bus } = this.deps;
    const now = clock.now();
    if (now - event.triggerAt > REMINDER_TRIGGER_WINDOW_MS) return; // too late to be useful
    if (!store.reminders.claim(site.id, reminderKey(event, site.tz), now)) return;
    const power = state.get(site.id).power;
    if (
      (event.kind === "outage" && power === "off") ||
      (event.kind === "restore" && power === "on")
    )
      return;
    bus.emit("reminder.due", { siteId: site.id, event, power });
  }

  private clear(): void {
    for (const timer of this.timers) this.deps.clock.clearTimer(timer);
    this.timers = [];
  }
}
