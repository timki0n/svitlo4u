import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KYIV_TZ, parseDay, zonedToEpoch } from "@svitlo/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Core, startCore } from "../app.ts";
import { OPENAPI_PATH, renderOpenApi } from "../cli/openapi.ts";
import { loadConfig } from "../config.ts";
import { ManualClock } from "../runtime/clock.ts";
import { routes } from "./contract.ts";

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return zonedToEpoch(date, h * 60 + m, KYIV_TZ);
};
const NOW = at("2026-11-10", "13:00");

const slot = (from: string, to: string) => {
  const minutes = (t: string) => {
    const [h, m] = t.split(":").map(Number) as [number, number];
    return h * 60 + m;
  };
  return { start: minutes(from), end: minutes(to), type: "Definite" };
};
const yasnoDay = (date: string, slots: ReturnType<typeof slot>[]) => ({
  slots,
  date: `${date}T00:00:00+02:00`,
  status: "ScheduleApplies",
});
// Today 08–12 and 20–24, tomorrow 00–02 and 10–14: the evening window crosses midnight.
const YASNO = JSON.stringify({
  "12.1": {
    today: yasnoDay("2026-11-10", [slot("08:00", "12:00"), slot("20:00", "24:00")]),
    tomorrow: yasnoDay("2026-11-11", [slot("00:00", "02:00"), slot("10:00", "14:00")]),
    updatedOn: "2026-11-09T18:00:00+00:00",
  },
});
const fakeYasno = async () =>
  new Response(YASNO, { status: 200, headers: { "content-type": "application/json" } });

const SITES = `
sites:
  - id: 4u
    name: ЖК 4U
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
      - { id: esp-4u, kind: esp, transport: udp, secretEnv: ESP_4U_SECRET }
      - { id: 4u-plug, kind: plug, zigbeeName: 4u-plug }
`;

let dir: string;
let core: Core | null = null;
let clock: ManualClock;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "svitlo-api-"));
  clock = new ManualClock(NOW);
});
afterEach(async () => {
  await core?.stop();
  core = null;
  rmSync(dir, { recursive: true, force: true });
});

async function start(env: Record<string, string> = {}) {
  writeFileSync(join(dir, "sites.yaml"), SITES);
  core = await startCore(
    {
      ...loadConfig({ LOG_LEVEL: "silent", ...env }),
      dbPath: join(dir, "core.db"),
      sitesPath: join(dir, "sites.yaml"),
      udpPort: 0,
    },
    { clock, env: { ESP_4U_SECRET: "s" }, fetch: fakeYasno, listen: false, strictApi: true },
  );
  const c = core;
  for (let i = 0; i < 200 && !c.state.get("4u").schedule; i++)
    await new Promise((r) => setTimeout(r, 5));
  expect(c.state.get("4u").schedule).not.toBeNull();
  return c;
}

function outage(c: Core, start: number, end: number, falseAlarm = false) {
  const power = (state: "on" | "off", t: number) =>
    c.store.power.record(
      "4u",
      { type: "power", state, at: t, detectedAt: t, reason: "probe-timeout", approximate: false },
      t,
    );
  power("off", start);
  if (falseAlarm) {
    c.store.power.record(
      "4u",
      { type: "false-alarm", outageStartedAt: start, detectedAt: end },
      end,
    );
  } else {
    power("on", end);
  }
}

/** History: three days of outages and schedules, a false alarm and some voltage readings. */
function seed(c: Core) {
  const day = (date: string) =>
    parseDay({ ...yasnoDay(date, [slot("08:00", "12:00"), slot("20:00", "24:00")]) });
  for (const date of ["2026-11-08", "2026-11-09"]) {
    c.store.schedules.saveIfChanged("4u", date, day(date), at(date, "00:00") - 3_600_000);
  }
  outage(c, at("2026-11-08", "08:10"), at("2026-11-08", "11:50"));
  outage(c, at("2026-11-09", "05:00"), at("2026-11-09", "05:01"), true);
  outage(c, at("2026-11-09", "20:00"), at("2026-11-09", "23:30"));
  outage(c, at("2026-11-10", "08:05"), at("2026-11-10", "12:10"));
  c.store.voltage.add("4u", [
    { t: at("2026-11-09", "10:00"), voltage: 228 },
    { t: at("2026-11-09", "10:30"), voltage: 204 },
    { t: at("2026-11-10", "12:30"), voltage: 231 },
  ]);
  c.state.update("4u", { power: "on", since: at("2026-11-10", "12:10") });
}

const get = async (c: Core, url: string, headers: Record<string, string> = {}) => {
  const response = await c.app.inject({ method: "GET", url, headers });
  return { status: response.statusCode, headers: response.headers, body: response.json() };
};

