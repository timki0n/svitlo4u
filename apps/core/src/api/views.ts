/**
 * Read models of the API and SSE, built from the in-memory state (no Yasno calls) and the DB.
 */
import {
  addDays,
  type DaySchedule,
  dayInfo,
  dayTotals,
  formatDurationLong,
  formatHHMM,
  localDate,
  localMidnight,
  mergeWindows,
  type OutageWindow,
  type PlanContext,
  planWindows,
  type ScheduleStatus,
  windowInProgress,
} from "@svitlo/domain";
import type { Store } from "@svitlo/storage";
import { lastFixedSchedule } from "../services/schedule.ts";
import type { SiteStateStore } from "../services/state.ts";
import { DEFAULT_VOLTAGE_WATCH } from "../services/voltage.ts";
import type { ResponseOf } from "./contract.ts";

type NextChange = NonNullable<ResponseOf<"state">["next"]>;
type Segment = ResponseOf<"widget">["timeline"]["days"][number]["segments"][number];

const MINUTE = 60_000;
const WIDGET_MAX_STALE_MS = 15 * MINUTE;

/** Telegram HTML hint → plain text for widgets. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

export function stateView(state: SiteStateStore, siteId: string, now: number): ResponseOf<"state"> {
  const current = state.get(siteId);
  const plan = state.planTexts(siteId, now);
  const hint = plan ? (current.power === "off" ? plan.restore : plan.outage) : null;
  return {
    siteId,
    now,
    power: current.power,
    since: current.since,
    hint: hint ? { text: plainText(hint), html: hint } : null,
    next: nextChange(state, siteId, now),
    schedule: current.schedule
      ? { updatedOn: current.schedule.updatedOn, fetchedAt: current.schedule.fetchedAt }
      : null,
    voltage:
      current.lastVoltage !== null
        ? {
            value: current.lastVoltage,
            at: current.lastPlugAt,
            level: voltageLevel(current.lastVoltage),
          }
        : null,
    lastEspAt: current.lastEspAt,
  };
}

/** The reading against the alert thresholds (the monitor confirms episodes; this is instant). */
export function voltageLevel(value: number): "normal" | "low" | "high" {
  if (value < DEFAULT_VOLTAGE_WATCH.low) return "low";
  if (value >= DEFAULT_VOLTAGE_WATCH.high) return "high";
  return "normal";
}

/** The next planned change relevant to the current power state. */
export function nextChange(state: SiteStateStore, siteId: string, now: number): NextChange | null {
  const ctx = state.planContext(siteId);
  if (!ctx) return null;
  const { tz } = ctx;
  const power = state.get(siteId).power;
  const windows = planWindows(ctx, now);
  const today = localDate(now, tz);
  const when = (t: number) =>
    `${localDate(t, tz) === addDays(today, 1) ? "завтра " : ""}о ${formatHHMM(t, tz)}`;

  const current = windows.find((w) => w.start <= now && now < w.end);
  if (current && power === "off") {
    return { kind: "restore", at: current.end, label: `Світло за графіком ${when(current.end)}` };
  }
  // R3: with power on, a window with little left counts as over (power often returns early).
  const ongoing = windowInProgress(ctx, now, windows);
  if (ongoing) {
    return {
      kind: "window-in-progress",
      at: ongoing.end,
      label: `За графіком відключення до ${formatHHMM(ongoing.end, tz)}`,
    };
  }
  if (power === "off") return null; // off-schedule: no planned end to promise
  const next = windows.filter((w) => w.start > now).sort((a, b) => a.start - b.start)[0];
  return next ? { kind: "outage", at: next.start, label: `Відключення ${when(next.start)}` } : null;
}

/** The stored schedule for a date as the live state has it (handles the midnight roll-over). */
function liveDay(ctx: PlanContext, date: string, today: string): DaySchedule | null {
  const days = [ctx.yesterday ?? null, ctx.today, ctx.tomorrow].filter(
    (d): d is DaySchedule => d !== null,
  );
  const exact = days.find((d) => d.date === date);
  if (exact) return exact;
  if (date === today && ctx.today.date === null) return ctx.today;
  if (date === addDays(today, 1) && ctx.tomorrow.date === null) return ctx.tomorrow;
  return null;
}

function rangeLabel(start: number, end: number, dayEnd: number, tz: string): string {
  return `${formatHHMM(start, tz)}–${end >= dayEnd ? "24:00" : formatHHMM(end, tz)}`;
}

const UNKNOWN_LABEL: Partial<Record<ScheduleStatus, string>> = {
  WaitingForSchedule: "Графік ще не опубліковано",
  EmergencyShutdowns: "Діють екстрені відключення",
};

/** On/off segments of one day from its outage windows (clipped to the day). */
function planSegments(
  dayStart: number,
  dayEnd: number,
  windows: readonly OutageWindow[],
  tz: string,
): Segment[] {
  const range = (start: number, end: number) => rangeLabel(start, end, dayEnd, tz);
  const offs = windows
    .map((w) => ({ start: Math.max(w.start, dayStart), end: Math.min(w.end, dayEnd) }))
    .filter((w) => w.start < w.end)
    .sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let cursor = dayStart;
  for (const off of offs) {
    if (off.start > cursor)
      segments.push({ start: cursor, end: off.start, kind: "on", label: range(cursor, off.start) });
    segments.push({
      start: off.start,
      end: off.end,
      kind: "off",
      label: range(off.start, off.end),
    });
    cursor = off.end;
  }
  if (cursor < dayEnd)
    segments.push({ start: cursor, end: dayEnd, kind: "on", label: range(cursor, dayEnd) });
  return segments;
}

