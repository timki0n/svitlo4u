import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scriptFor } from "./install.ts";
import { drawings, FAMILY_SIZES, type Reply, runScript, texts } from "./scriptable-mock.ts";

const source = readFileSync(new URL("./scriptable.js", import.meta.url), "utf8");

const H = 3_600_000;
/** 21.11.2026, 00:00 in Kyiv. */
const DAY = Date.UTC(2026, 10, 20, 22);
const NOW = DAY + 17.75 * H; // 17:45

function seg(from: number, to: number, kind: "on" | "off" | "unknown", label: string) {
  return { start: DAY + from * H, end: DAY + to * H, kind, label };
}

function widgetData() {
  return {
    siteId: "4u",
    name: "ЖК 4U",
    now: NOW,
    power: "on",
    since: DAY + 13 * H + 8 * 60_000,
    title: "Світло є",
    subtitle: "уже 4 год. 37 хв.",
    hint: "Найближче відключення о 19:30",
    next: { kind: "outage", at: DAY + 19.5 * H, label: "Відключення о 19:30" },
    timeline: {
      start: DAY,
      end: DAY + 48 * H,
      days: [
        {
          date: "2026-11-21",
          status: "ScheduleApplies",
          label: "Сьогодні, 21.11",
          overlay: null,
          note: null,
          segments: [
            seg(0, 3.5, "off", "00:00–03:30"),
            seg(3.5, 10.5, "on", "03:30–10:30"),
            seg(10.5, 14.5, "off", "10:30–14:30"),
            seg(14.5, 19.5, "on", "14:30–19:30"),
            seg(19.5, 24, "off", "19:30–24:00"),
          ],
          totals: { past: { onMs: 16.2 * H, offMs: 1.55 * H }, expected: null },
        },
        {
          date: "2026-11-22",
          status: "WaitingForSchedule",
          label: "Завтра, 22.11",
          overlay: null,
          note: null,
          segments: [seg(24, 48, "unknown", "Графік ще не опубліковано")],
          totals: { past: { onMs: 0, offMs: 0 }, expected: null },
        },
      ],
      actual: [{ start: DAY + 11.6 * H, end: DAY + 13 * H + 8 * 60_000 }],
    },
    refreshAt: NOW + 15 * 60_000,
  };
}

const ok =
  (body: unknown = widgetData()) =>
  (): Reply => ({ status: 200, body });

