/**
 * Production behaviour inside the deviation zones (REVIEW.md R1, R2, R3, R8, R14), with explicit
 * expected texts. All times are Kyiv local; synthetic fixtures are dated 2026-11-10 (UTC+2).
 */
import { describe, expect, it } from "vitest";
import {
  buildReminderEvents,
  type DaySchedule,
  DEFAULT_BEHAVIOR,
  formatHHMM,
  KYIV_TZ,
  nearestOutageMessage,
  nearestRestoreMessage,
  type PlanContext,
  parseDay,
  parseGroupBlock,
  pollTomorrow,
  type RawDay,
  reminderWindows,
  type TrackedDay,
  zonedToEpoch,
} from "../src/index.ts";
import { LEGACY_LINK, loadSynthetic } from "./golden-load.ts";

const tz = KYIV_TZ;
const link = (label: string) => `<a href="${LEGACY_LINK}">${label}</a>`;

/** "2026-11-10 21:30" → instant. */
function at(value: string): number {
  const [date, time] = value.split(" ") as [string, string];
  const [h, m] = time.split(":").map(Number) as [number, number];
  return zonedToEpoch(date, h * 60 + m, tz);
}

function context(id: string, yesterday: DaySchedule | null = null): PlanContext {
  const group = parseGroupBlock(loadSynthetic(id));
  return {
    tz,
    linkUrl: LEGACY_LINK,
    behavior: DEFAULT_BEHAVIOR,
    today: group.today,
    tomorrow: group.tomorrow,
    yesterday,
  };
}

const OFF = "⚠️ Відключення поза графіком/можливо аварійні.";
const NONE_TODAY = "💡 Сьогодні відключень не передбачено";
const expectedRestore = (t: string) => `За ${link("графіком")} світло має відновитися о ${t}.`;
const overdueRestore = (t: string) => `За ${link("графіком")} світло мало відновитися о ${t}.`;
const missed = (t: string) => `Відключення мало відбутися о ${t}, очікуйте`;
const inProgress = (a: string, b: string) =>
  `За ${link("графіком")} відключення ${a}–${b} ще триває, світло може зникнути.`;

describe("midnight-crossing: 21:00–24:00 today + 00:00–03:00 tomorrow is one window", () => {
  const ctx = context("midnight-crossing");

  it("R2: restore time is 03:00 from the first moment, never 00:00", () => {
    // Early tolerance: 25% of the 21 h light-on before, capped at 3 h → from 18:00.
    expect(nearestRestoreMessage(ctx, at("2026-11-10 17:59"))).toBe(OFF);
    expect(nearestRestoreMessage(ctx, at("2026-11-10 18:00"))).toBe(expectedRestore("03:00"));
    expect(nearestRestoreMessage(ctx, at("2026-11-10 19:30"))).toBe(expectedRestore("03:00"));
    expect(nearestRestoreMessage(ctx, at("2026-11-10 23:59"))).toBe(expectedRestore("03:00"));
    expect(nearestRestoreMessage(ctx, at("2026-11-11 02:59"))).toBe(expectedRestore("03:00"));
  });

  it("R14: restore overdue for 50% of the light-on after, capped at 3 h", () => {
    expect(nearestRestoreMessage(ctx, at("2026-11-11 03:00"))).toBe(overdueRestore("03:00"));
    expect(nearestRestoreMessage(ctx, at("2026-11-11 06:00"))).toBe(overdueRestore("03:00"));
    expect(nearestRestoreMessage(ctx, at("2026-11-11 06:01"))).toBe(OFF);
  });

  it("R3 + R14: power on during the window talks about this window, not 'завтра о 00:00'", () => {
    expect(nearestOutageMessage(ctx, at("2026-11-10 20:59"))).toBe("Найближче відключення о 21:00");
    expect(nearestOutageMessage(ctx, at("2026-11-10 21:00"))).toBe(missed("21:00"));
    // Missed-start tolerance: 50% of the 6 h window = 3 h.
    expect(nearestOutageMessage(ctx, at("2026-11-11 00:00"))).toBe(missed("21:00"));
    expect(nearestOutageMessage(ctx, at("2026-11-11 00:01"))).toBe(inProgress("21:00", "03:00"));
    expect(nearestOutageMessage(ctx, at("2026-11-11 02:59"))).toBe(inProgress("21:00", "03:00"));
    expect(nearestOutageMessage(ctx, at("2026-11-11 03:00"))).toBe(NONE_TODAY);
  });

  it("R1: reminders only before the real start and the real end", () => {
    const group = parseGroupBlock(loadSynthetic("midnight-crossing"));
    const windows = reminderWindows(group, "2026-11-10", tz, DEFAULT_BEHAVIOR);
    const events = buildReminderEvents(windows, at("2026-11-10 00:00"));
    const triggers = (kind: string) =>
      events.filter((e) => e.kind === kind).map((e) => formatHHMM(e.triggerAt, tz));
    expect(triggers("outage")).toEqual(["20:50", "20:40", "20:30", "20:00"]);
    expect(triggers("restore")).toEqual(["02:50", "02:40", "02:30", "02:00"]);
  });
});

