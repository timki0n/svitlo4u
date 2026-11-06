/**
 * Light per-client rate limit for the public API (token bucket in memory). Behind the Cloudflare
 * tunnel the client address comes from CF-Connecting-IP; the core's port itself is published only
 * on localhost, so the header cannot be forged from outside.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

export type RateLimitOptions = {
  /** Sustained requests per minute per client; 0 disables the limit. */
  perMinute: number;
  /** Requests a client may make at once. */
  burst: number;
  now: () => number;
};

type Bucket = { tokens: number; at: number };

export class RateLimiter {
  private readonly options: RateLimitOptions;
  private readonly buckets = new Map<string, Bucket>();
  private calls = 0;

  constructor(options: RateLimitOptions) {
    this.options = options;
  }

  /** Seconds to wait, or 0 when the request may go. */
  take(key: string): number {
    const { perMinute, burst, now: clock } = this.options;
    if (perMinute <= 0) return 0;
    const now = clock();
    const perMs = perMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) * perMs);
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (++this.calls % 1000 === 0) this.prune(now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / perMs / 1000);
  }

  /** Forget clients whose bucket has refilled anyway. */
  private prune(now: number): void {
    const full = (this.options.burst / this.options.perMinute) * 60_000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > full) this.buckets.delete(key);
    }
  }
}

export function clientKey(request: FastifyRequest): string {
  const forwarded = request.headers["cf-connecting-ip"];
  return typeof forwarded === "string" && forwarded ? forwarded : request.ip;
}

/** Limit and mark as uncacheable everything under /api/. */
export function registerApiGuards(app: FastifyInstance, limiter: RateLimiter): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const wait = limiter.take(clientKey(request));
    if (wait > 0) {
      return reply
        .code(429)
        .header("retry-after", String(wait))
        .header("cache-control", "no-store")
        .send({ error: "rate_limited", message: `Retry in ${wait} s` });
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    return payload;
  });
}
