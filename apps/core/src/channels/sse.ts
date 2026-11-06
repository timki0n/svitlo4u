/**
 * Server-Sent Events for the future web app: `GET /api/v1/sites/:siteId/events`.
 * A client gets the current state at once, then every change the moment it happens.
 * No replay: a reconnecting client starts from a fresh snapshot.
 *
 * Events: state (same body as /state), power, false-alarm, schedule, reminder, voltage,
 * voltage-alert, voltage-stabilized.
 */
import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { clientKey } from "../api/rate-limit.ts";
import { stateView } from "../api/views.ts";
import type { Bus } from "../runtime/bus.ts";
import type { Clock } from "../runtime/clock.ts";
import type { SiteStateStore } from "../services/state.ts";

export type SseDeps = {
  bus: Bus;
  state: SiteStateStore;
  clock: Clock;
  heartbeatMs?: number;
  maxClients?: number;
  /** Open streams per client address. */
  maxPerClient?: number;
};

/** A client that cannot keep up gets disconnected instead of buffering without limit. */
const MAX_BUFFERED_BYTES = 1 << 20;

export class SseHub {
  private readonly deps: SseDeps;
  private readonly clients = new Map<string, Set<ServerResponse>>();
  private readonly unsubscribe: (() => void)[] = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly perClient = new Map<string, number>();

  constructor(deps: SseDeps) {
    this.deps = deps;
    const { bus } = deps;
    this.unsubscribe.push(
      bus.on("power.changed", (e) => {
        this.send(e.siteId, "power", {
          state: e.state,
          at: e.at,
          detectedAt: e.detectedAt,
          approximate: e.approximate,
        });
        this.sendState(e.siteId);
      }),
      bus.on("power.false-alarm", (e) => {
        this.send(e.siteId, "false-alarm", { outageStartedAt: e.outageStartedAt });
        this.sendState(e.siteId);
      }),
      bus.on("schedule.updated", (e) => this.sendState(e.siteId)),
      bus.on("schedule.notification", (e) =>
        this.send(e.siteId, "schedule", { kind: e.notification.kind, ...e.notification.web }),
      ),
      bus.on("reminder.due", (e) =>
        this.send(e.siteId, "reminder", {
          kind: e.event.kind,
          leadMinutes: e.event.leadMinutes,
          start: e.event.start,
          end: e.event.end,
          power: e.power,
        }),
      ),
      bus.on("voltage.sample", (e) =>
        this.send(e.siteId, "voltage", { t: e.t, voltage: e.voltage }),
      ),
      bus.on("voltage.alert", (e) =>
        this.send(e.siteId, "voltage-alert", { kind: e.kind, voltage: e.voltage, since: e.since }),
      ),
      bus.on("voltage.stabilized", (e) =>
        this.send(e.siteId, "voltage-stabilized", {
          kind: e.kind,
          voltage: e.voltage,
          since: e.since,
          at: e.at,
        }),
      ),
    );
  }

  get count(): number {
    let n = 0;
    for (const set of this.clients.values()) n += set.size;
    return n;
  }

  registerRoutes(app: FastifyInstance): void {
    app.addHook("preClose", (done) => {
      this.closeAll();
      done();
    });
    app.get<{ Params: { siteId: string } }>(
      "/api/v1/sites/:siteId/events",
      async (request, reply) => {
        const { siteId } = request.params;
        if (!this.clients.has(siteId) && !this.knownSite(siteId)) {
          return reply.code(404).send({ error: "unknown_site" });
        }
        if (this.count >= (this.deps.maxClients ?? 1000)) {
          return reply.code(503).send({ error: "too_many_clients" });
        }
        const client = clientKey(request);
        const open = this.perClient.get(client) ?? 0;
        if (open >= (this.deps.maxPerClient ?? 10)) {
          return reply.code(429).send({ error: "too_many_streams" });
        }
        this.perClient.set(client, open + 1);
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write("retry: 3000\n\n");
        let set = this.clients.get(siteId);
        if (!set) {
          set = new Set();
          this.clients.set(siteId, set);
        }
        set.add(res);
        this.ensureHeartbeat();
        request.raw.on("close", () => {
          const left = (this.perClient.get(client) ?? 1) - 1;
          if (left > 0) this.perClient.set(client, left);
          else this.perClient.delete(client);
          this.remove(siteId, res);
        });
        this.write(siteId, res, "state", this.snapshot(siteId));
      },
    );
  }

  closeAll(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const set of this.clients.values()) for (const res of set) res.end();
    this.clients.clear();
  }

  /** What a client needs to render the site right now. */
  /** Same body as GET /api/v1/sites/:siteId/state. */
  snapshot(siteId: string) {
    return stateView(this.deps.state, siteId, this.deps.clock.now());
  }

  private knownSite(siteId: string): boolean {
    try {
      this.deps.state.get(siteId);
      return true;
    } catch {
      return false;
    }
  }

  private sendState(siteId: string): void {
    if (this.clients.get(siteId)?.size) this.send(siteId, "state", this.snapshot(siteId));
  }

  private send(siteId: string, event: string, data: unknown): void {
    const set = this.clients.get(siteId);
    if (!set || set.size === 0) return;
    for (const res of set) this.write(siteId, res, event, data);
  }

  private write(siteId: string, res: ServerResponse, event: string, data: unknown): void {
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      res.destroy();
      this.remove(siteId, res);
      return;
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private remove(siteId: string, res: ServerResponse): void {
    this.clients.get(siteId)?.delete(res);
    if (this.count === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** Comment lines keep proxies (Cloudflare) from closing idle streams. */
  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const set of this.clients.values()) for (const res of set) res.write(": ping\n\n");
    }, this.deps.heartbeatMs ?? 25_000);
    this.heartbeat.unref();
  }
}
