import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DetectorEffect,
  initialDetectorState,
  KYIV_TZ,
  outageSummary,
  parseDay,
  persistDetector,
} from "@svitlo/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupTo,
  closeDatabase,
  createStore,
  type Db,
  importLegacyDatabase,
  openDatabase,
  type Store,
  verifyBackup,
} from "../src/index.ts";

const T0 = Date.UTC(2026, 10, 10, 6, 0, 0); // 08:00 Kyiv
const min = (m: number) => T0 + m * 60_000;
const SITE = "4u";

let db: Db;
let store: Store;

beforeEach(() => {
  db = openDatabase(":memory:");
  store = createStore(db);
  store.sites.upsert({
    id: SITE,
    name: "ЖК 4U",
    tz: KYIV_TZ,
    yasnoRegion: 25,
    yasnoDso: 902,
    yasnoGroup: "12.1",
  });
});
afterEach(() => closeDatabase(db));

const power = (
  state: "on" | "off",
  at: number,
  detectedAt = at,
  approximate = false,
): DetectorEffect => ({
  type: "power",
  state,
  at,
  detectedAt,
  reason: state === "off" ? "probe-timeout" : "esp-reboot",
  approximate,
});

describe("database", () => {
  it("migrates and enables WAL + foreign keys on a file database", () => {
    const dir = mkdtempSync(join(tmpdir(), "svitlo-db-"));
    try {
      const file = openDatabase(join(dir, "a.db"));
      expect(file.$client.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(file.$client.pragma("foreign_keys", { simple: true })).toBe(1);
      closeDatabase(file);
      // Re-opening runs migrations again without changes.
      closeDatabase(openDatabase(join(dir, "a.db")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects rows for unknown sites", () => {
    expect(() => store.reminders.claim("nope", "k")).toThrow(/FOREIGN KEY/);
  });
});

describe("detector state and power events", () => {
  it("persists detector state", () => {
    const state = persistDetector({ ...initialDetectorState(T0), power: "on", since: min(-60) });
    store.detector.save(SITE, state, T0);
    expect(store.detector.load(SITE)).toEqual(state);
    expect(store.detector.load("other")).toBeNull();
  });

  it("off/on effects open and close an outage; repeated off is ignored", () => {
    store.power.record(SITE, power("off", min(0), min(0.15)));
    store.power.record(SITE, power("off", min(0), min(0.2)));
    expect(store.outages.open(SITE)?.start).toBe(min(0));
    store.power.record(SITE, power("on", min(90)));
    expect(store.outages.open(SITE)).toBeNull();
    expect(store.outages.list(SITE, { start: min(-60), end: min(600) })).toEqual([
      { start: min(0), end: min(90), falseAlarm: false },
    ]);
    expect(store.power.events(SITE, { start: min(-60), end: min(600) }).map((e) => e.type)).toEqual(
      ["off", "off", "on"],
    );
  });

  it("a false alarm closes and flags the outage so statistics skip it", () => {
    store.power.record(SITE, power("off", min(0), min(0.33)));
    store.power.record(SITE, {
      type: "false-alarm",
      outageStartedAt: min(0),
      detectedAt: min(0.4),
    });
    const [row] = store.outages.list(SITE, { start: min(-1), end: min(10) });
    expect(row).toEqual({ start: min(0), end: min(0.4), falseAlarm: true });
    expect(
      outageSummary(store.outages.list(SITE, { start: min(-1), end: min(10) }), {
        range: { start: min(-1), end: min(10) },
        now: min(10),
      }).offMs,
    ).toBe(0);
  });

  it("blips and network gaps are logged, probes are not", () => {
    store.power.record(SITE, { type: "blip", from: min(1), to: min(1.05) });
    store.power.record(SITE, {
      type: "network-gap",
      from: min(2),
      to: min(2.2),
      confirmedBy: "zigbee",
    });
    store.power.record(SITE, { type: "probe", t: min(3), purpose: "keepalive" });
    const events = store.power.events(SITE, { start: min(0), end: min(10) });
    expect(events.map((e) => [e.type, e.at, e.until])).toEqual([
      ["blip", min(1), min(1.05)],
      ["network-gap", min(2), min(2.2)],
    ]);
    expect(store.outages.list(SITE, { start: min(0), end: min(10) })).toEqual([]);
  });

  it("outages overlapping the range, including ongoing ones", () => {
    store.power.record(SITE, power("off", min(-120)));
    store.power.record(SITE, power("on", min(-30)));
    store.power.record(SITE, power("off", min(30)));
    expect(store.outages.list(SITE, { start: min(-60), end: min(60) })).toEqual([
      { start: min(-120), end: min(-30), falseAlarm: false },
      { start: min(30), end: null, falseAlarm: false },
    ]);
    expect(store.outages.list(SITE, { start: min(-20), end: min(20) })).toEqual([]);
  });
});

describe("schedule snapshots", () => {
  const day = (status: string, slots: [number, number, string][]) => ({
    ...parseDay({
      date: "2026-11-11",
      status,
      slots: slots.map(([start, end, type]) => ({ start, end, type })),
    }),
    date: "2026-11-11",
  });
  const A = day("ScheduleApplies", [
    [0, 480, "NotPlanned"],
    [480, 720, "Definite"],
    [720, 1440, "NotPlanned"],
  ]);
  const B = day("ScheduleApplies", [
    [0, 600, "NotPlanned"],
    [600, 720, "Definite"],
    [720, 1440, "NotPlanned"],
  ]);

  it("stores a version only when the schedule changed", () => {
    expect(store.schedules.saveIfChanged(SITE, "2026-11-11", A, min(0))).toBe(true);
    expect(store.schedules.saveIfChanged(SITE, "2026-11-11", A, min(1))).toBe(false);
    expect(store.schedules.saveIfChanged(SITE, "2026-11-11", B, min(2))).toBe(true);
    expect(store.schedules.saveIfChanged(SITE, "2026-11-11", A, min(3))).toBe(true);
    expect(
      store.schedules.versions(SITE, "2026-11-11", "2026-11-11").map((v) => v.fetchedAt),
    ).toEqual([min(0), min(2), min(3)]);
  });

  it("final days give back the latest version as a DaySchedule", () => {
    store.schedules.saveIfChanged(SITE, "2026-11-11", A, min(0));
    store.schedules.saveIfChanged(SITE, "2026-11-11", B, min(2));
    const [final] = store.schedules.finalDays(SITE, "2026-11-10", "2026-11-12");
    expect(final?.date).toBe("2026-11-11");
    expect(final?.day).toEqual(B);
  });

  it("last fixed schedule (R15): the latest ScheduleApplies version of that same day only", () => {
    const emergency = { ...day("EmergencyShutdowns", []), date: "2026-11-11" };
    // Other days never count: 11.11 published straight as emergency has nothing to show.
    store.schedules.saveIfChanged(SITE, "2026-11-10", { ...A, date: "2026-11-10" }, min(0));
    store.schedules.saveIfChanged(SITE, "2026-11-12", { ...A, date: "2026-11-12" }, min(0));
    store.schedules.saveIfChanged(SITE, "2026-11-11", emergency, min(1));
    expect(store.schedules.lastFixed(SITE, "2026-11-11")).toBeNull();

    store.schedules.saveIfChanged(SITE, "2026-11-11", A, min(2));
    store.schedules.saveIfChanged(SITE, "2026-11-11", B, min(3));
    store.schedules.saveIfChanged(SITE, "2026-11-11", emergency, min(4));
    expect(store.schedules.lastFixed(SITE, "2026-11-11")).toEqual({ day: B, fetchedAt: min(3) });
  });
});

describe("voltage, heartbeat, outbox, reminders, subscribers", () => {
  it("voltage bursts are thinned, changes are kept", () => {
    const burst = Array.from({ length: 25 }, (_, i) => ({ t: min(0) + i * 120, voltage: 231 }));
    expect(store.voltage.add(SITE, burst)).toBe(1);
    expect(
      store.voltage.add(SITE, [
        { t: min(0) + 4000, voltage: 229 },
        { t: min(1), voltage: 231 },
      ]),
    ).toBe(2);
    expect(store.voltage.list(SITE, { start: min(-1), end: min(2) }).map((s) => s.voltage)).toEqual(
      [231, 229, 231],
    );
  });

  it("heartbeat minutes accumulate", () => {
    store.heartbeat.addMinute(SITE, "esp-4u", min(0), { packets: 20, maxGapMs: 2100, reboots: 0 });
    store.heartbeat.addMinute(SITE, "esp-4u", min(0), { packets: 9, maxGapMs: 11200, reboots: 1 });
    expect(store.heartbeat.list("esp-4u", { start: min(0), end: min(1) })).toEqual([
      {
        siteId: SITE,
        deviceId: "esp-4u",
        minute: min(0),
        packets: 29,
        maxGapMs: 11200,
        reboots: 1,
      },
    ]);
  });

  it("outbox: dedupe, due order, retry and give up", () => {
    const item = {
      siteId: SITE,
      channel: "telegram",
      target: "-100",
      kind: "power_off",
      payload: { text: "⚠️" },
    };
    const id = store.outbox.enqueue({ ...item, dedupeKey: "off:1" }, min(0));
    expect(id).not.toBeNull();
    expect(store.outbox.enqueue({ ...item, dedupeKey: "off:1" }, min(0))).toBeNull();
    expect(store.outbox.due(min(0)).map((o) => o.id)).toEqual([id]);
    store.outbox.markFailed(id as number, "ETIMEDOUT", min(1));
    expect(store.outbox.due(min(0.5))).toEqual([]);
    expect(store.outbox.due(min(1)).map((o) => o.attempts)).toEqual([1]);
    store.outbox.markFailed(id as number, "403 Forbidden", null);
    expect(store.outbox.get(id as number)?.status).toBe("failed");
    const ok = store.outbox.enqueue(item, min(2)) as number;
    store.outbox.markSent(ok, min(2));
    expect(store.outbox.get(ok)?.status).toBe("sent");
  });

  it("reminders are claimed once and pruned", () => {
    expect(store.reminders.claim(SITE, "outage:2026-11-10T21:00:10", min(0))).toBe(true);
    expect(store.reminders.claim(SITE, "outage:2026-11-10T21:00:10", min(1))).toBe(false);
    expect(store.reminders.prune(min(5))).toBe(1);
  });

  it("push subscriptions and telegram subscribers", () => {
    store.push.upsert(
      {
        endpoint: "https://push/1",
        siteId: SITE,
        p256dh: "k",
        auth: "a",
        preferences: { actualEvents: true },
      },
      min(0),
    );
    store.push.upsert(
      {
        endpoint: "https://push/1",
        siteId: SITE,
        p256dh: "k2",
        auth: "a",
        preferences: { actualEvents: false },
      },
      min(1),
    );
    expect(store.push.list(SITE).map((s) => [s.p256dh, s.preferences, s.createdAt])).toEqual([
      ["k2", { actualEvents: false }, min(0)],
    ]);
    expect(store.push.remove("https://push/1")).toBe(true);
    expect(store.telegram.subscribe(SITE, 123)).toBe(true);
    expect(store.telegram.subscribe(SITE, 123)).toBe(false);
    expect(store.telegram.unsubscribe(SITE, 123)).toBe(true);
  });
});

describe("legacy import", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "svitlo-legacy-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function legacyDb(name: string, withSubscribers: boolean) {
    const path = join(dir, name);
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE outages (id INTEGER PRIMARY KEY AUTOINCREMENT, start_ts REAL NOT NULL, end_ts REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
      CREATE TABLE schedules (schedule_date TEXT PRIMARY KEY, status TEXT, outages_json TEXT, slots_json TEXT, updated_at REAL NOT NULL);
    `);
    if (withSubscribers) {
      legacy.exec(
        "CREATE TABLE subscribers (chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, PRIMARY KEY (chat_id, thread_id));",
      );
    }
    return { path, legacy };
  }

  it("svitlo.db: closed outages and minute slots; open outage skipped; idempotent", () => {
    const { path, legacy } = legacyDb("svitlo.db", false);
    const ins = legacy.prepare(
      "INSERT INTO outages (start_ts, end_ts, created_at, updated_at) VALUES (?, ?, 0, 0)",
    );
    ins.run(T0 / 1000, T0 / 1000 + 3600.5);
    ins.run(T0 / 1000 + 86400, null);
    legacy.prepare("INSERT INTO schedules VALUES (?, ?, '[]', ?, ?)").run(
      "2026-11-11",
      "ScheduleApplies",
      JSON.stringify([
        { start_min: 0, end_min: 480, type: "NotPlanned" },
        { start_min: 480, end_min: 720, type: "Definite" },
      ]),
      T0 / 1000,
    );
    legacy.close();

    const first = importLegacyDatabase(store, { siteId: SITE, path, format: "svitlo", now: T0 });
    expect(first).toEqual({
      outages: { imported: 1, existing: 0, open: 1 },
      adoptedOpenStart: null,
      schedules: { imported: 1, unchanged: 0 },
      subscribers: { imported: 0, existing: 0 },
    });
    const again = importLegacyDatabase(store, { siteId: SITE, path, format: "svitlo", now: T0 });
    expect(again.outages).toEqual({ imported: 0, existing: 1, open: 1 });
    expect(again.schedules).toEqual({ imported: 0, unchanged: 1 });
    expect(store.outages.list(SITE, { start: 0, end: T0 * 2 })).toEqual([
      { start: T0, end: T0 + 3_600_500, falseAlarm: false },
    ]);
    expect(store.schedules.finalDays(SITE, "2026-11-11", "2026-11-11")[0]?.day.slots[1]).toEqual({
      start: 480,
      end: 720,
      type: "Definite",
    });
  });

  it("switch-over while power is off: --adopt-open continues the legacy outage", () => {
    const { path, legacy } = legacyDb("svitlo.db", false);
    const ins = legacy.prepare(
      "INSERT INTO outages (start_ts, end_ts, created_at, updated_at) VALUES (?, ?, 0, 0)",
    );
    ins.run(T0 / 1000 - 7200, T0 / 1000 - 3600);
    ins.run(T0 / 1000, null); // still going on
    legacy.close();

    const report = importLegacyDatabase(store, {
      siteId: SITE,
      path,
      format: "svitlo",
      now: T0 + 60_000,
      adoptOpen: true,
    });
    expect(report.adoptedOpenStart).toBe(T0);
    expect(store.outages.open(SITE)).toMatchObject({ start: T0, end: null });
    expect(store.detector.load(SITE)).toEqual({
      power: "off",
      since: T0,
      onSinceBeforeOutage: T0 - 3_600_000,
      unverifiedOutage: null,
      lastEsp: null,
      lastPowerEvidence: null,
    });
    // The detector already has a state: a second run never overrides it.
    const again = importLegacyDatabase(store, {
      siteId: SITE,
      path,
      format: "svitlo",
      adoptOpen: true,
    });
    expect(again.adoptedOpenStart).toBeNull();
  });

  it("light_bot.db: hour slots, dates with offsets, subscribers", () => {
    store.sites.upsert({
      id: "g6",
      name: "6.1",
      tz: KYIV_TZ,
      yasnoRegion: 25,
      yasnoDso: 902,
      yasnoGroup: "6.1",
    });
    const { path, legacy } = legacyDb("light_bot.db", true);
    legacy.prepare("INSERT INTO schedules VALUES (?, ?, '[]', ?, ?)").run(
      "2026-02-08T00:00:00+02:00",
      "ScheduleApplies",
      JSON.stringify([
        { start_hour: 0, end_hour: 8, type: "Definite" },
        { start_hour: 8, end_hour: 20.5, type: "NotPlanned" },
        { start_hour: 20.5, end_hour: 24, type: "Definite" },
      ]),
      T0 / 1000,
    );
    legacy.prepare("INSERT INTO subscribers VALUES (?, 0, ?)").run(555, T0 / 1000);
    legacy.close();

    const report = importLegacyDatabase(store, {
      siteId: "g6",
      path,
      format: "light_bot",
      now: T0,
    });
    expect(report.schedules.imported).toBe(1);
    expect(report.subscribers.imported).toBe(1);
    const [final] = store.schedules.finalDays("g6", "2026-02-08", "2026-02-08");
    expect(final?.day.slots).toEqual([
      { start: 0, end: 480, type: "Definite" },
      { start: 480, end: 1230, type: "NotPlanned" },
      { start: 1230, end: 1440, type: "Definite" },
    ]);
    expect(store.telegram.list("g6").map((s) => s.chatId)).toEqual([555]);
  });
});

describe("backup", () => {
  it("VACUUM INTO produces a consistent copy that verifies and restores", () => {
    const dir = mkdtempSync(join(tmpdir(), "svitlo-backup-"));
    try {
      const live = openDatabase(join(dir, "live.db"));
      const liveStore = createStore(live);
      liveStore.sites.upsert({
        id: SITE,
        name: "ЖК 4U",
        tz: KYIV_TZ,
        yasnoRegion: 25,
        yasnoDso: 902,
        yasnoGroup: "12.1",
      });
      liveStore.power.record(SITE, power("off", min(0)));
      liveStore.power.record(SITE, power("on", min(60)));
      backupTo(live, join(dir, "backup.db"));
      closeDatabase(live);

      const check = verifyBackup(join(dir, "backup.db"));
      expect(check.ok).toBe(true);
      expect(check.counts).toMatchObject({ sites: 1, outages: 1, power_events: 2 });

      // Restoring = opening the copy as the live database.
      const restored = openDatabase(join(dir, "backup.db"));
      expect(createStore(restored).outages.list(SITE, { start: 0, end: min(100) })).toHaveLength(1);
      closeDatabase(restored);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
