/** Presentation only: times, dates and durations in Ukrainian, in the site's time zone. */

const MINUTE = 60_000;

const timeFormats = new Map<string, Intl.DateTimeFormat>();
const partsFormats = new Map<string, Intl.DateTimeFormat>();

function timeFormat(tz: string): Intl.DateTimeFormat {
  let f = timeFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("uk-UA", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    timeFormats.set(tz, f);
  }
  return f;
}

/** 07:05 */
export function hhmm(t: number, tz: string): string {
  return timeFormat(tz).format(t);
}

/** Local calendar parts of an instant. */
export function zoned(t: number, tz: string): { date: string; weekday: number; minutes: number } {
  let f = partsFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    partsFormats.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday ?? "");
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

/** "2026-11-07" → "Сб, 07.11" */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${WEEKDAYS[weekday]}, ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
}

/** "2026-11-07" → "07.11" */
export function shortDate(date: string): string {
  const [, m, d] = date.split("-");
  return `${d}.${m}`;
}

/** Calendar date arithmetic on "YYYY-MM-DD". */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 3 год 5 хв · 45 хв · 2 год (rounded to whole minutes). */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} хв`;
  return m === 0 ? `${h} год` : `${h} год ${m} хв`;
}

/** Shares that add up to 100 %: [74, 26]. */
export function percents(a: number, b: number): [number, number] {
  const total = a + b;
  if (total <= 0) return [0, 0];
  const pa = Math.round((a / total) * 100);
  return [pa, 100 - pa];
}
