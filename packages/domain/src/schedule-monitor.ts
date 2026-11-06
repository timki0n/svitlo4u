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
};

export type ScheduleNotificationKind =
  | "today_updated"
  | "tomorrow_published"
  | "tomorrow_changed"
  | "tomorrow_emergency";

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
};

function dayBody(ctx: MonitorTextContext, info: DayInfo): string {
  const lastFixed =
    info.status === "EmergencyShutdowns" ? (ctx.lastFixed?.(info.date) ?? null) : null;
  return formatDayMessage(ctx, info, lastFixed);
}

/** One poll of today's schedule. Midnight rollover and the first poll only set the baseline. */
export function pollToday(
  ctx: MonitorTextContext,
  previous: TrackedDay | null,
  day: DaySchedule,
  fallbackDate: string,
): PollResult {
  const info = dayInfo(day, fallbackDate, ctx.tz);
  const next = track(day, info.date);
  if (!previous || previous.date !== next.date)
    return { state: next, persist: true, notification: null };
  if (previous.signature === next.signature)
    return { state: previous, persist: false, notification: null };
  if (previous.withoutOutages && next.withoutOutages) {
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

/** One poll of tomorrow's schedule. Mode "published-only" is legacy, "all-changes" is R8. */
export function pollTomorrow(
  ctx: MonitorTextContext & { mode: TomorrowMonitorMode },
  previous: TrackedDay | null,
  day: DaySchedule,
  fallbackDate: string,
): PollResult {
  const info = dayInfo(day, fallbackDate, ctx.tz);
  const next = track(day, info.date);
  const body = () => dayBody(ctx, info);
  const published = () =>
    notification(
      "tomorrow_published",
      `🔔 З'явився ${scheduleLink(ctx, "графік на завтра")}!`,
      "🔔 З'явився графік на завтра!",
      body(),
    );
  const emergency = () =>
    notification(
      "tomorrow_emergency",
      "🔔 На завтра оголошено екстрені відключення!",
      "🔔 На завтра оголошено екстрені відключення!",
      body(),
    );

  if (!previous) return { state: next, persist: true, notification: null };

  if (previous.date !== next.date) {
    // Midnight: a new "tomorrow". Legacy never announced it, even when already published.
    let result: ScheduleNotification | null = null;
    if (ctx.mode === "all-changes") {
      if (next.status === "EmergencyShutdowns") result = emergency();
      else if (isPublishedSchedule(next.status)) result = published();
    }
    return { state: next, persist: true, notification: result };
  }

  if (previous.signature === next.signature)
    return { state: previous, persist: false, notification: null };

  if (ctx.mode === "published-only") {
    const appeared = previous.status === "WaitingForSchedule" && isPublishedSchedule(next.status);
    return { state: next, persist: true, notification: appeared ? published() : null };
  }

  let result: ScheduleNotification | null = null;
  if (next.status === "EmergencyShutdowns" && previous.status !== "EmergencyShutdowns") {
    result = emergency();
  } else if (!isPublishedSchedule(previous.status) && isPublishedSchedule(next.status)) {
    result = published();
  } else if (
    isPublishedSchedule(previous.status) &&
    isPublishedSchedule(next.status) &&
    !(previous.withoutOutages && next.withoutOutages)
  ) {
    result = notification(
      "tomorrow_changed",
      `🔔 ${scheduleLink(ctx, "Графік на завтра")} змінено!`,
      "🔔 Графік на завтра змінено!",
      body(),
    );
  }
  return { state: next, persist: true, notification: result };
}
