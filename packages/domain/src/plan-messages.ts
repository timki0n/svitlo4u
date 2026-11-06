/**
 * "When will power come back" / "when is the next outage" — the plan hints shown with every
 * power event and in /status. One implementation; ScheduleBehavior switches between the legacy
 * semantics (golden parity) and the corrected ones (REVIEW.md R1/R2/R3/R14).
 */
import type { ScheduleBehavior } from "./behavior.ts";
import { isPublishedSchedule, type ScheduleStatus } from "./schedule-status.ts";
import {
  emergencyText,
  missedStartText,
  missingScheduleText,
  NO_OUTAGES_TODAY_TEXT,
  nextOutageText,
  OFF_SCHEDULE_TEXT,
  restoreExpectedText,
  restoreOverdueText,
  type TextContext,
  windowInProgressText,
} from "./texts.ts";
import { addDays, localDate } from "./time.ts";
import {
  collectSlots,
  type DayRef,
  knownRange,
  mergeWindows,
  type OutageWindow,
  type WindowGrace,
  windowGrace,
} from "./windows.ts";
import { type DaySchedule, timedOutageSlots } from "./yasno.ts";

export type PlanContext = TextContext & {
  behavior: ScheduleBehavior;
  today: DaySchedule;
  tomorrow: DaySchedule;
  /** Production: yesterday's schedule from history, so windows crossing midnight are whole. */
  yesterday?: DaySchedule | null;
};

const APPLIES = new Set<ScheduleStatus>(["ScheduleApplies"]);

type Plan = {
  refs: DayRef[];
  windows: OutageWindow[];
  grace: (w: OutageWindow) => WindowGrace;
};

function buildPlan(ctx: PlanContext, nowDate: string): Plan {
  const refs: DayRef[] = [];
  if (ctx.yesterday)
    refs.push({ day: ctx.yesterday, date: ctx.yesterday.date ?? addDays(nowDate, -1) });
  refs.push({ day: ctx.today, date: ctx.today.date ?? nowDate });
  refs.push({ day: ctx.tomorrow, date: ctx.tomorrow.date ?? addDays(nowDate, 1) });

  const slots = collectSlots(refs, APPLIES, ctx.tz).map(({ start, end }) => ({ start, end }));
  const windows = ctx.behavior.mergeAdjacentWindows ? mergeWindows(slots) : slots;
  const range = knownRange(refs, ctx.tz);
  const cache = new Map<OutageWindow, WindowGrace>();
  const grace = (w: OutageWindow) => {
    let value = cache.get(w);
    if (!value) {
      value = windowGrace(w, windows, range, ctx.behavior.grace);
      cache.set(w, value);
    }
    return value;
  };
  return { refs, windows, grace };
}

/** Planned windows around `now` (yesterday…tomorrow) exactly as the plan texts see them. */
export function planWindows(ctx: PlanContext, now: number): OutageWindow[] {
  return buildPlan(ctx, localDate(now, ctx.tz)).windows;
}

/** Shown when power goes off (and in /status while it is off). */
export function nearestRestoreMessage(ctx: PlanContext, now: number): string {
  if (ctx.today.status === "EmergencyShutdowns") return emergencyText(ctx);
  // NoOutages today: any outage now is off-schedule (R7 kept as legacy).
  if (ctx.today.status === "NoOutages") return OFF_SCHEDULE_TEXT;

  const { windows, grace } = buildPlan(ctx, localDate(now, ctx.tz));
  const upcoming = windows.filter((w) => w.end > now).sort((a, b) => a.start - b.start);
  const past = windows.filter((w) => w.end <= now);

  if (upcoming.length === 0 && past.length === 0) {
    return ctx.today.status === "ScheduleApplies"
      ? OFF_SCHEDULE_TEXT
      : missingScheduleText(ctx, ctx.today.status, ctx.tomorrow.status);
  }

  // Inside a window, or lost power shortly before it → that window's end.
  const ongoing = upcoming.findIndex((w) => w.start - grace(w).early <= now && now <= w.end);
  if (ongoing >= 0) {
    let end = (upcoming[ongoing] as OutageWindow).end;
    for (let i = ongoing + 1; i < upcoming.length; i++) {
      const next = upcoming[i] as OutageWindow;
      if (next.start > end) break;
      end = Math.max(end, next.end);
    }
    return restoreExpectedText(ctx, end);
  }

  // Legacy-only branch: the next window starts "soon" → its end (without merging, R2).
  const nextFuture = upcoming.find((w) => w.start > now);
  if (nextFuture) {
    const soon = grace(nextFuture).futureSoon;
    if (soon !== null && nextFuture.start - now <= soon)
      return restoreExpectedText(ctx, nextFuture.end);
  }

  if (past.length > 0) {
    const latest = past.reduce((a, b) => (b.end > a.end ? b : a));
    if (now - latest.end <= grace(latest).restore) return restoreOverdueText(ctx, latest.end);
  }
  return OFF_SCHEDULE_TEXT;
}

/** Shown when power comes back (and in /status while it is on). */
export function nearestOutageMessage(ctx: PlanContext, now: number): string {
  if (ctx.today.status === "EmergencyShutdowns") return emergencyText(ctx);
  if (!isPublishedSchedule(ctx.today.status) && ctx.tomorrow.status !== "ScheduleApplies") {
    return missingScheduleText(ctx, ctx.today.status, ctx.tomorrow.status);
  }

  const nowDate = localDate(now, ctx.tz);
  const { windows, grace } = buildPlan(ctx, nowDate);

  if (ctx.behavior.inWindowAwareness) {
    // R3: power is on during a planned window — talk about this window.
    const current = windows.find((w) => w.start <= now && now < w.end);
    if (current) {
      return now - current.start <= grace(current).missed
        ? missedStartText(ctx, current.start)
        : windowInProgressText(ctx, current.start, current.end);
    }
  }

  const next = windows.filter((w) => w.start > now).sort((a, b) => a.start - b.start)[0];
  if (next) {
    return nextOutageText(ctx, next.start, localDate(next.start, ctx.tz) === addDays(nowDate, 1));
  }

  if (!ctx.behavior.inWindowAwareness) {
    const latest = windows.filter((w) => w.start <= now).sort((a, b) => b.start - a.start)[0];
    if (latest && now - latest.start <= grace(latest).missed)
      return missedStartText(ctx, latest.start);
  }
  return NO_OUTAGES_TODAY_TEXT;
}

/** Legacy get_nearest_outage: start of the ongoing or next outage slot (not used for texts). */
export function nearestOutageStart(ctx: PlanContext, now: number): number | null {
  const nowDate = localDate(now, ctx.tz);
  const candidates: number[] = [];
  if (ctx.today.status === "ScheduleApplies") {
    for (const slot of timedOutageSlots(ctx.today, ctx.today.date ?? nowDate, ctx.tz)) {
      if (slot.end <= now) continue;
      if (slot.start > now) candidates.push(slot.start);
      else return slot.start;
    }
  }
  if (ctx.tomorrow.status === "ScheduleApplies") {
    for (const slot of timedOutageSlots(
      ctx.tomorrow,
      ctx.tomorrow.date ?? addDays(nowDate, 1),
      ctx.tz,
    )) {
      if (slot.start > now) candidates.push(slot.start);
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}
