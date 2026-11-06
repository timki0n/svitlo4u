/**
 * Time-zone helpers on top of Intl (no dependencies).
 *
 * All domain logic works with absolute instants (epoch milliseconds). Wall-clock values only appear
 * at the edges: Yasno slots are "minutes from local midnight", texts show local HH:MM.
 */

export const KYIV_TZ = "Europe/Kyiv";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, number>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, fmt);
  }
  return fmt;
}

/** UTC offset of `tz` at the given instant, in minutes (e.g. +120 for Kyiv in winter). */
export function offsetMinutes(epochMs: number, tz: string): number {
  // Offsets change on whole UTC hours for the zones we care about, so cache per UTC hour.
  const hour = Math.floor(epochMs / HOUR_MS);
  const key = `${tz}|${hour}`;
  const cached = offsetCache.get(key);
  if (cached !== undefined) return cached;

  const probe = hour * HOUR_MS;
  const parts: Record<string, number> = {};
  for (const part of formatterFor(tz).formatToParts(new Date(probe))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  const offset = Math.round((wall - probe) / MINUTE_MS);
  offsetCache.set(key, offset);
  return offset;
}

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetMinutes: number;
};

export function toZoned(epochMs: number, tz: string): ZonedParts {
  const offset = offsetMinutes(epochMs, tz);
  const wall = new Date(epochMs + offset * MINUTE_MS);
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
    offsetMinutes: offset,
  };
}

/** Calendar date (YYYY-MM-DD) of an ISO-like string, as written (no time-zone conversion). */
export function isoDatePart(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

/** Local calendar date of an instant. */
export function localDate(epochMs: number, tz: string): string {
  const z = toZoned(epochMs, tz);
  return `${z.year}-${pad2(z.month)}-${pad2(z.day)}`;
}

/**
 * Instant of `minutes` after local midnight of `date` (minutes may be 1440 = next midnight).
 * Non-existent or ambiguous wall times resolve like Python's fold=0: the offset before the transition.
 */
export function zonedToEpoch(date: string, minutes: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) + minutes * MINUTE_MS;
  const before = offsetMinutes(wall - 15 * HOUR_MS, tz);
  const after = offsetMinutes(wall + 15 * HOUR_MS, tz);
  const tBefore = wall - before * MINUTE_MS;
  const tAfter = wall - after * MINUTE_MS;
  const validBefore = offsetMinutes(tBefore, tz) === before;
  const validAfter = offsetMinutes(tAfter, tz) === after;
  if (validBefore && validAfter) return Math.min(tBefore, tAfter);
  if (validBefore) return tBefore;
  if (validAfter) return tAfter;
  return tBefore; // gap: fold=0 uses the pre-transition offset
}

export function localMidnight(date: string, tz: string): number {
  return zonedToEpoch(date, 0, tz);
}

/** "HH:MM" in local time. */
export function formatHHMM(epochMs: number, tz: string): string {
  const z = toZoned(epochMs, tz);
  return `${pad2(z.hour)}:${pad2(z.minute)}`;
}

/** Python-style isoformat with offset: 2026-11-10T21:00:00+02:00 (seconds precision). */
export function formatIsoOffset(epochMs: number, tz: string): string {
  const z = toZoned(epochMs, tz);
  const sign = z.offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(z.offsetMinutes);
  return (
    `${z.year}-${pad2(z.month)}-${pad2(z.day)}T${pad2(z.hour)}:${pad2(z.minute)}:${pad2(z.second)}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** True when the local day has a DST transition (its length is not 24 h). */
export function isTransitionDay(date: string, tz: string): boolean {
  return localMidnight(addDays(date, 1), tz) - localMidnight(date, tz) !== 24 * HOUR_MS;
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export const MINUTE = MINUTE_MS;
export const HOUR = HOUR_MS;
