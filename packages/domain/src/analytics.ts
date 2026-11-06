/**
 * Analytics over history: pure functions for the analytics API (charts with filters).
 * Inputs come from the DB: actual outages (detector), planned windows (schedule snapshots),
 * schedule versions and voltage samples. Calendar buckets use the site's time zone.
 */

import {
  type Bucket,
  calendarBuckets,
  clip,
  type Granularity,
  type Interval,
  overlapMs,
  subtract,
  totalMs,
  union,
  weekdayHour,
} from "./intervals.ts";
import { isPublishedSchedule, type ScheduleStatus } from "./schedule-status.ts";
import { localMidnight, pad2, toZoned } from "./time.ts";

const HOUR = 3_600_000;

// ───────────────────────── actual outages ─────────────────────────

export type OutageRecord = {
  start: number;
  /** null while the outage is still going on. */
  end: number | null;
  /** Retracted by the detector (Wi-Fi gap) — never counted. */
  falseAlarm?: boolean;
};

/** Outages as intervals; an ongoing one lasts until `now`. */
export function outageIntervals(records: readonly OutageRecord[], now: number): Interval[] {
  return records
    .filter((r) => !r.falseAlarm)
    .map((r) => ({ start: r.start, end: r.end ?? now }))
    .filter((i) => i.end > i.start);
}

export type OutageBucket = Bucket & {
  /** Length of the bucket (clipped to the requested range and to now). */
  durationMs: number;
  /** Time without power inside the bucket. */
  offMs: number;
  offShare: number;
  /** Outages that started in the bucket. */
  outages: number;
  /** Full length of the longest outage that started in the bucket. */
  longestOutageMs: number;
};

export type AnalyticsRange = { range: Interval; tz: string; now: number };

function upToNow(range: Interval, now: number): Interval {
  return { start: range.start, end: Math.min(range.end, now) };
}

/** Hours without light per day / week / month. */
export function outageBuckets(
  records: readonly OutageRecord[],
  options: AnalyticsRange & { granularity: Granularity },
): OutageBucket[] {
  const range = upToNow(options.range, options.now);
  if (range.end <= range.start) return [];
  const intervals = union(outageIntervals(records, options.now));
  return calendarBuckets(range, options.tz, options.granularity).map((bucket) => {
    const started = intervals.filter((i) => i.start >= bucket.start && i.start < bucket.end);
    const durationMs = bucket.end - bucket.start;
    const offMs = overlapMs(intervals, [bucket]);
    return {
      ...bucket,
      durationMs,
      offMs,
      offShare: durationMs > 0 ? offMs / durationMs : 0,
      outages: started.length,
      longestOutageMs: Math.max(0, ...started.map((i) => i.end - i.start)),
    };
  });
}

export type OutageSummary = {
  durationMs: number;
  offMs: number;
  onMs: number;
  offShare: number;
  /** Outages that started inside the range. */
  outages: number;
  longestOutageMs: number;
  averageOutageMs: number;
  /** Longest stretch with light inside the range. */
  longestLightOnMs: number;
};

export function outageSummary(
  records: readonly OutageRecord[],
  options: Omit<AnalyticsRange, "tz">,
): OutageSummary {
  const range = upToNow(options.range, options.now);
  const durationMs = Math.max(0, range.end - range.start);
  const intervals = union(outageIntervals(records, options.now));
  const inside = intervals.map((i) => clip(i, range)).filter((i): i is Interval => i !== null);
  const started = intervals.filter((i) => i.start >= range.start && i.start < range.end);
  const offMs = totalMs(inside);
  const lightOn = durationMs > 0 ? subtract([range], inside) : [];
  return {
    durationMs,
    offMs,
    onMs: durationMs - offMs,
    offShare: durationMs > 0 ? offMs / durationMs : 0,
    outages: started.length,
    longestOutageMs: Math.max(0, ...started.map((i) => i.end - i.start)),
    averageOutageMs: started.length
      ? started.reduce((s, i) => s + (i.end - i.start), 0) / started.length
      : 0,
    longestLightOnMs: Math.max(0, ...lightOn.map((i) => i.end - i.start)),
  };
}

// ───────────────────────── plan vs fact ─────────────────────────

export type PlanFactMatch = {
  plan: Interval;
  /** Actual outages attributed to this window. */
  actual: Interval[];
  /** First actual start − planned start (negative = earlier than planned). */
  startDeviationMs: number | null;
  /** Last actual end − planned end (positive = later than planned). */
  endDeviationMs: number | null;
  /** Planned time that really was without power. */
  coveredMs: number;
};

export type PlanVsFact = {
  matches: PlanFactMatch[];
  /** Actual outages not attributable to any planned window. */
  unplanned: Interval[];
  totals: {
    plannedMs: number;
    actualMs: number;
    /** Without power and planned. */
    overlapMs: number;
    /** Without power but not planned. */
    offScheduleMs: number;
    /** Planned but there was light. */
    plannedButLightMs: number;
    /** Share of planned time that really was without power (null without plan). */
    executedShare: number | null;
    windows: number;
    executedWindows: number;
    averageStartDeviationMs: number | null;
    averageEndDeviationMs: number | null;
  };
};

