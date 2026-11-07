/** R15: an emergency day keeps showing the schedule published for it before the emergency. */
import { describe, expect, it } from "vitest";
import {
  type DaySchedule,
  dayInfo,
  formatDayMessage,
  KYIV_TZ,
  parseDay,
  pollToday,
  pollTomorrow,
  timedOutageSlots,
} from "../src/index.ts";

const text = { tz: KYIV_TZ, linkUrl: "https://svitlo4u.info" };
const link = '<a href="https://svitlo4u.info">Графік</a>';
const EMERGENCY = `🚨 ${link} не діє. Діють екстрені відключення.`;

const day = (date: string, status: string, slots: [number, number][] = []): DaySchedule => ({
  ...parseDay({
    date: `${date}T00:00:00+02:00`,
    status,
    slots: slots.map(([start, end]) => ({ start, end, type: "Definite" })),
  }),
  date,
});
const published07 = day("2026-11-07", "ScheduleApplies", [
  [480, 720],
  [1200, 1440],
]);
const emergency = (date: string) => dayInfo(day(date, "EmergencyShutdowns"), date, KYIV_TZ);

describe("emergency day over its own published schedule", () => {
  it("a day that never had a schedule shows the emergency only (legacy text)", () => {
    expect(formatDayMessage(text, emergency("2026-11-07"))).toBe(
      `📅 Розклад на 07.11.2026\n${EMERGENCY}`,
    );
    expect(formatDayMessage(text, emergency("2026-11-07"), [])).toBe(
      `📅 Розклад на 07.11.2026\n${EMERGENCY}`,
    );
  });

  it("lists the schedule that was published for the day under the emergency notice", () => {
    const fixed = timedOutageSlots(published07, "2026-11-07", KYIV_TZ);
    expect(formatDayMessage(text, emergency("2026-11-07"), fixed)).toBe(
      [
        `📅 Розклад на 07.11.2026\n${EMERGENCY}`,
        "",
        "Останній згаданий графік:",
        "1. 08:00 – 12:00 (4 год.)",
        "2. 20:00 – 00:00 (4 год.)",
      ].join("\n"),
    );
  });

  it("emergency is news of the day itself only, as a change of today with that schedule", () => {
    const ctx = {
      ...text,
      lastFixed: (date: string) =>
        date === "2026-11-07" ? timedOutageSlots(published07, date, KYIV_TZ) : null,
    };
    // Announced for tomorrow: nothing.
    const tomorrow = pollTomorrow(
      { ...ctx, mode: "all-changes" },
      pollTomorrow({ ...ctx, mode: "all-changes" }, null, published07, "2026-11-07").state,
      day("2026-11-07", "EmergencyShutdowns"),
      "2026-11-07",
    );
    expect(tomorrow.notification).toBeNull();

    // Midnight with no stored version of the day: only the baseline, nothing to compare.
    const yesterday = pollToday(ctx, null, day("2026-11-06", "ScheduleApplies"), "2026-11-06");
    const midnight = pollToday(
      ctx,
      yesterday.state,
      day("2026-11-07", "EmergencyShutdowns"),
      "2026-11-07",
    );
    expect(midnight.notification).toBeNull();

    // Declared during the day: a change of today, with the schedule they replaced.
    const morning = pollToday(
      ctx,
      pollToday(ctx, null, published07, "2026-11-07").state,
      day("2026-11-07", "EmergencyShutdowns"),
      "2026-11-07",
    );
    expect(morning.notification?.kind).toBe("today_updated");
    expect(morning.notification?.telegramText).toContain(
      `📅 Розклад на 07.11.2026\n${EMERGENCY}\n\nОстанній згаданий графік:\n1. 08:00 – 12:00 (4 год.)`,
    );
  });
});
