import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addDays,
  calendarBuckets,
  type Interval,
  isoWeekKey,
  KYIV_TZ,
  localMidnight,
  outageBuckets,
  outageSummary,
  overlapMs,
  parseDay,
  planVsFact,
  type ScheduleStatus,
  scheduleChangeStats,
  subtract,
  totalMs,
  union,
  voltageRollup,
  voltageSummary,
  weeklyHeatmap,
  zonedToEpoch,
} from "../src/index.ts";
import { collectSlots } from "../src/windows.ts";

const tz = KYIV_TZ;
const H = 3_600_000;
const M = 60_000;
/** "2026-11-10 08:00" → instant (Kyiv). */
function at(value: string): number {
  const [date, time] = value.split(" ") as [string, string];
  const [h, m] = time.split(":").map(Number) as [number, number];
  return zonedToEpoch(date, h * 60 + m, tz);
}
const iv = (a: string, b: string): Interval => ({ start: at(a), end: at(b) });
const day = (date: string): Interval => ({
  start: localMidnight(date, tz),
  end: localMidnight(addDays(date, 1), tz),
});

describe("intervals", () => {
  it("union, overlap, subtract", () => {
    const a = [
      iv("2026-11-10 08:00", "2026-11-10 10:00"),
      iv("2026-11-10 09:00", "2026-11-10 11:00"),
      iv("2026-11-10 11:00", "2026-11-10 12:00"),
    ];
    expect(union(a)).toEqual([iv("2026-11-10 08:00", "2026-11-10 12:00")]);
    expect(totalMs(a)).toBe(4 * H);
    expect(overlapMs(a, [iv("2026-11-10 11:30", "2026-11-10 14:00")])).toBe(30 * M);
    expect(
      subtract(
        [iv("2026-11-10 08:00", "2026-11-10 12:00")],
        [iv("2026-11-10 09:00", "2026-11-10 10:00")],
      ),
    ).toEqual([
      iv("2026-11-10 08:00", "2026-11-10 09:00"),
      iv("2026-11-10 10:00", "2026-11-10 12:00"),
    ]);
  });

  it("ISO week keys (Monday weeks, week of the Thursday's year)", () => {
    expect(isoWeekKey("2025-12-29")).toBe("2026-W01");
    expect(isoWeekKey("2026-01-01")).toBe("2026-W01");
    expect(isoWeekKey("2026-11-06")).toBe("2026-W45");
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(isoWeekKey("2021-01-03")).toBe("2020-W53");
  });

  it("day buckets follow local days, including 23 h and 25 h DST days", () => {
    const spring = calendarBuckets(
      { start: localMidnight("2026-03-28", tz), end: localMidnight("2026-03-31", tz) },
      tz,
      "day",
    );
    expect(spring.map((b) => [b.key, (b.end - b.start) / H])).toEqual([
      ["2026-03-28", 24],
      ["2026-03-29", 23],
      ["2026-03-30", 24],
    ]);
    const fall = calendarBuckets(
      { start: localMidnight("2026-10-24", tz), end: localMidnight("2026-10-27", tz) },
      tz,
      "day",
    );
    expect(fall.map((b) => (b.end - b.start) / H)).toEqual([24, 25, 24]);
  });

  it("week and month buckets are clipped to the range", () => {
    const range = iv("2026-11-04 12:00", "2026-12-02 00:00");
    expect(calendarBuckets(range, tz, "week").map((b) => b.key)).toEqual([
      "2026-W45",
      "2026-W46",
      "2026-W47",
      "2026-W48",
      "2026-W49",
    ]);
    const months = calendarBuckets(range, tz, "month");
    expect(months.map((b) => b.key)).toEqual(["2026-11", "2026-12"]);
    expect(months[0]?.start).toBe(range.start);
    expect(months[1]?.end).toBe(range.end);
  });
});

