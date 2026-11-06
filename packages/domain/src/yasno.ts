import { parseScheduleStatus, type ScheduleStatus } from "./schedule-status.ts";
import { isoDatePart, zonedToEpoch } from "./time.ts";

/** Shapes as they come from the Yasno planned-outages API (one group entry). */
export type RawSlot = { start: number; end: number; type?: string | null };
export type RawDay = { date?: string | null; status?: string | null; slots?: RawSlot[] | null };
export type RawGroupBlock = {
  today?: RawDay | null;
  tomorrow?: RawDay | null;
  updatedOn?: string | null;
};

/** A slot in minutes from local midnight, end exclusive. Type: Definite | Possible | NotPlanned | … */
export type Slot = { start: number; end: number; type: string };

export type DaySchedule = {
  /** Calendar date as written by Yasno (YYYY-MM-DD), null when absent. */
  date: string | null;
  status: ScheduleStatus;
  /** Status string exactly as received ("" when absent) — kept for change detection. */
  rawStatus: string;
  slots: Slot[];
};

export type GroupSchedule = {
  today: DaySchedule;
  tomorrow: DaySchedule;
  updatedOn: string | null;
};

export function parseDay(raw: RawDay | null | undefined): DaySchedule {
  const rawStatus = typeof raw?.status === "string" ? raw.status : "";
  return {
    date: isoDatePart(raw?.date ?? null),
    status: parseScheduleStatus(rawStatus),
    rawStatus,
    slots: (raw?.slots ?? []).map((s) => ({ start: s.start, end: s.end, type: s.type ?? "" })),
  };
}

export function parseGroupBlock(raw: RawGroupBlock): GroupSchedule {
  return {
    today: parseDay(raw.today),
    tomorrow: parseDay(raw.tomorrow),
    updatedOn: typeof raw.updatedOn === "string" ? raw.updatedOn : null,
  };
}

export function isOutageSlot(slot: Slot): boolean {
  return slot.type !== "NotPlanned";
}

/** Outage slot as instants. */
export type TimedSlot = { start: number; end: number; type: string };

export function timedOutageSlots(day: DaySchedule, date: string, tz: string): TimedSlot[] {
  return day.slots.filter(isOutageSlot).map((slot) => ({
    start: zonedToEpoch(date, slot.start, tz),
    end: zonedToEpoch(date, slot.end, tz),
    type: slot.type,
  }));
}

/** Parsed day for texts: outages are listed only when the schedule applies. */
export type DayInfo = {
  date: string;
  status: ScheduleStatus;
  rawStatus: string;
  outages: TimedSlot[];
  updatedOn: string | null;
};

export function dayInfo(
  day: DaySchedule,
  fallbackDate: string,
  tz: string,
  updatedOn: string | null = null,
): DayInfo {
  const date = day.date ?? fallbackDate;
  return {
    date,
    status: day.status,
    rawStatus: day.rawStatus,
    outages: day.status === "ScheduleApplies" ? timedOutageSlots(day, date, tz) : [],
    updatedOn,
  };
}

/** NoOutages and ScheduleApplies without outage slots are the same "empty" schedule. */
export function isScheduleWithoutOutages(day: Pick<DaySchedule, "status" | "slots">): boolean {
  if (day.status === "NoOutages") return true;
  if (day.status !== "ScheduleApplies") return false;
  return !day.slots.some(isOutageSlot);
}
