/**
 * Midnight: today is compared with its last version seen as tomorrow. 2026-11-08: the provider
 * added 00:00–01:00 right at 00:00, after "tomorrow" had been announced at 23:15 without it.
 */
import { describe, expect, it } from "vitest";
import {
  type DaySchedule,
  KYIV_TZ,
  parseDay,
  pollToday,
  type TrackedDay,
  timedOutageSlots,
} from "../src/index.ts";

const text = { tz: KYIV_TZ, linkUrl: "https://svitlo4u.info" };
const link = (label: string) => `<a href="https://svitlo4u.info">${label}</a>`;

const day = (date: string, status: string, slots: [number, number][] = []): DaySchedule => ({
  ...parseDay({
    date: `${date}T00:00:00+02:00`,
    status,
    slots: slots.map(([start, end]) => ({ start, end, type: "Definite" })),
  }),
  date,
});

const yesterday: TrackedDay = pollToday(
  text,
  null,
  day("2026-11-07", "ScheduleApplies", [[1200, 1440]]),
  "2026-11-07",
).state;
const evening = day("2026-11-08", "ScheduleApplies", [
  [360, 810],
  [960, 1440],
]);
const atMidnight = day("2026-11-08", "ScheduleApplies", [
  [0, 60],
  [360, 810],
  [960, 1440],
]);
/** The store as the service sees it before the midnight update is saved. */
const stored = (version: DaySchedule | null) => ({
  ...text,
  lastKnown: (date: string) => (version?.date === date ? version : null),
  lastFixed: (date: string) =>
    version?.date === date && version.status === "ScheduleApplies"
      ? timedOutageSlots(version, date, KYIV_TZ)
      : null,
});

describe("today at midnight", () => {
  it("a change made right at 00:00 is news, then the day is its own baseline", () => {
    const ctx = stored(evening);
    const midnight = pollToday(ctx, yesterday, atMidnight, "2026-11-08");
    expect(midnight.notification?.kind).toBe("today_updated");
    expect(midnight.notification?.telegramText).toBe(
      [
        `🔔 ${link("Графік на сьогодні")} оновлено!`,
        "",
        "📅 Розклад на 08.11.2026",
        "",
        "1. 00:00 – 01:00 (1 год.)",
        "2. 06:00 – 13:30 (7 год. 30 хв.)",
        "3. 16:00 – 00:00 (8 год.)",
      ].join("\n"),
    );
    expect(midnight.notification?.web.title).toBe("🔔 Графік на сьогодні оновлено!");

    const again = pollToday(ctx, midnight.state, atMidnight, "2026-11-08");
    expect(again.notification).toBeNull();
    expect(again.persist).toBe(false);
  });

  it("the day as it was announced the evening before is silent", () => {
    const result = pollToday(stored(evening), yesterday, evening, "2026-11-08");
    expect(result.notification).toBeNull();
    expect(result.persist).toBe(true);
    // The next real change during the day is still news.
    const later = pollToday(stored(evening), result.state, atMidnight, "2026-11-08");
    expect(later.notification?.kind).toBe("today_updated");
  });

  it("a day never seen as tomorrow only sets the baseline (no message at midnight)", () => {
    expect(pollToday(stored(null), yesterday, atMidnight, "2026-11-08").notification).toBeNull();
    expect(pollToday(text, yesterday, atMidnight, "2026-11-08").notification).toBeNull();
  });

  it("emergency shutdowns: already seen as tomorrow → silent; declared at 00:00 → a change", () => {
    const emergency = day("2026-11-08", "EmergencyShutdowns");
    expect(
      pollToday(stored(emergency), yesterday, emergency, "2026-11-08").notification,
    ).toBeNull();

    const declared = pollToday(stored(evening), yesterday, emergency, "2026-11-08");
    expect(declared.notification?.kind).toBe("today_updated");
    expect(declared.notification?.telegramText).toContain(
      `🚨 ${link("Графік")} не діє. Діють екстрені відключення.\n\nОстанній згаданий графік:\n1. 06:00 – 13:30`,
    );
  });

  it("two versions without outages are not news at midnight either", () => {
    const noOutages = day("2026-11-08", "NoOutages");
    const empty = day("2026-11-08", "ScheduleApplies");
    expect(pollToday(stored(noOutages), yesterday, empty, "2026-11-08").notification).toBeNull();
  });
});
