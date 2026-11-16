/**
 * Hub firmware updates (docs/hub-protocol.md → Updates).
 *
 * CI builds `firmware/hub` and publishes GitHub releases `hub-v<x.y.z>` with `svitlo4u_hub.bin`.
 * The core mirrors them into a local cache — only an ESP32-C6 image of svitlo4u_hub whose embedded
 * version is the tag's and whose bytes match the release digest — and, with R2 configured, into
 * `<prefix>firmware/hub/`. A hub gets the offer in the reply to its report (the route signs it) and
 * downloads the image from a short-lived presigned R2 URL, or from the core itself without R2.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AwsClient } from "aws4fetch";
import type { FastifyInstance } from "fastify";
import type { HubFirmwareOffer, HubReportEvent } from "../adapters/hub.ts";
import type { Clock, Timer } from "../runtime/clock.ts";
import type { BackupConfig } from "./backup.ts";

export const HUB_PROJECT = "svitlo4u_hub";
export const HUB_ASSET = "svitlo4u_hub.bin";
export const HUB_TAG_PREFIX = "hub-v";
const DEFAULT_REPO = "timki0n/svitlo4u";
const ESP32C6_CHIP_ID = 13;
/** One app slot (firmware/hub/partitions.csv). */
const MAX_IMAGE = 0x1d0000;
const POLL_MS = 30 * 60_000;
const URL_TTL_S = 15 * 60;
const FILE = /^hub-(\d{1,4}\.\d{1,4}\.\d{1,4})\.bin$/;

/** "latest", "off" or a pinned "x.y.z" (sites.yaml → hub device → firmware). */
export type FirmwarePolicy = string;

export type FirmwareImage = { version: string; size: number; sha256: string; file: string };

export type FirmwareConfig = {
  /** Local cache; images put here by hand (`hub-x.y.z.bin`) count too. */
  dir: string;
  /** GitHub "owner/name" with the releases; null = only the local cache. */
  repo: string | null;
  /** R2 (the backup bucket and credentials) for the downloads; null = the core serves them. */
  s3: Pick<
    BackupConfig,
    "endpoint" | "bucket" | "accessKeyId" | "secretAccessKey" | "prefix"
  > | null;
};

export type FirmwareDeps = {
  config: FirmwareConfig;
  clock: Clock;
  /** Replace the network (tests). */
  fetch?: (request: Request) => Promise<Response>;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
};