describe("Scriptable widget", () => {
  it("shows the state, the next change, today's strip and tomorrow", async () => {
    const run = await runScript(source, { family: "medium", now: NOW, respond: ok() });
    expect(run.shown).toBe(true);
    expect(run.urls).toEqual(["https://svitlo4u.info/api/v1/sites/4u/widget"]);
    expect(texts(run.widget)).toEqual([
      "Світло є",
      "з 13:08",
      "ЖК 4U",
      "Відключення о 19:30",
      "00",
      "06",
      "12",
      "18",
      "24",
      "●",
      "світло було 16 год. 12 хв.",
      "●",
      "не було 1 год. 33 хв.",
    ]);
    // tomorrow's schedule is not out yet: nothing about tomorrow at all
    const large = await runScript(source, { family: "large", now: NOW, respond: ok() });
    expect(texts(large.widget).join(" ")).not.toMatch(/Завтра|опубліковано/);
    expect(drawings(run.widget)).toHaveLength(1);
    expect(run.widget.url).toBe("https://svitlo4u.info/4u");
    expect(run.widget.refreshAfterDate?.getTime()).toBe(NOW + 15 * 60_000);
  });

  it("draws every size, the lock screen too", async () => {
    for (const family of Object.keys(FAMILY_SIZES)) {
      const run = await runScript(source, { family, now: NOW, respond: ok() });
      expect(run.shown, family).toBe(true);
      // the round one has room for the bulb and the time of the next change only
      const expected = family === "accessoryCircular" ? "19:30" : "Світло є";
      expect(texts(run.widget).join(" "), family).toContain(expected);
    }
    const inline = await runScript(source, {
      family: "accessoryInline",
      now: NOW,
      respond: ok(),
    });
    expect(texts(inline.widget)).toEqual(["Світло є · з 13:08"]);
  });

  it("previews the medium widget when run in the app", async () => {
    const run = await runScript(source, { family: null, now: NOW, respond: ok() });
    expect(run.widget.presented).toBe("medium");
  });

  it("takes the building from the widget's Parameter, as an id or an address", async () => {
    const cases: [string | null, string][] = [
      ["kolasa-27v", "kolasa-27v"],
      ["https://svitlo4u.info/Kolasa-27v#/schedule", "kolasa-27v"],
      ["svitlo4u.info/kolasa-27v/", "kolasa-27v"],
      ["https://svitlo4u.info", "4u"],
      ["  ", "4u"],
      [null, "4u"],
    ];
    for (const [parameter, site] of cases) {
      const run = await runScript(source, { family: "small", parameter, now: NOW, respond: ok() });
      expect(run.urls, String(parameter)).toEqual([
        `https://svitlo4u.info/api/v1/sites/${site}/widget`,
      ]);
    }
  });

  it("says so when the building is unknown", async () => {
    const run = await runScript(source, {
      family: "small",
      parameter: "nope",
      now: NOW,
      respond: () => ({ status: 404, body: { error: "not_found" } }),
    });
    expect(texts(run.widget)).toContain("Будинок не знайдено");
    expect(run.widget.refreshAfterDate?.getTime()).toBe(NOW + 60 * 60_000);
  });

  it("keeps showing the last data without a connection, and says how old it is", async () => {
    const files = new Map<string, string>();
    await runScript(source, { family: "medium", now: NOW, respond: ok(), files });
    const later = NOW + 30 * 60_000;
    const run = await runScript(source, {
      family: "medium",
      now: later,
      respond: () => new Error("The Internet connection appears to be offline."),
      files,
    });
    expect(texts(run.widget)).toContain("дані на 17:45");
    expect(texts(run.widget)).toContain("Відключення о 19:30");
    expect(run.widget.refreshAfterDate?.getTime()).toBe(later + 5 * 60_000);

    // a proxy's error page is no data either
    const proxy = await runScript(source, {
      family: "large",
      now: later,
      respond: () => ({ status: 502, body: "<html>Bad gateway</html>" }),
      files,
    });
    expect(texts(proxy.widget)).toContain("Немає зв'язку · дані на 17:45");

    const never = await runScript(source, {
      family: "small",
      now: NOW,
      respond: () => new Error("offline"),
    });
    expect(texts(never.widget)).toContain("Немає зв'язку");
  });

  it("drops a next change that has already passed", async () => {
    const data = widgetData();
    data.next = { kind: "outage", at: NOW - 60_000, label: "Відключення о 17:44" };
    const run = await runScript(source, { family: "small", now: NOW, respond: ok(data) });
    expect(texts(run.widget)).not.toContain("Відключення о 17:44");
  });

  it("tells since when across midnight", async () => {
    const data = widgetData();
    data.since = DAY - 2 * H; // 22:00 yesterday
    const run = await runScript(source, { family: "small", now: NOW, respond: ok(data) });
    expect(texts(run.widget)).toContain("з учора, 22:00");
    data.since = DAY - 50 * H;
    const older = await runScript(source, { family: "small", now: NOW, respond: ok(data) });
    expect(texts(older.widget)).toContain("з 18.11, 22:00");
  });

  it("marks emergency shutdowns over the last schedule", async () => {
    const data = widgetData();
    Object.assign(data.timeline.days[0] ?? {}, {
      status: "EmergencyShutdowns",
      overlay: "emergency",
    });
    data.next = null as never;
    const run = await runScript(source, { family: "medium", now: NOW, respond: ok(data) });
    expect(texts(run.widget)).toContain("Екстрені відключення");
    expect(drawings(run.widget)[0]).toContain("rgba(255, 107, 87, 0.3)");
  });

  it("lists tomorrow's planned outages", async () => {
    const data = widgetData();
    data.timeline.days[1] = {
      ...(data.timeline.days[1] as (typeof data.timeline.days)[number]),
      status: "ScheduleApplies",
      segments: [
        seg(24, 28, "on", "00:00–04:00"),
        seg(28, 32, "off", "04:00–08:00"),
        seg(32, 48, "on", "08:00–24:00"),
      ],
    };
    const medium = await runScript(source, { family: "medium", now: NOW, respond: ok(data) });
    expect(texts(medium.widget)).toContain("Завтра: 04:00–08:00");
    const large = await runScript(source, { family: "large", now: NOW, respond: ok(data) });
    expect(drawings(large.widget)).toHaveLength(2);
    expect(texts(large.widget)).toContain("світло було 16 год. 12 хв.");
  });
});

describe("scriptFor", () => {
  it("sets the building and the site", () => {
    const script = scriptFor(source, "kolasa-27v", "https://example.test");
    expect(script).toContain('const SITE = "kolasa-27v";');
    expect(script).toContain('const ORIGIN = "https://example.test";');
    expect(script).not.toContain('const SITE = "4u";');
  });

  it("refuses a script whose settings moved", () => {
    expect(() => scriptFor("const SITE = 1;", "4u", "https://svitlo4u.info")).toThrow(/SITE/);
  });
});