describe("adjacent Definite 06:00–10:00 + Possible 10:00–13:00", () => {
  const ctx = context("adjacent-definite-possible");

  it("R2: one window 06:00–13:00, early tolerance 25% of 6 h = 1.5 h", () => {
    expect(nearestRestoreMessage(ctx, at("2026-11-10 04:29"))).toBe(OFF);
    // Legacy said "о 10:00" here and switched to "о 13:00" at 05:15.
    expect(nearestRestoreMessage(ctx, at("2026-11-10 04:30"))).toBe(expectedRestore("13:00"));
    expect(nearestRestoreMessage(ctx, at("2026-11-10 09:59"))).toBe(expectedRestore("13:00"));
  });

  it("R3: missed start for 3 h (50% of 7 h, capped), then window in progress", () => {
    expect(nearestOutageMessage(ctx, at("2026-11-10 07:00"))).toBe(missed("06:00"));
    expect(nearestOutageMessage(ctx, at("2026-11-10 09:00"))).toBe(missed("06:00"));
    expect(nearestOutageMessage(ctx, at("2026-11-10 09:01"))).toBe(inProgress("06:00", "13:00"));
  });
});

describe("alternating 30-minute windows 08:00, 09:00, 10:00", () => {
  const ctx = context("alternating-short");

  it("R14: tolerances shrink with short windows (minimum 15 min)", () => {
    // First window: 25% of 8 h before → 2 h early.
    expect(nearestRestoreMessage(ctx, at("2026-11-10 05:59"))).toBe(OFF);
    expect(nearestRestoreMessage(ctx, at("2026-11-10 06:00"))).toBe(expectedRestore("08:30"));
    // After the first window: 50% of the 30 min gap = 15 min overdue …
    expect(nearestRestoreMessage(ctx, at("2026-11-10 08:40"))).toBe(overdueRestore("08:30"));
    // … and the second window starts counting 15 min early (25% of 30 min, raised to the minimum).
    expect(nearestRestoreMessage(ctx, at("2026-11-10 08:45"))).toBe(expectedRestore("09:30"));
    // After the last window the light-on is long → 3 h cap.
    expect(nearestRestoreMessage(ctx, at("2026-11-10 13:30"))).toBe(overdueRestore("10:30"));
    expect(nearestRestoreMessage(ctx, at("2026-11-10 13:31"))).toBe(OFF);
  });

  it("R3: 15 min of 'мало відбутися', then the window is in progress", () => {
    expect(nearestOutageMessage(ctx, at("2026-11-10 08:10"))).toBe(missed("08:00"));
    expect(nearestOutageMessage(ctx, at("2026-11-10 08:16"))).toBe(inProgress("08:00", "08:30"));
    expect(nearestOutageMessage(ctx, at("2026-11-10 08:30"))).toBe("Найближче відключення о 09:00");
  });
});

