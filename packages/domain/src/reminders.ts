import type { ScheduleBehavior } from "./behavior.ts";
import type { ScheduleStatus } from "./schedule-status.ts";
import { addDays } from "./time.ts";
import { collectSlots, type DayRef, mergeWindows, type OutageWindow } from "./windows.ts";
import type { DaySchedule } from "./yasno.ts";

export const REMINDER_LEADS = [10, 20, 30, 60] as const;
export const REMINDER_TRIGGER_WINDOW_MS = 45_000;

export type ReminderEvent = {
  kind: "outage" | "restore";
  leadMinutes: number;
  triggerAt: number;
  start: number;
  end: number;
  durationMinutes: number;
};

/** Days whose slots produce reminders (legacy also included EmergencyShutdowns days). */
const REMINDER_STATUSES = new Set<ScheduleStatus>(["ScheduleApplies", "EmergencyShutdowns"]);

/**
 * Outage windows reminders are built from. Legacy keeps Yasno's per-day slots (so an outage
 * crossing midnight gets a false "restore in N min" before 00:00); with merging (R1) it does not.
 */
export function reminderWindows(
  days: { today: DaySchedule; tomorrow: DaySchedule; yesterday?: DaySchedule | null },
  fallbackToday: string,
  tz: string,
  behavior: ScheduleBehavior,
): OutageWindow[] {
  const refs: DayRef[] = [];
  if (days.yesterday) {
    refs.push({ day: days.yesterday, date: days.yesterday.date ?? addDays(fallbackToday, -1) });
  }
  refs.push({ day: days.today, date: days.today.date ?? fallbackToday });
  // Legacy dated a missing tomorrow with today's date (date.today()); keep that for parity.
  refs.push({ day: days.tomorrow, date: days.tomorrow.date ?? fallbackToday });
  const windows = collectSlots(refs, REMINDER_STATUSES, tz)
    .filter((s) => s.end > s.start)
    .map(({ start, end }) => ({ start, end }));
  return behavior.mergeAdjacentWindows ? mergeWindows(windows) : windows;
}

/** Reminder events that are still due at `now` (legacy _build_reminder_events). */
export function buildReminderEvents(
  windows: readonly OutageWindow[],
  now: number,
  leads: readonly number[] = REMINDER_LEADS,
  toleranceMs: number = REMINDER_TRIGGER_WINDOW_MS,
): ReminderEvent[] {
  const events: ReminderEvent[] = [];
  for (const { start, end } of windows) {
    if (end <= now) continue;
    const durationMinutes = Math.max(1, Math.round(Math.max(0, end - start) / 60_000));
    for (const lead of leads) {
      const triggerOutage = start - lead * 60_000;
      if (triggerOutage + toleranceMs >= now) {
        events.push({
          kind: "outage",
          leadMinutes: lead,
          triggerAt: triggerOutage,
          start,
          end,
          durationMinutes,
        });
      }
      const triggerRestore = end - lead * 60_000;
      if (triggerRestore + toleranceMs >= now) {
        events.push({
          kind: "restore",
          leadMinutes: lead,
          triggerAt: triggerRestore,
          start,
          end,
          durationMinutes,
        });
      }
    }
  }
  return events;
}
