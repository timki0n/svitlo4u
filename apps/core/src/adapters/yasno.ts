/**
 * Yasno planned-outages poller.
 *
 * The plain URL is served by the Imperva CDN with max-age=300 (up to 5 min stale). A cache-busting
 * query goes to the origin, which is what we poll. If the origin does not answer with valid JSON
 * (e.g. a bot challenge), fall back to the CDN URL with If-None-Match. One request per region/DSO
 * serves every configured group; only the configured groups' content decides "changed".
 */
import { createHash } from "node:crypto";
import { type GroupSchedule, parseGroupBlock } from "@svitlo/domain";
import { z } from "zod";

const slotSchema = z.looseObject({ start: z.number(), end: z.number(), type: z.string() });
const daySchema = z.looseObject({
  date: z.string(),
  status: z.string(),
  slots: z.array(slotSchema),
});
const groupSchema = z.looseObject({
  today: daySchema.optional(),
  tomorrow: daySchema.optional(),
  updatedOn: z.string().optional(),
});
const responseSchema = z.record(z.string(), groupSchema);

export type YasnoUpdate = {
  fetchedAt: number;
  source: "origin" | "cdn";
  groups: Record<string, GroupSchedule>;
  /** Configured groups absent from the response. */
  missingGroups: string[];
};

export type PollOutcome =
  | { kind: "changed"; update: YasnoUpdate; latencyMs: number }
  | { kind: "unchanged"; source: "origin" | "cdn"; latencyMs: number }
  | { kind: "error"; error: string; latencyMs: number };

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export function yasnoUrl(region: number, dso: number): string {
  return `https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/${region}/dsos/${dso}/planned-outages`;
}

/** Delay before the next poll: the interval when healthy, exponential backoff with ±10 % jitter after errors. */
export function nextPollDelay(
  failures: number,
  intervalMs: number,
  maxBackoffMs: number,
  random: () => number = Math.random,
): number {
  if (failures === 0) return intervalMs;
  const base = Math.min(maxBackoffMs, intervalMs * 2 ** failures);
  return Math.round(base * (0.9 + 0.2 * random()));
}

export type YasnoPollerOptions = {
  region: number;
  dso: number;
  groups: readonly string[];
  fetch?: FetchFn;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  maxBackoffMs?: number;
  onUpdate: (update: YasnoUpdate) => void;
  onError?: (error: string, failures: number) => void;
  /** First success after failures. */
  onRecovered?: (failures: number) => void;
};

export class YasnoPoller {
  private readonly options: YasnoPollerOptions;
  private readonly url: string;
  private lastHash: string | null = null;
  private cdnEtag: string | null = null;
  private failures = 0;
  private lastSuccess: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(options: YasnoPollerOptions) {
    this.options = options;
    this.url = yasnoUrl(options.region, options.dso);
  }

  private get fetchFn(): FetchFn {
    return this.options.fetch ?? fetch;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async pollOnce(): Promise<PollOutcome> {
    const started = this.now();
    const timeout = this.options.timeoutMs ?? 5_000;
    const headers = {
      accept: "application/json",
      "user-agent": "svitlo4u/1.0 (+https://svitlo4u.info)",
    };
    let source: "origin" | "cdn" = "origin";
    let body: unknown;
    try {
      body = await this.fetchJson(`${this.url}?_=${started}`, {
        headers,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (originError) {
      source = "cdn";
      try {
        const response = await this.fetchFn(this.url, {
          headers: { ...headers, ...(this.cdnEtag ? { "if-none-match": this.cdnEtag } : {}) },
          signal: AbortSignal.timeout(timeout),
        });
        if (response.status === 304) {
          this.succeeded();
          return { kind: "unchanged", source, latencyMs: this.now() - started };
        }
        body = await readJson(response);
        this.cdnEtag = response.headers.get("etag");
      } catch (cdnError) {
        return this.fail(`origin: ${message(originError)}; cdn: ${message(cdnError)}`, started);
      }
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success)
      return this.fail(`unexpected response shape: ${z.prettifyError(parsed.error)}`, started);
    const relevant: Record<string, unknown> = {};
    for (const group of this.options.groups) relevant[group] = parsed.data[group] ?? null;
    const hash = createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
    this.succeeded();
    if (hash === this.lastHash)
      return { kind: "unchanged", source, latencyMs: this.now() - started };
    this.lastHash = hash;

    const groups: Record<string, GroupSchedule> = {};
    const missingGroups: string[] = [];
    for (const group of this.options.groups) {
      const block = parsed.data[group];
      if (block) groups[group] = parseGroupBlock(block);
      else missingGroups.push(group);
    }
    const update: YasnoUpdate = { fetchedAt: started, source, groups, missingGroups };
    this.options.onUpdate(update);
    return { kind: "changed", update, latencyMs: this.now() - started };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      await this.pollOnce();
      if (this.stopped) return;
      const delay = nextPollDelay(
        this.failures,
        this.options.intervalMs ?? 20_000,
        this.options.maxBackoffMs ?? 5 * 60_000,
      );
      this.timer = setTimeout(() => void loop(), delay);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    return readJson(await this.fetchFn(url, init));
  }

  /** Last successful poll (changed or not). */
  get lastSuccessAt(): number | null {
    return this.lastSuccess;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  private succeeded(): void {
    const failures = this.failures;
    this.failures = 0;
    this.lastSuccess = this.now();
    if (failures > 0) this.options.onRecovered?.(failures);
  }

  private fail(error: string, started: number): PollOutcome {
    this.failures++;
    this.options.onError?.(error, this.failures);
    return { kind: "error", error, latencyMs: this.now() - started };
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!type.includes("json"))
    throw new Error(`not JSON (${type || "no content-type"}): ${text.slice(0, 60)}`);
  return JSON.parse(text) as unknown;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
