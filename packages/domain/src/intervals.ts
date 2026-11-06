/** Half-open time intervals [start, end) in epoch ms, and calendar buckets in a time zone. */
import { addDays, localDate, localMidnight, toZoned } from "./time.ts";

export type Interval = { start: number; end: number };

export function clip(interval: Interval, range: Interval): Interval | null {
  const start = Math.max(interval.start, range.start);
  const end = Math.min(interval.end, range.end);
  return end > start ? { start, end } : null;
}

/** Sorted, non-overlapping union (touching intervals are joined). */
export function union(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const result: Interval[] = [];
  for (const i of sorted) {
    const last = result.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else result.push({ start: i.start, end: i.end });
  }
  return result;
}

export function totalMs(intervals: readonly Interval[]): number {
  return union(intervals).reduce((sum, i) => sum + (i.end - i.start), 0);
}

/** Total length of the intersection of two interval sets. */
export function overlapMs(a: readonly Interval[], b: readonly Interval[]): number {
  const x = union(a);
  const y = union(b);
  let i = 0;
  let j = 0;
  let total = 0;
  while (i < x.length && j < y.length) {
    const p = x[i] as Interval;
    const q = y[j] as Interval;
    const start = Math.max(p.start, q.start);
    const end = Math.min(p.end, q.end);
    if (end > start) total += end - start;
    if (p.end < q.end) i++;
    else j++;
  }
  return total;
}

/** Parts of `a` not covered by `b`. */
export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const holes = union(b);
  const result: Interval[] = [];
  for (const piece of union(a)) {
    let cursor = piece.start;
    for (const h of holes) {
      if (h.end <= cursor || h.start >= piece.end) continue;
      if (h.start > cursor) result.push({ start: cursor, end: h.start });
      cursor = Math.max(cursor, h.end);
      if (cursor >= piece.end) break;
    }
    if (cursor < piece.end) result.push({ start: cursor, end: piece.end });
  }
  return result;
}

export type Granularity = "day" | "week" | "month";

export type Bucket = {
  /** "2026-11-06" | "2026-W45" | "2026-11" */
  key: string;
  start: number;
  end: number;
};

/** Monday-based ISO week key of a calendar date, e.g. 2025-12-29 → "2026-W01". */
export function isoWeekKey(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d));
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  // The week belongs to the year of its Thursday; week 1 contains that year's first Thursday.
  const thursday = day.getTime() + (3 - weekday) * 86_400_000;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday = 0 … Sunday = 6 for a calendar date. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function bucketStartDate(date: string, granularity: Granularity): string {
  if (granularity === "day") return date;
  if (granularity === "week") return addDays(date, -weekdayOf(date));
  return `${date.slice(0, 7)}-01`;
}

function nextBucketDate(date: string, granularity: Granularity): string {
  if (granularity === "day") return addDays(date, 1);
  if (granularity === "week") return addDays(date, 7);
  const [y, m] = date.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

function bucketKey(date: string, granularity: Granularity): string {
  if (granularity === "day") return date;
  if (granularity === "week") return isoWeekKey(date);
  return date.slice(0, 7);
}

/** Calendar buckets covering `range` (first and last are clipped to it). */
export function calendarBuckets(range: Interval, tz: string, granularity: Granularity): Bucket[] {
  const buckets: Bucket[] = [];
  let date = bucketStartDate(localDate(range.start, tz), granularity);
  while (localMidnight(date, tz) < range.end) {
    const next = nextBucketDate(date, granularity);
    const clipped = clip({ start: localMidnight(date, tz), end: localMidnight(next, tz) }, range);
    if (clipped) buckets.push({ key: bucketKey(date, granularity), ...clipped });
    date = next;
  }
  return buckets;
}

/** Local weekday (Monday = 0) and hour of an instant. */
export function weekdayHour(epochMs: number, tz: string): { weekday: number; hour: number } {
  const z = toZoned(epochMs, tz);
  const date = `${z.year}-${String(z.month).padStart(2, "0")}-${String(z.day).padStart(2, "0")}`;
  return { weekday: weekdayOf(date), hour: z.hour };
}
