/**
 * Nightly database backup to S3-compatible storage (Cloudflare R2).
 *
 * VACUUM INTO a temporary file (a consistent copy while the core keeps writing), integrity check,
 * gzip, PUT to `<prefix>daily/svitlo4u-YYYY-MM-DD.db.gz` — and on the 1st of a month also to
 * `<prefix>monthly/svitlo4u-YYYY-MM.db.gz`. Retention is a bucket lifecycle rule, not code.
 * A failed run is retried every 30 minutes (night outages take the internet down too); the admin
 * hears about it after a few failures in a row.
 */
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { addDays, localDate, zonedToEpoch } from "@svitlo/domain";
import { backupTo, type Db, verifyBackup } from "@svitlo/storage";
import { AwsClient } from "aws4fetch";
import type { Clock, Timer } from "../runtime/clock.ts";

export type BackupConfig = {
  /** https://<account id>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Object key prefix, e.g. "svitlo4u/" (may be empty). */
  prefix: string;
  /** Local time of the nightly run, "HH:MM". */
  time: string;
  tz: string;
};

export type BackupResult = {
  keys: string[];
  bytes: number;
  gzBytes: number;
  ms: number;
  counts: Record<string, number>;
};

export type BackupStatus = {
  lastOk: { at: number; gzBytes: number; key: string } | null;
  lastError: { at: number; error: string } | null;
  failuresInRow: number;
};

export type BackupDeps = {
  db: Db;
  config: BackupConfig;
  clock: Clock;
  /** Replace the network (tests). */
  fetch?: (request: Request) => Promise<Response>;
  onResult?: (status: BackupStatus, result: BackupResult | null) => void;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
};

const RETRY_MS = 30 * 60_000;
const gzipAsync = promisify(gzip);

export class BackupService {
  private readonly deps: BackupDeps & { fetch: (request: Request) => Promise<Response> };
  private readonly aws: AwsClient;
  private timer: Timer | null = null;
  private running: Promise<BackupResult> | null = null;
  readonly status: BackupStatus = { lastOk: null, lastError: null, failuresInRow: 0 };

  constructor(deps: BackupDeps) {
    this.deps = { ...deps, fetch: deps.fetch ?? ((request) => fetch(request)) };
    this.aws = new AwsClient({
      accessKeyId: deps.config.accessKeyId,
      secretAccessKey: deps.config.secretAccessKey,
      service: "s3",
      region: "auto",
    });
  }

  /** The next nightly run after `now`. */
  nextRunAt(now: number): number {
    const { time, tz } = this.deps.config;
    const [h, m] = time.split(":").map(Number) as [number, number];
    const today = localDate(now, tz);
    const at = zonedToEpoch(today, h * 60 + m, tz);
    return at > now ? at : zonedToEpoch(addDays(today, 1), h * 60 + m, tz);
  }

  start(): void {
    this.schedule(this.nextRunAt(this.deps.clock.now()));
  }

  stop(): void {
    this.deps.clock.clearTimer(this.timer);
    this.timer = null;
  }

  /** One backup now (also used by the CLI). Concurrent calls share the run. */
  runNow(): Promise<BackupResult> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private schedule(at: number): void {
    this.deps.clock.clearTimer(this.timer);
    this.timer = this.deps.clock.setTimer(at, () => {
      this.timer = null;
      void this.runNow().then(
        () => this.schedule(this.nextRunAt(this.deps.clock.now())),
        () => {
          const now = this.deps.clock.now();
          this.schedule(Math.min(now + RETRY_MS, this.nextRunAt(now)));
        },
      );
    });
  }

  private async run(): Promise<BackupResult> {
    const { db, config, clock, log } = this.deps;
    const started = clock.now();
    const tmp = join(tmpdir(), `svitlo4u-backup-${started}.db`);
    try {
      backupTo(db, tmp);
      const check = verifyBackup(tmp);
      if (!check.ok) throw new Error(`backup failed the integrity check: ${check.integrity}`);
      const raw = readFileSync(tmp);
      const body = await gzipAsync(raw);
      const date = localDate(started, config.tz);
      const keys = [`${config.prefix}daily/svitlo4u-${date}.db.gz`];
      if (date.endsWith("-01"))
        keys.push(`${config.prefix}monthly/svitlo4u-${date.slice(0, 7)}.db.gz`);
      for (const key of keys) await this.put(key, body);
      const result: BackupResult = {
        keys,
        bytes: raw.length,
        gzBytes: body.length,
        ms: clock.now() - started,
        counts: check.counts,
      };
      Object.assign(this.status, {
        lastOk: { at: clock.now(), gzBytes: body.length, key: keys[0] as string },
        failuresInRow: 0,
      });
      log?.info({ keys, bytes: raw.length, gzBytes: body.length }, "backup uploaded");
      this.deps.onResult?.(this.status, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.lastError = { at: clock.now(), error: message };
      this.status.failuresInRow++;
      log?.warn({ error: message, failures: this.status.failuresInRow }, "backup failed");
      this.deps.onResult?.(this.status, null);
      throw error;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  private async put(key: string, body: Uint8Array): Promise<void> {
    const { endpoint, bucket } = this.deps.config;
    const url = `${endpoint.replace(/\/+$/, "")}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const request = await this.aws.sign(url, {
      method: "PUT",
      body,
      headers: { "content-type": "application/gzip" },
    });
    const response = await this.deps.fetch(request);
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`upload of ${key} failed: ${response.status} ${text}`);
    }
  }
}

/** Backup settings from the environment; null when not configured. */
export function loadBackupConfig(env: NodeJS.ProcessEnv, tz: string): BackupConfig | null {
  const endpoint = env.BACKUP_S3_ENDPOINT;
  const bucket = env.BACKUP_S3_BUCKET;
  const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY;
  const given = [endpoint, bucket, accessKeyId, secretAccessKey].filter(Boolean).length;
  if (given === 0) return null;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "backup: set all of BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY",
    );
  }
  if (!/^https:\/\/[^/]+$/.test(endpoint.replace(/\/+$/, "")))
    throw new Error(`backup: BACKUP_S3_ENDPOINT must be an https origin: ${endpoint}`);
  const time = env.BACKUP_TIME || "03:30";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`backup: bad BACKUP_TIME ${time}`);
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    prefix: env.BACKUP_PREFIX ?? "",
    time,
    tz,
  };
}