export function widgetView(
  state: SiteStateStore,
  store: Store,
  siteId: string,
  now: number,
): ResponseOf<"widget"> {
  const site = state.site(siteId);
  const { tz } = site;
  const view = stateView(state, siteId, now);
  const ctx = state.planContext(siteId);
  const today = localDate(now, tz);
  const start = localMidnight(today, tz);
  const end = localMidnight(addDays(today, 2), tz);
  const windows = ctx ? planWindows(ctx, now) : [];
  const records = store.outages
    .list(siteId, { start, end: Math.max(start, now) })
    .filter((o) => !o.falseAlarm);
  /** So far by fact, the rest by the plan (null: no plan applies to the day). */
  const totals = (dayStart: number, dayEnd: number, segments: readonly Segment[] | null) =>
    dayTotals(
      { start: dayStart, end: dayEnd },
      now,
      records,
      segments ? segments.filter((s) => s.kind === "off") : null,
    );

  const days = [today, addDays(today, 1)].map((date, index) => {
    const day = ctx ? liveDay(ctx, date, today) : null;
    const status: ScheduleStatus = day?.status ?? "Unknown";
    const [, m, d] = date.split("-");
    const dayStart = localMidnight(date, tz);
    const dayEnd = localMidnight(addDays(date, 1), tz);
    const base = { date, status, label: `${index === 0 ? "Сьогодні" : "Завтра"}, ${d}.${m}` };
    if (status === "ScheduleApplies" || status === "NoOutages") {
      const own = status === "ScheduleApplies" ? windows : [];
      const segments = planSegments(dayStart, dayEnd, own, tz);
      return {
        ...base,
        overlay: null,
        note: null,
        segments,
        totals: totals(dayStart, dayEnd, segments),
      };
    }
    // R15: emergency shutdowns over the schedule published for this day, if there was one.
    const fixed = status === "EmergencyShutdowns" ? lastFixedSchedule(store, site, date) : null;
    if (fixed) {
      return {
        ...base,
        overlay: "emergency" as const,
        note: "Діють екстрені відключення · графік не діє",
        segments: planSegments(dayStart, dayEnd, mergeWindows(fixed.outages), tz),
        totals: totals(dayStart, dayEnd, null),
      };
    }
    const label = UNKNOWN_LABEL[status] ?? "Графік недоступний";
    return {
      ...base,
      overlay: null,
      note: null,
      segments: [{ start: dayStart, end: dayEnd, kind: "unknown" as const, label }],
      totals: totals(dayStart, dayEnd, null),
    };
  });

  const actual = records.map((o) => ({ start: Math.max(o.start, start), end: o.end }));

  const title =
    view.power === "on" ? "Світло є" : view.power === "off" ? "Світла немає" : "Стан невідомий";
  const subtitle =
    view.power !== "unknown" && view.since !== null
      ? `уже ${formatDurationLong((now - view.since) / 1000)}`
      : null;

  // Re-render at the next planned boundary, and at least every 15 minutes (durations age).
  const boundaries = days
    .flatMap((day) => day.segments.flatMap((s) => [s.start, s.end]))
    .concat(view.next ? [view.next.at] : [])
    .filter((t) => t > now);
  const refreshAt = Math.max(now + MINUTE, Math.min(now + WIDGET_MAX_STALE_MS, ...boundaries));

  return {
    siteId,
    name: site.name,
    now,
    power: view.power,
    since: view.since,
    title,
    subtitle,
    hint: view.hint?.text ?? null,
    next: view.next,
    timeline: { start, end, days, actual },
    refreshAt,
  };
}

export function dayScheduleView(
  state: SiteStateStore,
  store: Store,
  siteId: string,
  date: string,
  now: number,
): ResponseOf<"schedule"> {
  const { tz } = state.site(siteId);
  const ctx = state.planContext(siteId);
  const today = localDate(now, tz);
  const live = ctx ? liveDay(ctx, date, today) : null;
  const stored = live ? null : (store.schedules.finalDays(siteId, date, date)[0]?.day ?? null);
  const day = live ?? stored;
  if (!day) {
    return {
      siteId,
      date,
      source: "none",
      status: "Unknown",
      updatedOn: null,
      outages: [],
      lastFixed: null,
    };
  }
  const updatedOn = live ? (state.get(siteId).schedule?.updatedOn ?? null) : null;
  const dayEnd = localMidnight(addDays(date, 1), tz);
  const labelled = (windows: readonly OutageWindow[]) =>
    mergeWindows(windows).map((w) => ({
      start: w.start,
      end: w.end,
      label: rangeLabel(w.start, w.end, dayEnd, tz),
    }));
  const fixed =
    day.status === "EmergencyShutdowns" ? lastFixedSchedule(store, state.site(siteId), date) : null;
  return {
    siteId,
    date,
    source: live ? "live" : "history",
    status: day.status,
    updatedOn,
    outages: labelled(dayInfo(day, date, tz, updatedOn).outages),
    lastFixed: fixed ? { publishedAt: fixed.publishedAt, outages: labelled(fixed.outages) } : null,
  };
}
