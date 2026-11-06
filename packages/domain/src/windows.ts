import type { GracePolicy } from "./behavior.ts";
import type { ScheduleStatus } from "./schedule-status.ts";
import { addDays, localMidnight, MINUTE } from "./time.ts";
import { type DaySchedule, type TimedSlot, timedOutageSlots } from "./yasno.ts";

/** A planned outage window as instants (possibly several Yasno slots merged). */
export type OutageWindow = { start: number; end: number };

export type DayRef = { day: DaySchedule; date: string };

/**
 * Outage slots of the given days as instants, in Yasno order (today's slots, then tomorrow's).
 * Only days whose status is in `statuses` contribute.
 */
export function collectSlots(
  days: DayRef[],
  statuses: ReadonlySet<ScheduleStatus>,
  tz: string,
): TimedSlot[] {
  const result: TimedSlot[] = [];
  for (const { day, date } of days) {
    if (!statuses.has(day.status)) continue;
    result.push(...timedOutageSlots(day, date, tz));
  }
  return result;
}

/** Sort by start and merge windows that touch or overlap (R1/R2). */
export function mergeWindows(windows: readonly OutageWindow[]): OutageWindow[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged: OutageWindow[] = [];
  for (const w of sorted) {
    const last = merged.at(-1);
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ start: w.start, end: w.end });
    }
  }
  return merged;
}

/**
 * Time range covered by published schedules (ScheduleApplies / NoOutages), used to bound
 * light-on windows that run past the known data.
 */
export function knownRange(days: DayRef[], tz: string): { start: number; end: number } | null {
  const published = days.filter(
    ({ day }) => day.status === "ScheduleApplies" || day.status === "NoOutages",
  );
  if (published.length === 0) return null;
  const dates = published.map((d) => d.date).sort();
  const first = dates[0] as string;
  const last = dates.at(-1) as string;
  return { start: localMidnight(first, tz), end: localMidnight(addDays(last, 1), tz) };
}

export type WindowGrace = {
  /** How long before the start a power loss still counts as this window. */
  early: number;
  /** Legacy-only branch, null when not used. */
  futureSoon: number | null;
  /** How long after the start "мало відбутися" is shown while power is still on. */
  missed: number;
  /** How long after the end "мало відновитися" is shown while power is still off. */
  restore: number;
};

/**
 * Tolerances for one window. Proportional mode (R14) uses the neighbouring light-on windows:
 * the gap to the previous/next outage window, or the known part of it up to the edge of the
 * known schedule; when that is zero or unknown, the outage window's own length.
 */
export function windowGrace(
  window: OutageWindow,
  allWindows: readonly OutageWindow[],
  range: { start: number; end: number } | null,
  policy: GracePolicy,
): WindowGrace {
  if (policy.kind === "fixed") {
    return {
      early: policy.earlyStartMin * MINUTE,
      futureSoon: policy.futureSoonMin * MINUTE,
      missed: policy.missedStartMin * MINUTE,
      restore: policy.restoreDelayMin * MINUTE,
    };
  }
  const duration = window.end - window.start;
  const before = lightOnBefore(window, allWindows, range) ?? duration;
  const after = lightOnAfter(window, allWindows, range) ?? duration;
  const clamp = (value: number) =>
    Math.min(policy.maxMinutes * MINUTE, Math.max(policy.minMinutes * MINUTE, value));
  return {
    early: clamp(policy.earlyStartRatio * before),
    futureSoon: null,
    missed: clamp(policy.missedStartRatio * duration),
    restore: clamp(policy.restoreDelayRatio * after),
  };
}

function lightOnBefore(
  window: OutageWindow,
  all: readonly OutageWindow[],
  range: { start: number; end: number } | null,
): number | null {
  let previousEnd: number | null = null;
  for (const w of all) {
    if (w.end <= window.start && (previousEnd === null || w.end > previousEnd)) previousEnd = w.end;
  }
  if (previousEnd !== null) return window.start - previousEnd;
  if (range && window.start > range.start) return window.start - range.start;
  return null;
}

function lightOnAfter(
  window: OutageWindow,
  all: readonly OutageWindow[],
  range: { start: number; end: number } | null,
): number | null {
  let nextStart: number | null = null;
  for (const w of all) {
    if (w.start >= window.end && (nextStart === null || w.start < nextStart)) nextStart = w.start;
  }
  if (nextStart !== null) return nextStart - window.end;
  if (range && range.end > window.end) return range.end - window.end;
  return null;
}
