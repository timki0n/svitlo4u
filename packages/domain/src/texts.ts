/**
 * User-facing Ukrainian texts. Strings match the legacy bot byte-for-byte (golden tests),
 * except where REVIEW.md records a deliberate change.
 */
import type { ScheduleStatus } from "./schedule-status.ts";
import { formatHHMM, pad2, toZoned } from "./time.ts";
import { type DayInfo, type DaySchedule, type TimedSlot, timedOutageSlots } from "./yasno.ts";

export type TextContext = { tz: string; linkUrl: string };

export function scheduleLink(ctx: TextContext, label: string): string {
  return `<a href="${ctx.linkUrl}">${label}</a>`;
}

export const OFF_SCHEDULE_TEXT = "⚠️ Відключення поза графіком/можливо аварійні.";
export const NO_OUTAGES_TODAY_TEXT = "💡 Сьогодні відключень не передбачено";

export function emergencyText(ctx: TextContext): string {
  return `🚨 Діють екстрені відключення. ${scheduleLink(ctx, "Графік")} не діє.`;
}

export function missingScheduleText(
  ctx: TextContext,
  today: ScheduleStatus,
  tomorrow: ScheduleStatus,
): string {
  if (today === "WaitingForSchedule" || tomorrow === "WaitingForSchedule") {
    return `⌛ ${scheduleLink(ctx, "Графік")} ще не опубліковано`;
  }
  return `⚠️ ${scheduleLink(ctx, "Графік")} недоступний.`;
}

export function restoreExpectedText(ctx: TextContext, at: number): string {
  return `За ${scheduleLink(ctx, "графіком")} світло має відновитися о ${formatHHMM(at, ctx.tz)}.`;
}

export function restoreOverdueText(ctx: TextContext, at: number): string {
  return `За ${scheduleLink(ctx, "графіком")} світло мало відновитися о ${formatHHMM(at, ctx.tz)}.`;
}

export function nextOutageText(ctx: TextContext, start: number, isTomorrow: boolean): string {
  const time = formatHHMM(start, ctx.tz);
  return isTomorrow ? `Найближче відключення завтра о ${time}` : `Найближче відключення о ${time}`;
}

export function missedStartText(ctx: TextContext, start: number): string {
  return `Відключення мало відбутися о ${formatHHMM(start, ctx.tz)}, очікуйте`;
}

/** R3: power is on while a planned window is still running. */
export function windowInProgressText(ctx: TextContext, start: number, end: number): string {
  return (
    `За ${scheduleLink(ctx, "графіком")} відключення ${formatHHMM(start, ctx.tz)}–${formatHHMM(end, ctx.tz)} ` +
    "ще триває, світло може зникнути."
  );
}

/**
 * R15: the last schedule with outages published for a day (or, failing that, for an earlier day),
 * shown under "emergency shutdowns" instead of nothing. Outages are placed on the shown day.
 */
export type LastFixedSchedule = {
  /** Day the schedule was published for. */
  date: string;
  outages: TimedSlot[];
};

export function lastFixedOn(
  fixed: { date: string; day: DaySchedule },
  date: string,
  tz: string,
): LastFixedSchedule {
  return { date: fixed.date, outages: timedOutageSlots(fixed.day, date, tz) };
}

function outageLines(ctx: TextContext, outages: readonly TimedSlot[]): string[] {
  return outages.map(
    (outage, index) =>
      `${index + 1}. ${formatHHMM(outage.start, ctx.tz)} – ${formatHHMM(outage.end, ctx.tz)} ` +
      `(${formatDuration(outage.start, outage.end)})`,
  );
}

/**
 * /today, /tomorrow and schedule-change body (legacy build_today_message). With `lastFixed`
 * (R15), an emergency day also lists the last fixed schedule underneath.
 */
export function formatDayMessage(
  ctx: TextContext,
  info: DayInfo,
  lastFixed: LastFixedSchedule | null = null,
): string {
  const [y, m, d] = info.date.split("-");
  const header = `📅 Розклад на ${d}.${m}.${y}`;
  if (info.status === "EmergencyShutdowns") {
    const emergency = `${header}\n🚨 ${scheduleLink(ctx, "Графік")} не діє. Діють екстрені відключення.`;
    if (!lastFixed || lastFixed.outages.length === 0) return emergency;
    const [, fm, fd] = lastFixed.date.split("-");
    const title =
      lastFixed.date === info.date
        ? "Останній фіксований графік:"
        : `Останній фіксований графік (на ${fd}.${fm}):`;
    return [emergency, "", title, ...outageLines(ctx, lastFixed.outages)].join("\n");
  }
  if (info.status === "WaitingForSchedule") {
    return `${header}\n⌛ Очікуємо оновлення`;
  }
  if (
    info.status === "NoOutages" ||
    (info.status === "ScheduleApplies" && info.outages.length === 0)
  ) {
    return `${header}\n✅ Відключень не передбачено`;
  }
  if (info.status !== "ScheduleApplies") {
    return `${header}\n⚠️ ${scheduleLink(ctx, "Графік")} недоступний.`;
  }
  return [header, "", ...outageLines(ctx, info.outages)].join("\n");
}

const UK_MONTHS_SHORT = [
  "січ.",
  "лют.",
  "бер.",
  "квіт.",
  "трав.",
  "черв.",
  "лип.",
  "серп.",
  "вер.",
  "жовт.",
  "лист.",
  "груд.",
] as const;

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** "Останнє оновлення: 12:55 06 жовт. 2026" from Yasno updatedOn, or null. */
export function formatLastScheduleUpdate(
  ctx: TextContext,
  updatedOn: string | null,
): string | null {
  if (!updatedOn || !ISO_WITH_OFFSET.test(updatedOn)) return null;
  const ms = Date.parse(updatedOn);
  if (Number.isNaN(ms)) return null;
  const z = toZoned(ms, ctx.tz);
  return `Останнє оновлення: ${pad2(z.hour)}:${pad2(z.minute)} ${pad2(z.day)} ${UK_MONTHS_SHORT[z.month - 1]} ${z.year}`;
}

export function withLastScheduleUpdate(
  ctx: TextContext,
  message: string,
  updatedOn: string | null,
): string {
  const line = formatLastScheduleUpdate(ctx, updatedOn);
  return line ? `${message}\n\n${line}` : message;
}

/** Outage length in a day list: "3 год." / "1 год. 30 хв." (legacy, R9 kept). */
export function formatDuration(start: number, end: number): string {
  const totalMinutes = Math.trunc((end - start) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} год.` : `${hours} год. ${minutes} хв.`;
}

/** Elapsed time with days: "1 день 2 год. 5 хв." (legacy fmt_duration_long, R9 kept). */
export function formatDurationLong(seconds: number): string {
  const total = Math.trunc(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const parts: string[] = [];
  if (days === 1) parts.push("1 день");
  else if (days >= 2 && days <= 4) parts.push(`${days} дні`);
  else if (days >= 5) parts.push(`${days} днів`);
  if (hours === 1) parts.push("1 год.");
  else if (hours >= 2) parts.push(`${hours} год.`);
  if (minutes === 1) parts.push("1 хв.");
  else if (minutes >= 2) parts.push(`${minutes} хв.`);
  return parts.length === 0 ? "менше хвилини" : parts.join(" ");
}

export function formatLeadLabel(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours > 1 ? `${hours} год` : "1 год";
  }
  return `${minutes} хв`;
}
