import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { KYIV_TZ, zonedToEpoch } from "@svitlo/domain";
import { closeDatabase, createStore, type Db, openDatabase, verifyBackup } from "@svitlo/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../runtime/clock.ts";
import { type BackupConfig, BackupService, loadBackupConfig } from "./backup.ts";

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return zonedToEpoch(date, h * 60 + m, KYIV_TZ);
};

const CONFIG: BackupConfig = {
  endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
  bucket: "svitlo4u-backups",
  accessKeyId: "test-key-id",
  secretAccessKey: "test-secret",
  prefix: "svitlo4u/",
  time: "03:30",
  tz: KYIV_TZ,
};

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "svitlo-backup-"));
  db = openDatabase(join(dir, "core.db"));
  const store = createStore(db);
  store.sites.upsert({
    id: "4u",
    name: "ЖК 4U",
    tz: KYIV_TZ,
    yasnoRegion: 25,
    yasnoDso: 902,
    yasnoGroup: "12.1",
  });
  const t = at("2026-11-06", "10:00");
  store.power.record("4u", {
    type: "power",
    state: "off",
    at: t,
    detectedAt: t,
    reason: "probe-timeout",
    approximate: false,
  });
});
afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

/** R2 stand-in: records uploads; `fail` makes it answer with an error. */
function fakeR2(fail = false) {
  const uploads: { method: string; url: string; auth: string; type: string; body: Buffer }[] = [];
  const fetch = async (request: Request) => {
    uploads.push({
      method: request.method,
      url: request.url,
      auth: request.headers.get("authorization") ?? "",
      type: request.headers.get("content-type") ?? "",
      body: Buffer.from(await request.arrayBuffer()),
    });
    return fail
      ? new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })
      : new Response(null, { status: 200 });
  };
  return { uploads, fetch };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("nightly backup to R2", () => {
  it("uploads a verified, gzipped copy signed with SigV4", async () => {
    const r2 = fakeR2();
    const clock = new ManualClock(at("2026-11-07", "03:30"));
    const service = new BackupService({ db, config: CONFIG, clock, fetch: r2.fetch });
    const result = await service.runNow();

    expect(result.keys).toEqual(["svitlo4u/daily/svitlo4u-2026-11-07.db.gz"]);
    expect(result.counts.outages).toBe(1);
    const [upload] = r2.uploads;
    expect(upload?.method).toBe("PUT");
    expect(upload?.url).toBe(
      "https://0123456789abcdef.r2.cloudflarestorage.com/svitlo4u-backups/svitlo4u/daily/svitlo4u-2026-11-07.db.gz",
    );
    expect(upload?.type).toBe("application/gzip");
    expect(upload?.auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=test-key-id\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*, Signature=[0-9a-f]{64}$/,
    );

    // The object is a working SQLite database.
    const restored = join(dir, "restored.db");
    writeFileSync(restored, gunzipSync(upload?.body as Buffer));
    expect(verifyBackup(restored)).toMatchObject({ ok: true, counts: { outages: 1, sites: 1 } });
    expect(service.status).toMatchObject({ failuresInRow: 0, lastError: null });
    expect(service.status.lastOk?.key).toBe(result.keys[0]);
  });

  it("on the 1st of a month also keeps a monthly copy", async () => {
    const r2 = fakeR2();
    const clock = new ManualClock(at("2026-12-01", "03:30"));
    const service = new BackupService({ db, config: CONFIG, clock, fetch: r2.fetch });
    expect((await service.runNow()).keys).toEqual([
      "svitlo4u/daily/svitlo4u-2026-12-01.db.gz",
      "svitlo4u/monthly/svitlo4u-2026-12.db.gz",
    ]);
  });

  it("runs at 03:30 local time; a failure is retried every 30 minutes and counted", async () => {
    const r2 = fakeR2(true);
    const clock = new ManualClock(at("2026-11-06", "20:00"));
    const results: (string | null)[] = [];
    const service = new BackupService({
      db,
      config: CONFIG,
      clock,
      fetch: r2.fetch,
      onResult: (status, result) => {
        results.push(result ? "ok" : `fail ${status.failuresInRow}`);
      },
    });
    expect(service.nextRunAt(clock.now())).toBe(at("2026-11-07", "03:30"));
    service.start();
    clock.advanceTo(at("2026-11-07", "03:29"));
    await settle();
    expect(r2.uploads).toHaveLength(0);

    clock.advanceTo(at("2026-11-07", "03:30"));
    await settle();
    expect(results).toEqual(["fail 1"]);
    expect(service.status.lastError?.error).toMatch(/403/);

    clock.advanceTo(at("2026-11-07", "04:00"));
    await settle();
    expect(results).toEqual(["fail 1", "fail 2"]);
    service.stop();
  });

  it("settings: all four values or none; the time is HH:MM", () => {
    const env = {
      BACKUP_S3_ENDPOINT: CONFIG.endpoint,
      BACKUP_S3_BUCKET: CONFIG.bucket,
      BACKUP_S3_ACCESS_KEY_ID: "k",
      BACKUP_S3_SECRET_ACCESS_KEY: "s",
    };
    expect(loadBackupConfig({}, KYIV_TZ)).toBeNull();
    expect(loadBackupConfig(env, KYIV_TZ)).toMatchObject({ time: "03:30", prefix: "" });
    expect(() => loadBackupConfig({ BACKUP_S3_BUCKET: "b" }, KYIV_TZ)).toThrow(/set all of/);
    expect(() => loadBackupConfig({ ...env, BACKUP_TIME: "3:30" }, KYIV_TZ)).toThrow(/BACKUP_TIME/);
    expect(() =>
      loadBackupConfig({ ...env, BACKUP_S3_ENDPOINT: "http://example.com" }, KYIV_TZ),
    ).toThrow(/https/);
  });
});
