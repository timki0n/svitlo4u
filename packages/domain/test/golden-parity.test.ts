/**
 * LEGACY_BEHAVIOR must reproduce the old Python bot exactly on every golden fixture.
 * DST-transition days are excluded until REVIEW.md R10 is decided: legacy compares wall-clock
 * times, the new code uses absolute time.
 */
import { describe, expect, it } from "vitest";
import {
  buildReminderEvents,
  type DayInfo,
  dayInfo,
  formatDayMessage,
  formatDuration,
  formatDurationLong,
  formatIsoOffset,
  formatLastScheduleUpdate,
  formatLeadLabel,
  isScheduleWithoutOutages,
  KYIV_TZ,
  LEGACY_BEHAVIOR,
  localDate,
  localMidnight,
  nearestOutageMessage,
  nearestOutageStart,
  nearestRestoreMessage,
  type PlanContext,
  parseDay,
  parseGroupBlock,
  pollToday,
  pollTomorrow,
  reminderWindows,
  type TrackedDay,
  withLastScheduleUpdate,
} from "../src/index.ts";
import {
  expandRuns,
  type GoldenInfo,
  isDstFixture,
  LEGACY_LINK,
  loadFormatting,
  loadGoldenDays,
  loadMonitorScenarios,
} from "./golden-load.ts";

const tz = KYIV_TZ;
const text = { tz, linkUrl: LEGACY_LINK };
const iso = (ms: number) => formatIsoOffset(ms, tz);
const local = (ms: number) => iso(ms).slice(0, 16).replace("T", " ");

function infoJson(info: DayInfo): GoldenInfo {
  return {
    date: info.date,
    status: info.rawStatus,
    outages: info.outages.map((o) => ({ start: iso(o.start), end: iso(o.end), type: o.type })),
    updatedOn: info.updatedOn,
  };
}

const days = loadGoldenDays();

describe("golden: day fixtures (legacy behaviour)", () => {
  it("covers the expected fixture set", () => {
    expect(days.length).toBeGreaterThanOrEqual(256);
  });

  describe.each(days.map((d) => [d.id, d] as const))("%s", (_id, day) => {
    const group = parseGroupBlock(day.input);
    const origin = Date.parse(day.originUtc);
    const todayDate = localDate(origin, tz);

    it("local midnight matches originUtc", () => {
      expect(localMidnight(todayDate, tz)).toBe(origin);
    });

    it.skipIf(isDstFixture(day))("static outputs", () => {
      const todayInfo = dayInfo(group.today, todayDate, tz, group.updatedOn);
      const tomorrowInfo = dayInfo(group.tomorrow, todayDate, tz, group.updatedOn);
      const todayBody = formatDayMessage(text, todayInfo);
      const tomorrowBody = formatDayMessage(text, tomorrowInfo);
      const windows = reminderWindows(group, todayDate, tz, LEGACY_BEHAVIOR);

      expect({
        todayInfo: infoJson(todayInfo),
        tomorrowInfo: infoJson(tomorrowInfo),
        todayBody,
        tomorrowBody,
        todayCommand: withLastScheduleUpdate(text, todayBody, group.updatedOn),
        tomorrowCommand: withLastScheduleUpdate(text, tomorrowBody, group.updatedOn),
        todayWithoutOutages: isScheduleWithoutOutages(group.today),
        tomorrowWithoutOutages: isScheduleWithoutOutages(group.tomorrow),
        planSegments: windows.map((w) => [iso(w.start), iso(w.end)]),
        remindersAtOrigin: {
          fields: day.static.remindersAtOrigin.fields,
          rows: buildReminderEvents(windows, origin).map((r) => [
            r.kind,
            r.leadMinutes,
            iso(r.triggerAt),
            iso(r.start),
            iso(r.end),
            r.durationMinutes,
          ]),
        },
      }).toEqual(day.static);
    });

    it.skipIf(isDstFixture(day))("timeline over 48 h", () => {
      const ctx: PlanContext = {
        ...text,
        behavior: LEGACY_BEHAVIOR,
        today: group.today,
        tomorrow: group.tomorrow,
      };
      const expected = {
        restore: expandRuns(day.samples, day.timeline.nearestRestoreMessage),
        outage: expandRuns(day.samples, day.timeline.nearestOutageMessage),
        start: expandRuns(day.samples, day.timeline.nearestOutage),
      };
      const mismatches: string[] = [];
      day.samples.forEach((minute, i) => {
        const now = origin + minute * 60_000;
        const restore = nearestRestoreMessage(ctx, now);
        const outage = nearestOutageMessage(ctx, now);
        const startMs = nearestOutageStart(ctx, now);
        const start = startMs === null ? null : iso(startMs);
        if (restore !== expected.restore[i])
          mismatches.push(`${local(now)} restore: ${restore} ≠ ${expected.restore[i]}`);
        if (outage !== expected.outage[i])
          mismatches.push(`${local(now)} outage: ${outage} ≠ ${expected.outage[i]}`);
        if (start !== expected.start[i])
          mismatches.push(`${local(now)} start: ${start} ≠ ${expected.start[i]}`);
      });
      expect(mismatches.slice(0, 10)).toEqual([]);
    });
  });
});

describe("golden: schedule monitors (legacy behaviour)", () => {
  it.each(loadMonitorScenarios().map((s) => [s.id, s] as const))("%s", (_id, scenario) => {
    let state: TrackedDay | null = null;
    const iterations = scenario.snapshots.map((snapshot) => {
      const day = parseDay(snapshot);
      const fallback = day.date ?? "1970-01-01";
      const result =
        scenario.monitor === "today"
          ? pollToday(text, state, day, fallback)
          : pollTomorrow({ ...text, mode: LEGACY_BEHAVIOR.tomorrowMonitor }, state, day, fallback);
      state = result.state;
      return result.notification
        ? { telegram: [result.notification.telegramText], web: [result.notification.web] }
        : { telegram: [], web: [] };
    });
    expect(iterations).toEqual(scenario.iterations);
  });
});

describe("golden: formatting", () => {
  const golden = loadFormatting();
  const base = localMidnight("2026-11-10", tz);

  it("formatDurationLong", () => {
    expect(golden.fmtDurationLong.map(([s]) => [s, formatDurationLong(s)])).toEqual(
      golden.fmtDurationLong,
    );
  });
  it("formatDuration", () => {
    expect(
      golden.formatDuration.map(([a, b]) => [
        a,
        b,
        formatDuration(base + a * 60_000, base + b * 60_000),
      ]),
    ).toEqual(golden.formatDuration);
  });
  it("formatLastScheduleUpdate", () => {
    expect(
      golden.formatLastScheduleUpdate.map(([u]) => [u, formatLastScheduleUpdate(text, u)]),
    ).toEqual(golden.formatLastScheduleUpdate);
  });
  it("formatLeadLabel", () => {
    expect(golden.formatLeadLabel.map(([m]) => [m, formatLeadLabel(m)])).toEqual(
      golden.formatLeadLabel,
    );
  });
});