/**
 * Compare planned windows with actual outages. An actual outage belongs to the planned window it
 * overlaps most, or — when it overlaps none — to the nearest window within `matchToleranceMs`.
 * Only the past counts: plan and fact are clipped to [range.start, min(range.end, now)].
 */
export function planVsFact(
  plan: readonly Interval[],
  records: readonly OutageRecord[],
  options: Omit<AnalyticsRange, "tz"> & { matchToleranceMs?: number },
): PlanVsFact {
  const range = upToNow(options.range, options.now);
  const tolerance = options.matchToleranceMs ?? HOUR;
  const windows = union(plan)
    .map((w) => clip(w, range))
    .filter((w): w is Interval => w !== null);
  const actual = union(outageIntervals(records, options.now))
    .map((a) => clip(a, range))
    .filter((a): a is Interval => a !== null);

  const assigned: Interval[][] = windows.map(() => []);
  const unplanned: Interval[] = [];
  for (const a of actual) {
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    windows.forEach((w, index) => {
      const overlap = overlapMs([a], [w]);
      const distance = overlap > 0 ? 0 : Math.max(w.start - a.end, a.start - w.end);
      if (overlap === 0 && distance > tolerance) return;
      const score = overlap > 0 ? overlap : -distance;
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    if (best >= 0) (assigned[best] as Interval[]).push(a);
    else unplanned.push(a);
  }

  const matches = windows.map((w, index) => {
    const parts = assigned[index] as Interval[];
    return {
      plan: w,
      actual: parts,
      startDeviationMs: parts.length ? Math.min(...parts.map((p) => p.start)) - w.start : null,
      endDeviationMs: parts.length ? Math.max(...parts.map((p) => p.end)) - w.end : null,
      coveredMs: overlapMs(parts, [w]),
    };
  });
  const plannedMs = totalMs(windows);
  const actualMs = totalMs(actual);
  const overlap = overlapMs(windows, actual);
  const executed = matches.filter((m) => m.actual.length > 0);
  const average = (values: number[]) =>
    values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  return {
    matches,
    unplanned,
    totals: {
      plannedMs,
      actualMs,
      overlapMs: overlap,
      offScheduleMs: actualMs - overlap,
      plannedButLightMs: plannedMs - overlap,
      executedShare: plannedMs > 0 ? overlap / plannedMs : null,
      windows: windows.length,
      executedWindows: executed.length,
      averageStartDeviationMs: average(executed.map((m) => m.startDeviationMs as number)),
      averageEndDeviationMs: average(executed.map((m) => m.endDeviationMs as number)),
    },
  };
}

// ───────────────────────── heatmap ─────────────────────────

export type WeeklyHeatmap = {
  /** [weekday 0=Mon..6][hour 0..23] */
  offMs: number[][];
  totalMs: number[][];
  /** offMs / totalMs, null where the range has no such hour. */
  share: (number | null)[][];
};

/**
 * How often there is no power at a given weekday and hour. Works for actual outages and for
 * planned windows alike. Hour slots are UTC hours, which coincide with local hours in zones with
 * whole-hour offsets (Kyiv).
 */
export function weeklyHeatmap(
  intervals: readonly Interval[],
  options: { range: Interval; tz: string },
): WeeklyHeatmap {
  const grid = () => Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const off = grid();
  const total = grid();
  const merged = union(intervals);
  let pointer = 0;
  for (let t = Math.floor(options.range.start / HOUR) * HOUR; t < options.range.end; t += HOUR) {
    const slot = clip({ start: t, end: t + HOUR }, options.range);
    if (!slot) continue;
    const { weekday, hour } = weekdayHour(slot.start, options.tz);
    (total[weekday] as number[])[hour] =
      ((total[weekday] as number[])[hour] ?? 0) + (slot.end - slot.start);
    while (pointer < merged.length && (merged[pointer] as Interval).end <= slot.start) pointer++;
    let covered = 0;
    for (let k = pointer; k < merged.length && (merged[k] as Interval).start < slot.end; k++) {
      const part = clip(merged[k] as Interval, slot);
      if (part) covered += part.end - part.start;
    }
    (off[weekday] as number[])[hour] = ((off[weekday] as number[])[hour] ?? 0) + covered;
  }
  const share = off.map((row, d) =>
    row.map((value, h) => {
      const all = (total[d] as number[])[h] ?? 0;
      return all > 0 ? value / all : null;
    }),
  );
  return { offMs: off, totalMs: total, share };
}

// ───────────────────────── schedule changes ─────────────────────────

export type ScheduleSnapshot = {
  /** Day the schedule is for (YYYY-MM-DD). */
  date: string;
  fetchedAt: number;
  status: ScheduleStatus;
  /** Anything that changes when the schedule changes (status + slots). */
  signature: string;
};

export type ScheduleDayStats = {
  date: string;
  /** Distinct consecutive versions seen. */
  versions: number;
  /** Changes after the first published version (incl. switching to emergency). */
  changesAfterPublish: number;
  firstPublishedAt: number | null;
  /** How long before the day started it was first published (negative = after midnight). */
  publishLeadMs: number | null;
  finalStatus: ScheduleStatus;
  hadEmergency: boolean;
};

export function scheduleChangeStats(
  snapshots: readonly ScheduleSnapshot[],
  options: { tz: string },
): {
  days: ScheduleDayStats[];
  totals: {
    days: number;
    publishedDays: number;
    changedDays: number;
    totalChanges: number;
    emergencyDays: number;
    medianPublishLeadMs: number | null;
  };
} {
  const byDate = new Map<string, ScheduleSnapshot[]>();
  for (const s of snapshots) {
    const list = byDate.get(s.date) ?? [];
    list.push(s);
    byDate.set(s.date, list);
  }
  const days: ScheduleDayStats[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => {
      const ordered = [...list].sort((a, b) => a.fetchedAt - b.fetchedAt);
      const versions = ordered.filter(
        (s, i) => i === 0 || s.signature !== (ordered[i - 1] as ScheduleSnapshot).signature,
      );
      const firstPublished = versions.findIndex((s) => isPublishedSchedule(s.status));
      const firstPublishedAt =
        firstPublished >= 0 ? (versions[firstPublished] as ScheduleSnapshot).fetchedAt : null;
      return {
        date,
        versions: versions.length,
        changesAfterPublish: firstPublished >= 0 ? versions.length - 1 - firstPublished : 0,
        firstPublishedAt,
        publishLeadMs:
          firstPublishedAt === null ? null : localMidnight(date, options.tz) - firstPublishedAt,
        finalStatus: (versions.at(-1) as ScheduleSnapshot).status,
        hadEmergency: versions.some((s) => s.status === "EmergencyShutdowns"),
      };
    });
  const leads = days
    .map((d) => d.publishLeadMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const median =
    leads.length === 0
      ? null
      : leads.length % 2
        ? (leads[(leads.length - 1) / 2] as number)
        : ((leads[leads.length / 2 - 1] as number) + (leads[leads.length / 2] as number)) / 2;
  return {
    days,
    totals: {
      days: days.length,
      publishedDays: days.filter((d) => d.firstPublishedAt !== null).length,
      changedDays: days.filter((d) => d.changesAfterPublish > 0).length,
      totalChanges: days.reduce((s, d) => s + d.changesAfterPublish, 0),
      emergencyDays: days.filter((d) => d.hadEmergency).length,
      medianPublishLeadMs: median,
    },
  };
}

// ───────────────────────── voltage ─────────────────────────

export type VoltageSample = { t: number; voltage: number };

/** EN 50160: 230 V ± 10 %. */
export const VOLTAGE_LOW = 207;
export const VOLTAGE_HIGH = 253;

export type VoltageStats = {
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  below: number;
  above: number;
  belowShare: number;
  aboveShare: number;
};

export function voltageSummary(
  samples: readonly VoltageSample[],
  limits: { low?: number; high?: number } = {},
): VoltageStats {
  const low = limits.low ?? VOLTAGE_LOW;
  const high = limits.high ?? VOLTAGE_HIGH;
  const values = samples.map((s) => s.voltage);
  const below = values.filter((v) => v < low).length;
  const above = values.filter((v) => v > high).length;
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    avg: values.length ? values.reduce((s, v) => s + v, 0) / values.length : null,
    below,
    above,
    belowShare: values.length ? below / values.length : 0,
    aboveShare: values.length ? above / values.length : 0,
  };
}

export type VoltageBucket = Bucket & { count: number; min: number; max: number; avg: number };

/** Min / max / average per hour, day, week or month (empty buckets are omitted). */
export function voltageRollup(
  samples: readonly VoltageSample[],
  options: { range: Interval; tz: string; granularity: "hour" | Granularity },
): VoltageBucket[] {
  const inRange = samples
    .filter((s) => s.t >= options.range.start && s.t < options.range.end)
    .sort((a, b) => a.t - b.t);
  const buckets: Bucket[] =
    options.granularity === "hour"
      ? hourBuckets(options.range, options.tz)
      : calendarBuckets(options.range, options.tz, options.granularity);
  const result: VoltageBucket[] = [];
  let i = 0;
  for (const bucket of buckets) {
    const values: number[] = [];
    while (i < inRange.length && (inRange[i] as VoltageSample).t < bucket.end) {
      if ((inRange[i] as VoltageSample).t >= bucket.start)
        values.push((inRange[i] as VoltageSample).voltage);
      i++;
    }
    if (values.length === 0) continue;
    result.push({
      ...bucket,
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((s, v) => s + v, 0) / values.length,
    });
  }
  return result;
}

function hourBuckets(range: Interval, tz: string): Bucket[] {
  const buckets: Bucket[] = [];
  for (let t = Math.floor(range.start / HOUR) * HOUR; t < range.end; t += HOUR) {
    const slot = clip({ start: t, end: t + HOUR }, range);
    if (!slot) continue;
    const z = toZoned(slot.start, tz);
    buckets.push({ key: `${z.year}-${pad2(z.month)}-${pad2(z.day)} ${pad2(z.hour)}:00`, ...slot });
  }
  return buckets;
}