function parseVersion(v: string | null): [number, number, number] | null {
  const m = v ? /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** What the image says about itself: esp_image_header_t + esp_app_desc_t of the first segment. */
export function inspectHubImage(
  image: Uint8Array,
): { chip: number; version: string; project: string } | null {
  const b = Buffer.from(image.buffer, image.byteOffset, image.byteLength);
  if (b.length < 256 || b[0] !== 0xe9 || b.readUInt32LE(32) !== 0xabcd5432) return null;
  const text = (from: number) => {
    const s = b.subarray(from, from + 32);
    const end = s.indexOf(0);
    return s.subarray(0, end < 0 ? 32 : end).toString("latin1");
  };
  return { chip: b.readUInt16LE(12), version: text(48), project: text(80) };
}

/** Why the image is not hub firmware `version`, or null when it is. */
export function checkHubImage(image: Uint8Array, version: string): string | null {
  if (image.length > MAX_IMAGE) return `too big (${image.length} bytes)`;
  const info = inspectHubImage(image);
  if (!info) return "not an ESP app image";
  if (info.chip !== ESP32C6_CHIP_ID) return `chip ${info.chip}, not ESP32-C6`;
  if (info.project !== HUB_PROJECT) return `project ${info.project}`;
  if (info.version !== version) return `version ${info.version} inside`;
  return null;
}

/**
 * Which version a hub on `current` should take: "latest" upgrades only, a pin also downgrades,
 * and a version the hub rolled back is never offered again.
 */
export function pickHubFirmware(
  policy: FirmwarePolicy,
  current: string | null,
  available: readonly string[],
  rejected: string | null,
): string | null {
  if (policy === "off") return null;
  const candidates = available.filter((v) => v !== current && v !== rejected);
  if (policy !== "latest") return candidates.includes(policy) ? policy : null;
  const best = [...candidates].sort(compareVersions).at(-1);
  if (!best) return null;
  return !parseVersion(current) || compareVersions(best, current as string) > 0 ? best : null;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export class FirmwareService {
  private readonly deps: FirmwareDeps & { fetch: (request: Request) => Promise<Response> };
  private readonly aws: AwsClient | null;
  private readonly images = new Map<string, FirmwareImage>();
  /** Versions known to be in R2 (checked once per core run). */
  private readonly uploaded = new Set<string>();
  /** Releases that failed the checks (not downloaded again until a restart). */
  private readonly skipped = new Set<string>();
  private timer: Timer | null = null;
  private refreshing: Promise<void> | null = null;
  readonly status: { checkedAt: number | null; error: string | null } = {
    checkedAt: null,
    error: null,
  };

  constructor(deps: FirmwareDeps) {
    this.deps = { ...deps, fetch: deps.fetch ?? ((request) => fetch(request)) };
    const { s3 } = deps.config;
    this.aws = s3
      ? new AwsClient({
          accessKeyId: s3.accessKeyId,
          secretAccessKey: s3.secretAccessKey,
          service: "s3",
          region: "auto",
        })
      : null;
  }

  start(): void {
    this.scan();
    const tick = () => {
      void this.refresh().finally(() => {
        this.timer = this.deps.clock.setTimer(this.deps.clock.now() + POLL_MS, tick);
      });
    };
    tick();
  }

  stop(): void {
    this.deps.clock.clearTimer(this.timer);
    this.timer = null;
  }

  versions(): string[] {
    return [...this.images.keys()].sort(compareVersions);
  }

  image(version: string): FirmwareImage | undefined {
    return this.images.get(version);
  }

  /** The releases → the cache → R2. Concurrent calls share the run; errors land in `status`. */
  refresh(): Promise<void> {
    this.refreshing ??= this.run().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** The offer for this report, or null (not now, nothing newer, or the hub cannot update). */
  async offer(policy: FirmwarePolicy, event: HubReportEvent): Promise<HubFirmwareOffer | null> {
    const ota = event.ota;
    if (!ota || ota.state === "downloading" || ota.state === "ready") return null;
    // Not while the light is off or events wait: the restart would blur them.
    if (event.mains === "off" || event.events.length > 0) return null;
    const version = pickHubFirmware(policy, event.fw, this.versions(), ota.rejected);
    const image = version ? this.images.get(version) : undefined;
    if (!version || !image) return null;
    return { version, url: await this.url(version), size: image.size, sha256: image.sha256 };
  }

  /** Reads the cache directory. */
  scan(): void {
    const { dir } = this.deps.config;
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      const version = FILE.exec(name)?.[1];
      if (!version || this.images.has(version)) continue;
      const file = join(dir, name);
      const data = readFileSync(file);
      const problem = checkHubImage(data, version);
      if (problem) {
        this.deps.log?.warn({ file: name, problem }, "firmware file ignored");
        continue;
      }
      this.images.set(version, { version, size: data.length, sha256: sha256(data), file });
    }
  }

  private async run(): Promise<void> {
    try {
      if (this.deps.config.repo) await this.mirrorReleases(this.deps.config.repo);
      this.scan();
      for (const image of this.images.values()) await this.upload(image);
      this.status.error = null;
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : String(error);
      this.deps.log?.warn({ error: this.status.error }, "firmware check failed");
    } finally {
      this.status.checkedAt = this.deps.clock.now();
    }
  }

  private async mirrorReleases(repo: string): Promise<void> {
    const headers = { accept: "application/vnd.github+json", "user-agent": "svitlo4u-core" };
    const response = await this.deps.fetch(
      new Request(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers }),
    );
    if (!response.ok) throw new Error(`GitHub releases: HTTP ${response.status}`);
    const releases: unknown = await response.json();
    for (const release of Array.isArray(releases) ? releases : []) {
      const r = release as Record<string, unknown>;
      const tag = typeof r.tag_name === "string" ? r.tag_name : "";
      const version = tag.startsWith(HUB_TAG_PREFIX) ? tag.slice(HUB_TAG_PREFIX.length) : null;
      if (!version || !parseVersion(version) || r.draft || r.prerelease) continue;
      if (this.images.has(version) || this.skipped.has(tag)) continue;
      const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [];
      const asset = assets.find((a) => a.name === HUB_ASSET);
      if (!asset || typeof asset.browser_download_url !== "string") continue;

      const download = await this.deps.fetch(
        new Request(asset.browser_download_url, { headers: { "user-agent": "svitlo4u-core" } }),
      );
      if (!download.ok) throw new Error(`${tag}: download HTTP ${download.status}`);
      const data = new Uint8Array(await download.arrayBuffer());
      const hash = sha256(data);
      const digest = typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/, "") : null;
      const problem =
        data.length !== asset.size
          ? `size ${data.length}, the release says ${String(asset.size)}`
          : digest && digest !== hash
            ? "sha256 differs from the release digest"
            : checkHubImage(data, version);
      if (problem) {
        this.skipped.add(tag);
        this.deps.log?.warn({ tag, problem }, "firmware release ignored");
        continue;
      }
      const file = join(this.deps.config.dir, `hub-${version}.bin`);
      writeFileSync(`${file}.tmp`, data);
      renameSync(`${file}.tmp`, file);
      this.images.set(version, { version, size: data.length, sha256: hash, file });
      this.deps.log?.info({ version, size: data.length, sha256: hash }, "hub firmware mirrored");
    }
  }

  private objectUrl(version: string): string {
    const s3 = this.deps.config.s3 as NonNullable<FirmwareConfig["s3"]>;
    const key = `${s3.prefix}firmware/hub/${HUB_ASSET.replace(".bin", `-${version}.bin`)}`;
    return `${s3.endpoint.replace(/\/+$/, "")}/${s3.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  private async upload(image: FirmwareImage): Promise<void> {
    if (!this.aws || this.uploaded.has(image.version)) return;
    const url = this.objectUrl(image.version);
    const head = await this.deps.fetch(await this.aws.sign(url, { method: "HEAD" }));
    if (head.ok && Number(head.headers.get("content-length")) === image.size) {
      this.uploaded.add(image.version);
      return;
    }
    const put = await this.deps.fetch(
      await this.aws.sign(url, {
        method: "PUT",
        body: readFileSync(image.file),
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    if (!put.ok) throw new Error(`upload of ${image.version}: HTTP ${put.status}`);
    this.uploaded.add(image.version);
    this.deps.log?.info({ version: image.version }, "hub firmware uploaded to R2");
  }

  /** A presigned R2 URL, or the core's own path (the hub puts its report server in front). */
  private async url(version: string): Promise<string> {
    if (this.aws && this.uploaded.has(version)) {
      const url = new URL(this.objectUrl(version));
      url.searchParams.set("X-Amz-Expires", String(URL_TTL_S));
      const signed = await this.aws.sign(url.toString(), {
        method: "GET",
        aws: { signQuery: true },
      });
      return signed.url;
    }
    return `/iot/hub/firmware/hub-${version}.bin`;
  }
}

/** GET /iot/hub/firmware/hub-x.y.z.bin — the images themselves are public (an open-source build). */
export function registerFirmwareRoute(app: FastifyInstance, firmware: FirmwareService): void {
  app.get<{ Params: { name: string } }>("/iot/hub/firmware/:name", async (request, reply) => {
    const version = FILE.exec(request.params.name)?.[1];
    const image = version ? firmware.image(version) : undefined;
    if (!image) return reply.code(404).send({ ok: false });
    return reply
      .header("content-type", "application/octet-stream")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(readFileSync(image.file));
  });
}

/** Firmware settings; null when the core has no place for the cache (an in-memory database). */
export function loadFirmwareConfig(
  env: NodeJS.ProcessEnv,
  dbPath: string,
  s3: BackupConfig | null,
): FirmwareConfig | null {
  const dir =
    env.FIRMWARE_DIR || (dbPath === ":memory:" ? null : join(dirname(dbPath), "firmware"));
  if (!dir) return null;
  const repo = env.FIRMWARE_REPO === "off" ? null : env.FIRMWARE_REPO || DEFAULT_REPO;
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error(`firmware: FIRMWARE_REPO must be "owner/name" or "off": ${repo}`);
  return {
    dir,
    repo,
    s3: s3
      ? {
          endpoint: s3.endpoint,
          bucket: s3.bucket,
          accessKeyId: s3.accessKeyId,
          secretAccessKey: s3.secretAccessKey,
          prefix: s3.prefix,
        }
      : null,
  };
}
