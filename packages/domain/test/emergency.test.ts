/** R15: emergency shutdowns are shown over the last fixed schedule instead of an empty day. */
import { describe, expect, it } from "vitest";
import {
  type DaySchedule,
  dayInfo,
  formatDayMessage,
  KYIV_TZ,
  lastFixedOn,
  parseDay,
  pollTomorrow,
} from "../src/index.ts";

const text = { tz: KYIV_TZ, linkUrl: "https://svitlo4u.info" };
const link = '<a href="https://svitlo4u.info">Графік</a>';

const day = (date: string, status: string, slots: [number, number][] = []): DaySchedule => ({
  ...parseDay({
    date: `${date}T00:00:00+02:00`,
    status,
    slots: slots.map(([start, end]) => ({ start, end, type: "Definite" })),
  }),
  date,
});
const fixed05 = {
  date: "2026-11-05",
  day: day("2026-11-05", "ScheduleApplies", [
    [480, 720],
    [1200, 1440],
  ]),
};
const emergency = (date: string) => dayInfo(day(date, "EmergencyShutdowns"), date, KYIV_TZ);

describe("emergency day with the last fixed schedule", () => {
  it("without history the legacy text stays as it was", () => {
    expect(formatDayMessage(text, emergency("2026-11-06"))).toBe(
      `📅 Розклад на 06.11.2026\n🚨 ${link} не діє. Діють екстрені відключення.`,
    );
  });

  it("lists the last fixed schedule under the emergency notice, with its day", () => {
    const lastFixed = lastFixedOn(fixed05, "2026-11-06", KYIV_TZ);
    expect(lastFixed.outages[0]?.start).toBe(Date.parse("2026-11-06T06:00:00Z")); // placed on 06.11
    expect(formatDayMessage(text, emergency("2026-11-06"), lastFixed)).toBe(
      [
        `📅 Розклад на 06.11.2026\n🚨 ${link} не діє. Діють екстрені відключення.`,
        "",
        "Останній фіксований графік (на 05.11):",
        "1. 08:00 – 12:00 (4 год.)",
        "2. 20:00 – 00:00 (4 год.)",
      ].join("\n"),
    );
    const sameDay = lastFixedOn({ ...fixed05, date: "2026-11-06" }, "2026-11-06", KYIV_TZ);
    expect(formatDayMessage(text, emergency("2026-11-06"), sameDay)).toContain(
      "\n\nОстанній фіксований графік:\n1. 08:00",
    );
  });

  it("the 'emergency tomorrow' notification carries it too", () => {
    const previous = {
      date: "2026-11-07",
      status: "WaitingForSchedule" as const,
      rawStatus: "WaitingForSchedule",
      signature: "x",
      withoutOutages: true,
    };
    const result = pollTomorrow(
      {
        ...text,
        mode: "all-changes",
        lastFixed: (date) => lastFixedOn(fixed05, date, KYIV_TZ),
      },
      previous,
      day("2026-11-07", "EmergencyShutdowns"),
      "2026-11-07",
    );
    expect(result.notification?.kind).toBe("tomorrow_emergency");
    expect(result.notification?.telegramText).toContain(
      "Останній фіксований графік (на 05.11):\n1. 08:00 – 12:00",
    );
  });
});
