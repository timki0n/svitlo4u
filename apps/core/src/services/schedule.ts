/**
 * Schedules: every Yasno update is stored as a new version when it changed, run through the
 * today/tomorrow monitors and published on the bus. After a restart the monitors start from the
 * last stored version, so a change made while the core was down is still announced.
 */
import {
  addDays,
  type DaySchedule,
  DEFAULT_BEHAVIOR,
  type GroupSchedule,
  localDate,
  pollToday,
  pollTomorrow,
  type TimedSlot,
  type TrackedDay,
  timedOutageSlots,
} from "@svitlo/domain";
import type { Store } from "@svitlo/storage";
import type { YasnoUpdate } from "../adapters/yasno.ts";
import type { Bus } from "../runtime/bus.ts";
import type { Clock } from "../runtime/clock.ts";
import type { SiteConfig } from "../sites-config.ts";
import type { SiteStateStore } from "./state.ts";

/**
 * R15: the schedule published for `date` before emergency shutdowns replaced it — shown under
 * the emergency state and kept in plan-vs-fact. Null when that day never had one.
 */
export function lastFixedSchedule(
  store: Store,
  site: Pick<SiteConfig, "id" | "tz">,
  date: string,
): { publishedAt: number; outages: TimedSlot[] } | null {
  const fixed = store.schedules.lastFixed(site.id, date);
  if (!fixed) return null;
  const outages = timedOutageSlots(fixed.day, date, site.tz);
  return outages.length > 0 ? { publishedAt: fixed.fetchedAt, outages } : null;
}

export type ScheduleServiceDeps = {
  sites: readonly SiteConfig[];
  store: Store;
  bus: Bus;
  clock: Clock;
  state: SiteStateStore;
};

export class ScheduleService {
  private readonly deps: ScheduleServiceDeps;
  private readonly trackers = new Map<
    string,
    { today: TrackedDay | null; tomorrow: TrackedDay | null; ready: boolean }
  >();

  constructor(deps: ScheduleServiceDeps) {
    this.deps = deps;
  }

  /** Load the latest stored schedules so state and texts are available before Yasno answers. */
  hydrate(): void {
    for (const site of this.deps.sites) {
      const today = localDate(this.deps.clock.now(), site.tz);
      const stored = this.stored(site.id, today);
      const next = this.stored(site.id, addDays(today, 1));
      if (!stored) continue;
      this.setState(site, stored, next ?? waiting(addDays(today, 1)), null, null, today);
    }
  }

  onYasnoUpdate(update: YasnoUpdate): void {
    for (const site of this.deps.sites) {
      const group = update.groups[site.yasno.group];
      if (group) this.apply(site, group, update.fetchedAt);
    }
  }

  private apply(site: SiteConfig, group: GroupSchedule, fetchedAt: number): void {
    const { store, bus, clock } = this.deps;
    const nowDate = localDate(clock.now(), site.tz);
    const todayDate = group.today.date ?? nowDate;
    const tomorrowDate = group.tomorrow.date ?? addDays(nowDate, 1);
    const text = {
      tz: site.tz,
      linkUrl: site.linkUrl,
      lastFixed: (date: string) => lastFixedSchedule(store, site, date)?.outages ?? null,
    };

    // Baselines come from the DB before this update is stored.
    let tracker = this.trackers.get(site.id);
    if (!tracker) {
      tracker = { today: null, tomorrow: null, ready: false };
      this.trackers.set(site.id, tracker);
    }
    if (!tracker.ready) {
      const storedToday = this.stored(site.id, todayDate);
      const storedTomorrow = this.stored(site.id, tomorrowDate);
      tracker.today = storedToday ? pollToday(text, null, storedToday, todayDate).state : null;
      tracker.tomorrow = storedTomorrow
        ? pollTomorrow(
            { ...text, mode: DEFAULT_BEHAVIOR.tomorrowMonitor },
            null,
            storedTomorrow,
            tomorrowDate,
          ).state
        : null;
      tracker.ready = true;
    }

    const today = pollToday(text, tracker.today, group.today, nowDate);
    const tomorrow = pollTomorrow(
      { ...text, mode: DEFAULT_BEHAVIOR.tomorrowMonitor },
      tracker.tomorrow,
      group.tomorrow,
      nowDate,
    );
    tracker.today = today.state;
    tracker.tomorrow = tomorrow.state;

    const options = { updatedOn: group.updatedOn, source: "poller" as const };
    store.schedules.saveIfChanged(
      site.id,
      todayDate,
      { ...group.today, date: todayDate },
      fetchedAt,
      options,
    );
    store.schedules.saveIfChanged(
      site.id,
      tomorrowDate,
      { ...group.tomorrow, date: tomorrowDate },
      fetchedAt,
      options,
    );

    this.setState(site, group.today, group.tomorrow, group.updatedOn, fetchedAt, todayDate);
    for (const result of [today, tomorrow]) {
      if (result.notification)
        bus.emit("schedule.notification", { siteId: site.id, notification: result.notification });
    }
    bus.emit("schedule.updated", { siteId: site.id });
  }

  private setState(
    site: SiteConfig,
    today: DaySchedule,
    tomorrow: DaySchedule,
    updatedOn: string | null,
    fetchedAt: number | null,
    todayDate: string,
  ): void {
    const yesterday = this.stored(site.id, addDays(todayDate, -1));
    this.deps.state.update(site.id, {
      schedule: { today, tomorrow, yesterday, updatedOn, fetchedAt },
    });
  }

  private stored(siteId: string, date: string): DaySchedule | null {
    return this.deps.store.schedules.finalDays(siteId, date, date)[0]?.day ?? null;
  }
}

function waiting(date: string): DaySchedule {
  return { date, status: "WaitingForSchedule", rawStatus: "WaitingForSchedule", slots: [] };
}