describe("yesterday from history joins a window that crosses midnight (R1)", () => {
  const yesterday = parseDay({
    date: "2026-11-09T00:00:00+02:00",
    status: "ScheduleApplies",
    slots: [
      { start: 0, end: 1320, type: "NotPlanned" },
      { start: 1320, end: 1440, type: "Definite" },
    ],
  });
  const today: RawDay = {
    date: "2026-11-10T00:00:00+02:00",
    status: "ScheduleApplies",
    slots: [
      { start: 0, end: 120, type: "Definite" },
      { start: 120, end: 1440, type: "NotPlanned" },
    ],
  };
  const tomorrow: RawDay = {
    date: "2026-11-11T00:00:00+02:00",
    status: "WaitingForSchedule",
    slots: [],
  };
  const base = {
    tz,
    linkUrl: LEGACY_LINK,
    behavior: DEFAULT_BEHAVIOR,
    today: parseDay(today),
    tomorrow: parseDay(tomorrow),
  };

  it("window is 22:00–02:00, not 00:00–02:00", () => {
    const withHistory: PlanContext = { ...base, yesterday };
    // 50% of 4 h = 2 h after 22:00 → at 01:00 the window is simply in progress.
    expect(nearestOutageMessage(withHistory, at("2026-11-10 01:00"))).toBe(
      inProgress("22:00", "02:00"),
    );
    // Without history it looks like a fresh 00:00–02:00 window that "should have started".
    expect(nearestOutageMessage(base, at("2026-11-10 01:00"))).toBe(missed("00:00"));
  });

  it("no 'outage in N min' reminders before 00:00 for the continuation", () => {
    const windows = reminderWindows({ ...base, yesterday }, "2026-11-10", tz, DEFAULT_BEHAVIOR);
    const events = buildReminderEvents(windows, at("2026-11-09 23:00"));
    expect(events.filter((e) => e.kind === "outage")).toEqual([]);
    expect(events.map((e) => formatHHMM(e.triggerAt, tz))).toEqual([
      "01:50",
      "01:40",
      "01:30",
      "01:00",
    ]);
  });
});

describe("R8: tomorrow monitor edge cases", () => {
  const day = (status: string, slots: [number, number, string][] = []) =>
    parseDay({
      date: "2026-11-11T00:00:00+02:00",
      status,
      slots: slots.map(([start, end, type]) => ({ start, end, type })),
    });
  const run = (...snapshots: DaySchedule[]) => {
    let state: TrackedDay | null = null;
    return snapshots.map((snapshot) => {
      const result = pollTomorrow(
        { tz, linkUrl: LEGACY_LINK, mode: DEFAULT_BEHAVIOR.tomorrowMonitor },
        state,
        snapshot,
        "2026-11-11",
      );
      state = result.state;
      return result.notification?.kind ?? null;
    });
  };
  const A: [number, number, string][] = [
    [0, 480, "NotPlanned"],
    [480, 720, "Definite"],
    [720, 1440, "NotPlanned"],
  ];

  it("empty → empty is not a change", () => {
    expect(run(day("NoOutages", [[0, 1440, "NotPlanned"]]), day("ScheduleApplies", []))).toEqual([
      null,
      null,
    ]);
  });

  it("withdrawn schedule is silent, the same one coming back is not news", () => {
    expect(
      run(day("ScheduleApplies", A), day("WaitingForSchedule"), day("ScheduleApplies", A)),
    ).toEqual([null, null, "tomorrow_published"]);
  });

  it("emergency is announced once", () => {
    expect(
      run(day("ScheduleApplies", A), day("EmergencyShutdowns"), day("EmergencyShutdowns")),
    ).toEqual([null, "tomorrow_emergency", null]);
  });

  it("texts", () => {
    let state: TrackedDay | null = null;
    const poll = (snapshot: DaySchedule) => {
      const result = pollTomorrow(
        { tz, linkUrl: LEGACY_LINK, mode: "all-changes" },
        state,
        snapshot,
        "2026-11-11",
      );
      state = result.state;
      return result.notification;
    };
    poll(day("ScheduleApplies", A));
    const changed = poll(
      day("ScheduleApplies", [
        [0, 600, "NotPlanned"],
        [600, 720, "Definite"],
        [720, 1440, "NotPlanned"],
      ]),
    );
    expect(changed?.telegramText).toBe(
      `🔔 ${link("Графік на завтра")} змінено!\n\n📅 Розклад на 11.11.2026\n\n1. 10:00 – 12:00 (2 год.)`,
    );
    expect(changed?.web.title).toBe("🔔 Графік на завтра змінено!");
    const emergency = poll(day("EmergencyShutdowns"));
    expect(emergency?.telegramText).toBe(
      `🔔 На завтра оголошено екстрені відключення!\n\n📅 Розклад на 11.11.2026\n🚨 ${link("Графік")} не діє. Діють екстрені відключення.`,
    );
  });
});