describe("API v1", () => {
  it("lists sites; every response is no-store", async () => {
    const c = await start();
    const r = await get(c, "/api/v1/sites");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toEqual({
      sites: [{ id: "4u", name: "ЖК 4U", tz: "Europe/Kyiv", yasnoGroup: "12.1", hasPlug: true }],
    });
  });

  it("unknown site → 404, bad query → 400 (also no-store)", async () => {
    const c = await start();
    const missing = await get(c, "/api/v1/sites/nope/state");
    expect(missing).toMatchObject({ status: 404, body: { error: "unknown_site" } });
    expect(missing.headers["cache-control"]).toBe("no-store");
    expect((await get(c, "/api/v1/sites/4u/schedule?date=10.11.2026")).status).toBe(400);
    const reversed = await get(c, "/api/v1/sites/4u/outages?from=2026-11-10&to=2026-11-01");
    expect(reversed).toMatchObject({ status: 400, body: { error: "invalid_range" } });
    const tooLong = await get(c, "/api/v1/sites/4u/outages?from=2024-01-01&to=2026-11-10");
    expect(tooLong.status).toBe(400);
  });

  it("state: power, plan hint as plain text and the next planned change", async () => {
    const c = await start();
    seed(c);
    const { body } = await get(c, "/api/v1/sites/4u/state");
    expect(body).toMatchObject({
      siteId: "4u",
      now: NOW,
      power: "on",
      since: at("2026-11-10", "12:10"),
      next: { kind: "outage", at: at("2026-11-10", "20:00"), label: "Відключення о 20:00" },
      schedule: { updatedOn: "2026-11-09T18:00:00+00:00" },
    });
    expect(body.hint.text).toBe("Найближче відключення о 20:00");

    clock.advanceTo(at("2026-11-10", "21:00"));
    c.state.update("4u", { power: "off", since: at("2026-11-10", "20:01") });
    const off = (await get(c, "/api/v1/sites/4u/state")).body;
    // The evening window runs on into tomorrow's 00–02 slot.
    expect(off.next).toEqual({
      kind: "restore",
      at: at("2026-11-11", "02:00"),
      label: "Світло за графіком завтра о 02:00",
    });
    expect(off.hint.html).toContain("<a href=");
    expect(off.hint.text).not.toContain("<");
  });

  it("widget: ready labels, a 48-hour timeline split by day, real outages and refresh time", async () => {
    const c = await start();
    seed(c);
    const { body } = await get(c, "/api/v1/sites/4u/widget");
    expect(body).toMatchObject({
      title: "Світло є",
      subtitle: "уже 50 хв.",
      hint: "Найближче відключення о 20:00",
      next: { kind: "outage", label: "Відключення о 20:00" },
      refreshAt: NOW + 15 * 60_000,
    });
    const days = body.timeline.days as {
      label: string;
      segments: { kind: string; label: string }[];
    }[];
    expect(days.map((d) => d.label)).toEqual(["Сьогодні, 10.11", "Завтра, 11.11"]);
    expect(days[0]?.segments.map((s) => `${s.kind} ${s.label}`)).toEqual([
      "on 00:00–08:00",
      "off 08:00–12:00",
      "on 12:00–20:00",
      "off 20:00–24:00",
    ]);
    expect(days[1]?.segments.map((s) => `${s.kind} ${s.label}`)).toEqual([
      "off 00:00–02:00",
      "on 02:00–10:00",
      "off 10:00–14:00",
      "on 14:00–24:00",
    ]);
    expect(body.timeline.actual).toEqual([
      { start: at("2026-11-10", "08:05"), end: at("2026-11-10", "12:10") },
    ]);

    clock.advanceTo(at("2026-11-10", "19:50"));
    expect((await get(c, "/api/v1/sites/4u/widget")).body.refreshAt).toBe(
      at("2026-11-10", "20:00"),
    );
  });

  it("schedule of a day: live for today and tomorrow, history for the past", async () => {
    const c = await start();
    seed(c);
    const today = (await get(c, "/api/v1/sites/4u/schedule")).body;
    expect(today).toMatchObject({ date: "2026-11-10", source: "live", status: "ScheduleApplies" });
    expect(today.outages.map((o: { label: string }) => o.label)).toEqual([
      "08:00–12:00",
      "20:00–24:00",
    ]);
    const tomorrow = (await get(c, "/api/v1/sites/4u/schedule?date=2026-11-11")).body;
    expect(tomorrow.outages.map((o: { label: string }) => o.label)).toEqual([
      "00:00–02:00",
      "10:00–14:00",
    ]);
    expect((await get(c, "/api/v1/sites/4u/schedule?date=2026-11-08")).body).toMatchObject({
      source: "history",
      outages: [{ label: "08:00–12:00" }, { label: "20:00–24:00" }],
    });
    expect((await get(c, "/api/v1/sites/4u/schedule?date=2025-01-01")).body).toMatchObject({
      source: "none",
      status: "Unknown",
      outages: [],
    });
  });

  it("outages and summary exclude false alarms", async () => {
    const c = await start();
    seed(c);
    const range = "from=2026-11-08&to=2026-11-10";
    const { body } = await get(c, `/api/v1/sites/4u/outages?${range}`);
    expect(body.range).toEqual({
      start: at("2026-11-08", "00:00"),
      end: at("2026-11-11", "00:00"),
    });
    expect(body.outages.map((o: { durationMs: number }) => o.durationMs / 60_000)).toEqual([
      220, 210, 245,
    ]);
    const summary = (await get(c, `/api/v1/sites/4u/analytics/summary?${range}`)).body;
    expect(summary).toMatchObject({ outages: 3, offMs: (220 + 210 + 245) * 60_000 });
  });

  it("daily buckets, heatmap, plan vs fact, voltage and schedule changes", async () => {
    const c = await start();
    seed(c);
    const range = "from=2026-11-08&to=2026-11-10";
    const daily = (await get(c, `/api/v1/sites/4u/analytics/daily?${range}`)).body;
    expect(daily.buckets.map((b: { key: string; outages: number }) => [b.key, b.outages])).toEqual([
      ["2026-11-08", 1],
      ["2026-11-09", 1],
      ["2026-11-10", 1],
    ]);
    const weekly = (await get(c, `/api/v1/sites/4u/analytics/daily?${range}&granularity=week`))
      .body;
    expect(weekly.buckets.map((b: { key: string }) => b.key)).toEqual(["2026-W45", "2026-W46"]);

    for (const source of ["actual", "planned"]) {
      const heatmap = (await get(c, `/api/v1/sites/4u/analytics/heatmap?${range}&source=${source}`))
        .body;
      expect(heatmap.offMs).toHaveLength(7);
      expect(heatmap.offMs[0]).toHaveLength(24);
    }

    const pvf = (await get(c, `/api/v1/sites/4u/analytics/plan-vs-fact?${range}`)).body;
    expect(pvf.totals).toMatchObject({ windows: 5, executedWindows: 3 });
    expect(pvf.matches[0]).toMatchObject({
      plan: { start: at("2026-11-08", "08:00"), end: at("2026-11-08", "12:00") },
      startDeviationMs: 10 * 60_000,
      endDeviationMs: -10 * 60_000,
    });

    const voltage = (await get(c, `/api/v1/sites/4u/analytics/voltage?${range}`)).body;
    expect(voltage.summary).toMatchObject({ count: 3, min: 204, max: 231, below: 1 });
    expect(voltage.buckets.map((b: { key: string }) => b.key)).toEqual([
      "2026-11-09",
      "2026-11-10",
    ]);
    const hourly = await get(
      c,
      "/api/v1/sites/4u/analytics/voltage?from=2026-09-01&to=2026-11-10&granularity=hour",
    );
    expect(hourly.status).toBe(400);

    const changes = (await get(c, `/api/v1/sites/4u/analytics/schedule-changes?${range}`)).body;
    expect(changes.days.map((d: { date: string }) => d.date)).toEqual([
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
    ]);
  });

  it("rate limit per client address (CF-Connecting-IP behind the tunnel)", async () => {
    const c = await start({ API_RATE_PER_MINUTE: "2" }); // burst 1, then 1 per 30 s
    const ip = (address: string) => ({ "cf-connecting-ip": address });
    expect((await get(c, "/api/v1/sites", ip("198.51.100.1"))).status).toBe(200);
    const limited = await get(c, "/api/v1/sites", ip("198.51.100.1"));
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("30");
    expect((await get(c, "/api/v1/sites", ip("198.51.100.2"))).status).toBe(200);
    expect((await c.app.inject({ url: "/health" })).statusCode).toBe(200); // not limited
    clock.advanceBy(30_000);
    expect((await get(c, "/api/v1/sites", ip("198.51.100.1"))).status).toBe(200);
  });

  it("serves the OpenAPI document, and docs/openapi.json matches the contract", async () => {
    const c = await start();
    const served = (await get(c, "/api/v1/openapi.json")).body;
    expect(served).toEqual(JSON.parse(renderOpenApi()));
    expect(Object.keys(served.paths)).toEqual(Object.values(routes).map((r) => r.path));
    // Regenerate with: pnpm --filter @svitlo/core openapi
    expect(readFileSync(OPENAPI_PATH, "utf8")).toBe(renderOpenApi());
  });
});
