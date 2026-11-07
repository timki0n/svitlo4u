/**
 * Schedule change detection for today and tomorrow (legacy schedule_monitor loops as pure
 * reducers). The caller keeps the returned state (persisted in DB) and sends the notification.
 */
import type { TomorrowMonitorMode } from "./behavior.ts";
import { isPublishedSchedule, type ScheduleStatus } from "./schedule-status.ts";
import { formatDayMessage, scheduleLink, type TextContext } from "./texts.ts";
import {
  type DayInfo,
  type DaySchedule,
  dayInfo,
  isScheduleWithoutOutages,
  type TimedSlot,
} from "./yasno.ts";

export type TrackedDay = {
  date: string;
  status: ScheduleStatus;
  rawStatus: string;
  /** Raw status + every slot (incl. NotPlanned): any difference is a change. */
  signature: string;
  withoutOutages: boolean;
  /** Tomorrow: the last published schedule seen for this date (to tell news from a comeback). */
  published?: PublishedRef | null;
};

type PublishedRef = { signature: string; withoutOutages: boolean };

export type ScheduleNotificationKind = "today_updated" | "tomorrow_published" | "tomorrow_changed";

export type ScheduleNotification = {
  kind: ScheduleNotificationKind;
  /** HTML for Telegram. */
  telegramText: string;
  web: { type: "schedule_updated"; category: "schedule_change"; title: string; body: string };
};

export type PollResult = {
  state: TrackedDay;
  /** The stored schedule must be updated. */
  persist: boolean;
  notification: ScheduleNotification | null;
};

/** Identity of a day's schedule: raw status + every slot (incl. NotPlanned). Stored with snapshots. */
export function daySignature(day: Pick<DaySchedule, "rawStatus" | "slots">): string {
  return JSON.stringify([day.rawStatus, day.slots.map((s) => [s.start, s.end, s.type])]);
}

function track(day: DaySchedule, date: string): TrackedDay {
  return {
    date,
    status: day.status,
    rawStatus: day.rawStatus,
    signature: daySignature(day),
    withoutOutages: isScheduleWithoutOutages(day),
  };
}

function notification(
  kind: ScheduleNotificationKind,
  telegramHeadline: string,
  webTitle: string,
  body: string,
): ScheduleNotification {
  return {
    kind,
    telegramText: `${telegramHeadline}\n\n${body}`,
    web: { type: "schedule_updated", category: "schedule_change", title: webTitle, body },
  };
}

/** R15: outages of the schedule published for a date before emergency shutdowns; absent → legacy texts. */
export type MonitorTextContext = TextContext & {
  lastFixed?: (date: string) => TimedSlot[] | null;
  /** The latest stored published version of a date (after a restart: was tomorrow out already?). */
  lastPublished?: (date: string) => DaySchedule | null;
  /** The latest stored version of a date, any status (at midnight: how today looked as tomorrow). */
  lastKnown?: (date: string) => DaySchedule | null;
};

function publishedRef(day: DaySchedule | null | undefined): PublishedRef | null {
  if (!day || !isPublishedSchedule(day.status)) return null;
  return { signature: daySignature(day), withoutOutages: isScheduleWithoutOutages(day) };
}

function dayBody(ctx: MonitorTextContext, info: DayInfo): string {
  const lastFixed =
    info.status === "EmergencyShutdowns" ? (ctx.lastFixed?.(info.date) ?? null) : null;
  return formatDayMessage(ctx, info, lastFixed);
}

/**
 * One poll of today's schedule. The first poll only sets the baseline. At midnight the new day is
 * compared with its last version seen as tomorrow: only a real change is news (the provider may
 * change the day right at 00:00), and with no such version the rollover only sets the baseline.
 */
export function pollToday(
  ctx: MonitorTextContext,
  previous: TrackedDay | null,
  day: DaySchedule,
  fallbackDate: string,
): PollResult {
  const info = dayInfo(day, fallbackDate, ctx.tz);
  const next = track(day, info.date);
  if (!previous) return { state: next, persist: true, notification: null };
  const rollover = previous.date !== next.date;
  const known = rollover ? ctx.lastKnown?.(next.date) : null;
  const before = rollover ? (known ? track(known, next.date) : null) : previous;
  if (!before) return { state: next, persist: true, notification: null };
  if (before.signature === next.signature)
    return rollover
      ? { state: next, persist: true, notification: null }
      : { state: previous, persist: false, notification: null };
  if (before.withoutOutages && next.withoutOutages) {
    return { state: next, persist: true, notification: null };
  }
  return {
    state: next,
    persist: true,
    notification: notification(
      "today_updated",
      `🔔 ${scheduleLink(ctx, "Графік на сьогодні")} оновлено!`,
      "🔔 Графік на сьогодні оновлено!",
      dayBody(ctx, info),
    ),
  };
}

/**
 * One poll of tomorrow's schedule. Mode "published-only" is legacy; "all-changes" (R8) announces a
 * schedule that appeared and one that really changed against the last published version —
 * never emergency shutdowns (only today's are news, as a change of today) nor a withdrawn
 * schedule coming back unchanged.
 */
export function pollTomorrow(
  ctx: MonitorTextContext & { mode: TomorrowMonitorMode },
  previous: TrackedDay | null,
  day: DaySchedule,
  fallbackDate: string,
): PollResult {
  const info = dayInfo(day, fallbackDate, ctx.tz);
  const tracked = track(day, info.date);
  const body = () => dayBody(ctx, info);
  const published = () =>
    notification(
      "tomorrow_published",
      `🔔 З'явився ${scheduleLink(ctx, "графік на завтра")}!`,
      "🔔 З'явився графік на завтра!",
      body(),
    );
  const changed = () =>
    notification(
      "tomorrow_changed",
      `🔔 ${scheduleLink(ctx, "Графік на завтра")} змінено!`,
      "🔔 Графік на завтра змінено!",
      body(),
    );
  const sameDate = previous !== null && previous.date === tracked.date;
  // The last published version before this poll: carried along, or from the DB for a new date.
  const before = sameDate
    ? (previous.published ?? null)
    : publishedRef(ctx.lastPublished?.(tracked.date));
  const next: TrackedDay = { ...tracked, published: publishedRef(day) ?? before };

  if (!previous) return { state: next, persist: true, notification: null };

  if (!sameDate) {
    // Midnight: a new "tomorrow". Legacy never announced it, even when already published.
    const result =
      ctx.mode === "all-changes" && isPublishedSchedule(next.status) && before === null
        ? published()
        : null;
    return { state: next, persist: true, notification: result };
  }

  if (previous.signature === next.signature)
    return {
      state: { ...previous, published: next.published },
      persist: false,
      notification: null,
    };

  if (ctx.mode === "published-only") {
    const appeared = previous.status === "WaitingForSchedule" && isPublishedSchedule(next.status);
    return { state: next, persist: true, notification: appeared ? published() : null };
  }

  let result: ScheduleNotification | null = null;
  if (isPublishedSchedule(next.status)) {
    if (before === null) result = published();
    else if (before.signature !== next.signature && !(before.withoutOutages && next.withoutOutages))
      result = changed();
  }
  return { state: next, persist: true, notification: result };
}