describe("outage statistics", () => {
  const now = at("2026-11-12 12:00");

  it("an outage across midnight is split between days; false alarms do not count", () => {
    const buckets = outageBuckets(
      [
        { start: at("2026-11-10 22:00"), end: at("2026-11-11 02:00") },
        { start: at("2026-11-11 10:00"), end: at("2026-11-11 10:01"), falseAlarm: true },
      ],
      {
        range: { start: day("2026-11-10").start, end: day("2026-11-11").end },
        tz,
        now,
        granularity: "day",
      },
    );
    expect(buckets.map((b) => [b.key, b.offMs / H, b.outages, b.longestOutageMs / H])).toEqual([
      ["2026-11-10", 2, 1, 4],
      ["2026-11-11", 2, 0, 0],
    ]);
  });

  it("an ongoing outage lasts until now; the future is not counted", () => {
    const [today] = outageBuckets([{ start: at("2026-11-12 09:00"), end: null }], {
      range: day("2026-11-12"),
      tz,
      now,
      granularity: "day",
    });
    expect(today?.durationMs).toBe(12 * H);
    expect(today?.offMs).toBe(3 * H);
    expect(today?.offShare).toBe(0.25);
  });

  it("summary: hours without light, longest stretches, average", () => {
    const summary = outageSummary(
      [
        { start: at("2026-11-10 08:00"), end: at("2026-11-10 10:00") },
        { start: at("2026-11-10 18:00"), end: at("2026-11-10 21:00") },
      ],
      { range: day("2026-11-10"), now },
    );
    expect(summary).toEqual({
      durationMs: 24 * H,
      offMs: 5 * H,
      onMs: 19 * H,
      offShare: 5 / 24,
      outages: 2,
      longestOutageMs: 3 * H,
      averageOutageMs: 2.5 * H,
      longestLightOnMs: 8 * H,
    });
  });
});

describe("plan vs fact", () => {
  it("matches outages to windows, measures deviations, finds unplanned outages and unexecuted windows", () => {
    const plan = [
      iv("2026-11-10 00:00", "2026-11-10 02:00"),
      iv("2026-11-10 08:00", "2026-11-10 12:00"),
      iv("2026-11-10 18:00", "2026-11-10 22:00"),
    ];
    const actual = [
      { start: at("2026-11-10 07:50"), end: at("2026-11-10 12:20") },
      { start: at("2026-11-10 14:00"), end: at("2026-11-10 14:30") },
      { start: at("2026-11-10 18:00"), end: at("2026-11-10 19:00") },
      { start: at("2026-11-10 19:30"), end: at("2026-11-10 22:00") },
    ];
    const result = planVsFact(plan, actual, {
      range: day("2026-11-10"),
      now: at("2026-11-11 00:00"),
    });

    expect(
      result.matches.map((m) => [
        m.actual.length,
        m.startDeviationMs && m.startDeviationMs / M,
        m.endDeviationMs && m.endDeviationMs / M,
        m.coveredMs / M,
      ]),
    ).toEqual([
      [0, null, null, 0],
      [1, -10, 20, 240],
      [2, 0, 0, 210],
    ]);
    expect(result.unplanned).toEqual([iv("2026-11-10 14:00", "2026-11-10 14:30")]);
    expect(result.totals).toEqual({
      plannedMs: 10 * H,
      actualMs: 8.5 * H,
      overlapMs: 7.5 * H,
      offScheduleMs: 1 * H,
      plannedButLightMs: 2.5 * H,
      executedShare: 0.75,
      windows: 3,
      executedWindows: 2,
      averageStartDeviationMs: -5 * M,
      averageEndDeviationMs: 10 * M,
    });
  });

  it("future windows are not 'unexecuted'", () => {
    const result = planVsFact([iv("2026-11-10 18:00", "2026-11-10 22:00")], [], {
      range: day("2026-11-10"),
      now: at("2026-11-10 19:00"),
    });
    expect(result.totals.plannedMs).toBe(1 * H);
  });
});

describe("weekly heatmap", () => {
  it("Monday 10:00 every week → that cell is always off, the rest never", () => {
    const outages = [
      iv("2026-11-09 10:00", "2026-11-09 11:00"),
      iv("2026-11-16 10:00", "2026-11-16 11:00"),
    ];
    const map = weeklyHeatmap(outages, {
      range: { start: day("2026-11-09").start, end: day("2026-11-22").end },
      tz,
    });
    expect(map.share[0]?.[10]).toBe(1);
    expect(map.share[0]?.[9]).toBe(0);
    expect(map.share[1]?.[10]).toBe(0);
    expect(map.totalMs[0]?.[10]).toBe(2 * H);
  });

  it("covers DST weeks without losing time", () => {
    const range = { start: day("2026-10-19").start, end: day("2026-11-01").end };
    const map = weeklyHeatmap([], { range, tz });
    expect(map.totalMs.flat().reduce((s, v) => s + v, 0)).toBe(range.end - range.start);
  });
});

