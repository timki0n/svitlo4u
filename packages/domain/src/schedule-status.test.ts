import { describe, expect, it } from "vitest";
import { isPublishedSchedule, parseScheduleStatus } from "./schedule-status.ts";

describe("parseScheduleStatus", () => {
  it.each(["ScheduleApplies", "NoOutages", "WaitingForSchedule", "EmergencyShutdowns"] as const)(
    "keeps known status %s",
    (status) => {
      expect(parseScheduleStatus(status)).toBe(status);
    },
  );

  it.each([undefined, null, "", "SomethingNew", 42])("maps %s to Unknown", (raw) => {
    expect(parseScheduleStatus(raw)).toBe("Unknown");
  });
});

describe("isPublishedSchedule", () => {
  it("treats ScheduleApplies and NoOutages as published", () => {
    expect(isPublishedSchedule("ScheduleApplies")).toBe(true);
    expect(isPublishedSchedule("NoOutages")).toBe(true);
  });

  it("treats waiting, emergency and unknown as not published", () => {
    expect(isPublishedSchedule("WaitingForSchedule")).toBe(false);
    expect(isPublishedSchedule("EmergencyShutdowns")).toBe(false);
    expect(isPublishedSchedule("Unknown")).toBe(false);
  });
});
