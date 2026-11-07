/**
 * DEFAULT_BEHAVIOR (production) against the legacy golden outputs.
 *
 * Production deliberately differs near planned windows (REVIEW.md R1, R2, R3, R14). Everywhere
 * else it must say exactly what the legacy bot said. The deviation zones below are the only
 * places where a difference is allowed; what happens inside them is pinned by scenarios.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  buildReminderEvents,
  DEFAULT_BEHAVIOR,
  formatIsoOffset,
  KYIV_TZ,
  knownRange,
  LEGACY_BEHAVIOR,
  localDate,
  mergeWindows,
  nearestOutageMessage,
  nearestRestoreMessage,
  type OutageWindow,
  type PlanContext,
  parseDay,
  parseGroupBlock,
  pollToday,
  pollTomorrow,
  reminderWindows,
  type ScheduleStatus,
  type TrackedDay,
  windowGrace,
} from "../src/index.ts";
import { collectSlots } from "../src/windows.ts";
import {
  expandRuns,
  isDstFixture,
  LEGACY_LINK,
  loadGoldenDays,
  loadMonitorScenarios,
} from "./golden-load.ts";

const APPLIES = new Set<ScheduleStatus>(["ScheduleApplies"]);

const tz = KYIV_TZ;
const text = { tz, linkUrl: LEGACY_LINK };
const MIN = 60_000;
const LEGACY_TOLERANCE = 90 * MIN; // the widest legacy tolerance (missed start / restore delay / future soon)
const local = (ms: number) => formatIsoOffset(ms, tz).slice(0, 16).replace("T", " ");

type Interval = [number, number];
const inside = (zones: Interval[], t: number) => zones.some(([a, b]) => a <= t && t <= b);

/** Where production may differ from legacy, per function. */
function deviationZones(ctx: PlanContext, todayDate: string) {
  const refs = [
    { day: ctx.today, date: ctx.today.date ?? todayDate },
    { day: ctx.tomorrow, date: ctx.tomorrow.date ?? addDays(todayDate, 1) },
  ];
  // The unmerged slots legacy messages iterate over (ScheduleApplies days only).
  const raw: OutageWindow[] = collectSlots(refs, APPLIES, tz).map(({ start, end }) => ({
    start,
    end,
  }));
  const merged = mergeWindows(raw);
  const range = knownRange(refs, tz);
  const restore: Interval[] = [];
  const outage: Interval[] = [];
  for (const w of merged) {
    const g = windowGrace(w, merged, range, DEFAULT_BEHAVIOR.grace);
    // R2 + R14: early start / overdue restore around the merged window.
    restore.push([
      w.start - Math.max(LEGACY_TOLERANCE, g.early),
      w.end + Math.max(LEGACY_TOLERANCE, g.restore),
    ]);
    // R3 + R14: in-window texts and the missed-start tolerance.
    outage.push([w.start, Math.max(w.end, w.start + Math.max(LEGACY_TOLERANCE, g.missed))]);
  }
  for (const s of raw) {
    // Legacy "мало відбутися" lasts 90 min after every unmerged slot start (R1/R2 continuation slots).
    outage.push([s.start, s.start + LEGACY_TOLERANCE]);
  }
  return { restore, outage };
}

const days = loadGoldenDays();