describe("schedule changes", () => {
  it("counts versions after publication, publication lead time and emergencies", () => {
    const snap = (date: string, fetched: string, status: ScheduleStatus, signature: string) => ({
      date,
      fetchedAt: at(fetched),
      status,
      signature,
    });
    const { days, totals } = scheduleChangeStats(
      [
        snap("2026-11-11", "2026-11-10 18:00", "WaitingForSchedule", "w"),
        snap("2026-11-11", "2026-11-10 20:00", "ScheduleApplies", "a"),
        snap("2026-11-11", "2026-11-11 07:00", "ScheduleApplies", "b"),
        snap("2026-11-11", "2026-11-11 07:05", "ScheduleApplies", "b"),
        snap("2026-11-11", "2026-11-11 12:00", "EmergencyShutdowns", "e"),
        snap("2026-11-12", "2026-11-11 21:00", "NoOutages", "n"),
      ],
      { tz },
    );
    expect(
      days.map((d) => [
        d.date,
        d.versions,
        d.changesAfterPublish,
        d.publishLeadMs && d.publishLeadMs / H,
        d.finalStatus,
        d.hadEmergency,
      ]),
    ).toEqual([
      ["2026-11-11", 4, 2, 4, "EmergencyShutdowns", true],
      ["2026-11-12", 1, 0, 3, "NoOutages", false],
    ]);
    expect(totals).toEqual({
      days: 2,
      publishedDays: 2,
      changedDays: 1,
      totalChanges: 2,
      emergencyDays: 1,
      medianPublishLeadMs: 3.5 * H,
    });
  });
});

describe("voltage", () => {
  const samples = [
    { t: at("2026-11-10 10:05"), voltage: 230 },
    { t: at("2026-11-10 10:50"), voltage: 205 },
    { t: at("2026-11-10 11:10"), voltage: 255 },
    { t: at("2026-11-10 11:40"), voltage: 231 },
  ];

  it("summary against EN 50160 limits (230 V ± 10 %)", () => {
    expect(voltageSummary(samples)).toEqual({
      count: 4,
      min: 205,
      max: 255,
      avg: 230.25,
      below: 1,
      above: 1,
      belowShare: 0.25,
      aboveShare: 0.25,
    });
  });

  it("hourly and daily rollups", () => {
    const hourly = voltageRollup(samples, { range: day("2026-11-10"), tz, granularity: "hour" });
    expect(hourly.map((b) => [b.key, b.count, b.min, b.max, b.avg])).toEqual([
      ["2026-11-10 10:00", 2, 205, 230, 217.5],
      ["2026-11-10 11:00", 2, 231, 255, 243],
    ]);
    expect(
      voltageRollup(samples, { range: day("2026-11-10"), tz, granularity: "day" }).map(
        (b) => b.count,
      ),
    ).toEqual([4]);
  });
});

describe("real schedule history (group 12.1) as planned outages", () => {
  const history = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/yasno/history.json", import.meta.url)), "utf8"),
  ) as {
    days: {
      group: string;
      date: string;
      status: string;
      slots: { start: number; end: number; type: string }[];
    }[];
  };
  const rows = history.days.filter((d) => d.group === "12.1");
  const refs = rows.map((r) => ({
    day: parseDay({ date: r.date, status: r.status, slots: r.slots }),
    date: r.date,
  }));
  const planned = union(collectSlots(refs, new Set<ScheduleStatus>(["ScheduleApplies"]), tz));
  const range = {
    start: localMidnight(rows[0]?.date ?? "", tz),
    end: localMidnight(addDays(rows.at(-1)?.date ?? "", 1), tz),
  };
  const records = planned.map((p) => ({ start: p.start, end: p.end }));
  const options = { range, tz, now: range.end };

  it("daily, weekly and monthly totals all add up to the same planned hours", () => {
    const total = totalMs(planned);
    const sum = (granularity: "day" | "week" | "month") =>
      outageBuckets(records, { ...options, granularity }).reduce((s, b) => s + b.offMs, 0);
    expect(total).toBeGreaterThan(500 * H);
    expect(sum("day")).toBe(total);
    expect(sum("week")).toBe(total);
    expect(sum("month")).toBe(total);
  });

  it("monthly buckets cover the whole year, shares stay within 0..1", () => {
    const months = outageBuckets(records, { ...options, granularity: "month" });
    expect(months.map((m) => m.key)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    for (const m of months) {
      expect(m.offShare).toBeGreaterThanOrEqual(0);
      expect(m.offShare).toBeLessThanOrEqual(1);
    }
    const heat = weeklyHeatmap(planned, { range, tz });
    expect(heat.share.flat().every((v) => v !== null && v >= 0 && v <= 1)).toBe(true);
  });
});
