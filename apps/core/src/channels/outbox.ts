/**
 * Delivery queue. Every notification is written to notification_outbox and sent at once; failures
 * are retried with backoff (5 s → 3 min, for up to 30 min), so nothing is lost while the internet
 * is down and nothing is resent after a restart. Rules:
 * - one target gets its messages in order: a later message waits for the earlier one;
 * - when a send to a site's channel succeeds (connectivity is back), its waiting retries go now;
 * - permanent errors (4xx except 429) are not retried — the channel decides whether to alert;
 * - a channel that is not ready (the bot has not set up with Telegram since the start) holds its
 *   items without attempts: a reply that fails may still have been delivered, so sending into a
 *   half-up network and retrying makes duplicates. resume() sends them once it is ready.
 */
import type { OutboxItem, Store } from "@svitlo/storage";
import type { Clock, Timer } from "../runtime/clock.ts";

export const RETRY_DELAYS_MS = [5, 10, 15, 30, 60, 120, 180].map((s) => s * 1000);
export const MAX_AGE_MS = 30 * 60_000;

export type DeliveryResult =
  | { status: "sent" }
  /** Temporary problem (network, 5xx, 429). retryAt overrides the backoff (429 retry_after). */
  | { status: "retry"; error: string; retryAt?: number }
  /** Will never succeed as is. quiet: expected (e.g. a subscriber blocked the bot), no alert. */
  | { status: "failed"; error: string; quiet?: boolean }
  /** The chat moved (group → supergroup): deliver to the new target instead. */
  | { status: "redirect"; error: string; target: string };

export type ChannelSender = (item: OutboxItem) => Promise<DeliveryResult>;

export type OutboxDeps = {
  store: Store;
  clock: Clock;
  /** channel name → sender */
  senders: Map<string, ChannelSender>;
  /** Called once per item that will not be delivered (permanent error or expired). */
  onUndelivered?: (item: OutboxItem, error: string) => void;
  onSent?: (item: OutboxItem, sentAt: number) => void;
  /** False: the channel holds this site's items for now (call resume() when that changes). */
  ready?: (siteId: string, channel: string) => boolean;
  log?: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
};

export type EnqueueItem = {
  siteId: string;
  channel: string;
  target: string;
  kind: string;
  payload: unknown;
  dedupeKey?: string;
};

export class Outbox {
  private readonly deps: OutboxDeps;
  private readonly inFlight = new Set<string>();
  private timer: Timer | null = null;
  private timerAt: number | null = null;
  private kickQueued = false;
  private stopped = false;
  private idleWaiters: (() => void)[] = [];

  constructor(deps: OutboxDeps) {
    this.deps = deps;
  }

  /** Store the items and start sending them right away. Returns how many were new. */
  enqueue(items: readonly EnqueueItem[]): number {
    const now = this.deps.clock.now();
    let added = 0;
    const touched = new Set<string>();
    for (const item of items) {
      if (this.deps.store.outbox.enqueue(item, now) !== null) added++;
      touched.add(`${item.siteId}\u0000${item.channel}`);
    }
    // A new message must not sit behind an older one waiting for its backoff.
    for (const key of touched) {
      const [siteId, channel] = key.split("\u0000") as [string, string];
      this.deps.store.outbox.retryNow(siteId, channel, now);
    }
    this.kick();
    return added;
  }

  /** Deliver whatever is due (also what was left pending before a restart). */
  start(): void {
    this.stopped = false;
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    this.deps.clock.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = null;
    this.settle();
  }

  /** A channel became ready: send what waited for it. */
  resume(): void {
    this.kick();
  }

  /** Resolves when nothing is being sent and nothing is due (tests, shutdown). */
  idle(): Promise<void> {
    if (this.inFlight.size === 0 && !this.kickQueued) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  get sending(): number {
    return this.inFlight.size;
  }

  private kick(): void {
    if (this.stopped) {
      this.settle();
      return;
    }
    if (this.kickQueued) return;
    this.kickQueued = true;
    queueMicrotask(() => {
      this.kickQueued = false;
      this.process();
    });
  }

  private process(): void {
    if (this.stopped) return;
    const { store, clock } = this.deps;
    const now = clock.now();
    const heads = new Map<string, OutboxItem>();
    for (const item of store.outbox.pending()) {
      if (now - item.createdAt >= MAX_AGE_MS) {
        store.outbox.markFailed(item.id, `expired: ${item.lastError ?? "not sent"}`, null);
        this.deps.onUndelivered?.(item, `не доставлено за 30 хв: ${item.lastError ?? "?"}`);
        continue;
      }
      const key = `${item.siteId}\u0000${item.channel}\u0000${item.target}`;
      if (!heads.has(key)) heads.set(key, item);
    }

    let nextAt: number | null = null;
    for (const [key, item] of heads) {
      if (this.inFlight.has(key)) continue;
      if (this.deps.ready && !this.deps.ready(item.siteId, item.channel)) continue;
      if (item.nextAttemptAt > now) {
        nextAt = nextAt === null ? item.nextAttemptAt : Math.min(nextAt, item.nextAttemptAt);
        continue;
      }
      this.inFlight.add(key);
      void this.deliver(item).finally(() => {
        this.inFlight.delete(key);
        this.kick();
      });
    }
    this.armTimer(nextAt);
    this.settle();
  }

  private settle(): void {
    if (this.inFlight.size === 0 && !this.kickQueued) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private armTimer(at: number | null): void {
    if (at === this.timerAt) return;
    this.deps.clock.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = at;
    if (at === null) return;
    this.timer = this.deps.clock.setTimer(at, () => {
      this.timer = null;
      this.timerAt = null;
      this.kick();
    });
  }

  private async deliver(item: OutboxItem): Promise<void> {
    const { store, clock, log } = this.deps;
    const sender = this.deps.senders.get(item.channel);
    let result: DeliveryResult;
    if (!sender) {
      result = { status: "failed", error: `no sender for channel ${item.channel}` };
    } else {
      try {
        result = await sender(item);
      } catch (error) {
        result = { status: "retry", error: error instanceof Error ? error.message : String(error) };
      }
    }
    const now = clock.now();
    switch (result.status) {
      case "sent":
        store.outbox.markSent(item.id, now);
        this.deps.onSent?.(item, now);
        store.outbox.retryNow(item.siteId, item.channel, now);
        return;
      case "retry": {
        const backoff = RETRY_DELAYS_MS[Math.min(item.attempts, RETRY_DELAYS_MS.length - 1)] ?? 0;
        const retryAt = Math.max(now + 1_000, result.retryAt ?? now + backoff);
        if (retryAt - item.createdAt >= MAX_AGE_MS) {
          store.outbox.markFailed(item.id, `expired: ${result.error}`, null);
          this.deps.onUndelivered?.(item, `не доставлено за 30 хв: ${result.error}`);
          return;
        }
        store.outbox.markFailed(item.id, result.error, retryAt);
        log?.warn(
          { id: item.id, target: item.target, attempt: item.attempts + 1, error: result.error },
          "delivery failed, will retry",
        );
        return;
      }
      case "failed":
        store.outbox.markFailed(item.id, result.error, null);
        if (result.quiet) return;
        log?.error({ id: item.id, target: item.target, error: result.error }, "delivery failed");
        this.deps.onUndelivered?.(item, result.error);
        return;
      case "redirect":
        store.outbox.markFailed(item.id, result.error, null);
        store.outbox.enqueue(
          {
            siteId: item.siteId,
            channel: item.channel,
            target: result.target,
            kind: item.kind,
            payload: JSON.parse(item.payloadJson),
          },
          now,
        );
        return;
    }
  }
}