describe("golden: production behaviour outside deviation zones", () => {
  describe.each(days.filter((d) => !isDstFixture(d)).map((d) => [d.id, d] as const))(
    "%s",
    (_id, day) => {
      const group = parseGroupBlock(day.input);
      const origin = Date.parse(day.originUtc);
      const todayDate = localDate(origin, tz);
      const ctx: PlanContext = {
        ...text,
        behavior: DEFAULT_BEHAVIOR,
        today: group.today,
        tomorrow: group.tomorrow,
      };
      const zones = deviationZones(ctx, todayDate);

      it("plan texts match legacy outside the zones", () => {
        const restore = expandRuns(day.samples, day.timeline.nearestRestoreMessage);
        const outage = expandRuns(day.samples, day.timeline.nearestOutageMessage);
        const mismatches: string[] = [];
        day.samples.forEach((minute, i) => {
          const now = origin + minute * MIN;
          if (!inside(zones.restore, now)) {
            const actual = nearestRestoreMessage(ctx, now);
            if (actual !== restore[i])
              mismatches.push(`${local(now)} restore: ${actual} ≠ ${restore[i]}`);
          }
          if (!inside(zones.outage, now)) {
            const actual = nearestOutageMessage(ctx, now);
            if (actual !== outage[i])
              mismatches.push(`${local(now)} outage: ${actual} ≠ ${outage[i]}`);
          }
        });
        expect(mismatches.slice(0, 10)).toEqual([]);
      });

      it("reminders match legacy when nothing had to be merged (R1)", () => {
        const legacy = reminderWindows(group, todayDate, tz, LEGACY_BEHAVIOR);
        const production = reminderWindows(group, todayDate, tz, DEFAULT_BEHAVIOR);
        if (legacy.length !== production.length) return; // merged → covered by scenarios.test.ts
        const rows = buildReminderEvents(production, origin).map((r) => [
          r.kind,
          r.leadMinutes,
          formatIsoOffset(r.triggerAt, tz),
          formatIsoOffset(r.start, tz),
          formatIsoOffset(r.end, tz),
          r.durationMinutes,
        ]);
        expect(new Set(rows.map((r) => JSON.stringify(r)))).toEqual(
          new Set(day.static.remindersAtOrigin.rows.map((r) => JSON.stringify(r))),
        );
      });
    },
  );
});

describe("golden: production schedule monitors", () => {
  const scenarios = loadMonitorScenarios();

  it.each(scenarios.filter((s) => s.monitor === "today").map((s) => [s.id, s] as const))(
    "%s is unchanged from legacy",
    (_id, scenario) => {
      let state: TrackedDay | null = null;
      const iterations = scenario.snapshots.map((snapshot) => {
        const day = parseDay(snapshot);
        const result = pollToday(text, state, day, day.date ?? "1970-01-01");
        state = result.state;
        return result.notification
          ? { telegram: [result.notification.telegramText], web: [result.notification.web] }
          : { telegram: [], web: [] };
      });
      expect(iterations).toEqual(scenario.iterations);
    },
  );

  // R8: expected notification kinds per poll for every tomorrow scenario.
  const expectedKinds: Record<string, (string | null)[]> = {
    "tomorrow:first-run": [null],
    "tomorrow:waiting-to-applies": [null, "tomorrow_published"],
    "tomorrow:waiting-to-no-outages": [null, "tomorrow_published"],
    "tomorrow:waiting-to-applies-empty": [null, "tomorrow_published"],
    "tomorrow:applies-slots-changed": [null, "tomorrow_changed"],
    "tomorrow:waiting-to-emergency": [null, null],
    "tomorrow:emergency-to-applies": [null, "tomorrow_published"],
    "tomorrow:applies-waiting-applies": [null, null, "tomorrow_changed"],
    "tomorrow:rollover-published": [null, "tomorrow_published"],
  };

  it.each(scenarios.filter((s) => s.monitor === "tomorrow").map((s) => [s.id, s] as const))(
    "%s (R8)",
    (id, scenario) => {
      let state: TrackedDay | null = null;
      const kinds = scenario.snapshots.map((snapshot) => {
        const day = parseDay(snapshot);
        const result = pollTomorrow(
          { ...text, mode: DEFAULT_BEHAVIOR.tomorrowMonitor },
          state,
          day,
          day.date ?? "1970-01-01",
        );
        state = result.state;
        return result.notification?.kind ?? null;
      });
      expect(kinds).toEqual(expectedKinds[id]);
      // Where legacy already notified, we do too (a comeback that differs is a change).
      scenario.iterations.forEach((iteration, i) => {
        if (iteration.telegram.length > 0)
          expect(kinds[i]).toMatch(/^tomorrow_(published|changed)$/);
      });
    },
  );
});
