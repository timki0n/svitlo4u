/**
 * Day status as reported by the Yasno planned-outages API.
 *
 * - ScheduleApplies    — published schedule with outage slots
 * - NoOutages          — published schedule without outages (same as ScheduleApplies with no slots)
 * - WaitingForSchedule — schedule not published yet
 * - EmergencyShutdowns — emergency outages, the schedule does not apply
 * - Unknown            — anything else Yasno may introduce; treated as "no schedule"
 */
export const SCHEDULE_STATUSES = [
  "ScheduleApplies",
  "NoOutages",
  "WaitingForSchedule",
  "EmergencyShutdowns",
  "Unknown",
] as const;

export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

const KNOWN = new Set<string>(SCHEDULE_STATUSES);

export function parseScheduleStatus(raw: unknown): ScheduleStatus {
  return typeof raw === "string" && KNOWN.has(raw) ? (raw as ScheduleStatus) : "Unknown";
}

/** The schedule is known: either slots apply, or there are explicitly no outages. */
export function isPublishedSchedule(status: ScheduleStatus): boolean {
  return status === "ScheduleApplies" || status === "NoOutages";
}
