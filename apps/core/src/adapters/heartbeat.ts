/**
 * ESP heartbeat adapters: UDP (signed v2 packets, legacy {"ping":N} during migration) and HTTP
 * (POST /iot/ping with X-Signature, the light_bot_tg firmware). They only verify and translate;
 * all decisions belong to the power detector.
 *
 * UDP v2 packet (JSON):
 *   {"v":2,"dev":"esp-4u","boot":"9f3a1c2e","seq":1234,"up":5678,"rst":"poweron","sig":"<32 hex>"}
 *   sig = first 16 bytes of HMAC-SHA256(secret, "2|<dev>|<boot>|<seq>|<up>|<rst>") as hex
 *   boot: random per ESP boot; seq: +1 per packet within a boot; up: seconds since boot;
 *   rst: why the ESP booted (poweron, brownout, sw, panic, wdt, …).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import type { FastifyInstance } from "fastify";
import type { EspDeviceConfig } from "../sites-config.ts";

export type HeartbeatEvent = {
  siteId: string;
  deviceId: string;
  t: number;
  up: number | null;
  boot: string | null;
  /** v2 firmware only: reset reason of the current boot. */
  resetReason: string | null;
  transport: "udp" | "udp-legacy" | "http";
  remote: string;
};

export type RejectReason =
  | "malformed"
  | "unknown-device"
  | "bad-signature"
  | "replay"
  | "legacy-not-allowed";

export type VerifyResult =
  | { ok: true; event: HeartbeatEvent }
  | { ok: false; reason: RejectReason; deviceId?: string };

export function signV2(
  secret: string,
  dev: string,
  boot: string,
  seq: number,
  up: number,
  rst: string,
): string {
  return createHmac("sha256", secret)
    .update(`2|${dev}|${boot}|${seq}|${up}|${rst}`)
    .digest()
    .subarray(0, 16)
    .toString("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase(), "utf8");
  const y = Buffer.from(b.toLowerCase(), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const RECENT_BOOTS = 16;

/** Verifies UDP packets and rejects replays (per device: current boot + seq, recently seen boots). */
export class UdpHeartbeatVerifier {
  private readonly devices = new Map<string, EspDeviceConfig>();
  private readonly legacyByIp = new Map<string, EspDeviceConfig>();
  private readonly replay = new Map<string, { boot: string; seq: number; recentBoots: string[] }>();

  constructor(devices: readonly EspDeviceConfig[]) {
    for (const d of devices) {
      if (d.transport !== "udp") continue;
      this.devices.set(d.id, d);
      for (const ip of d.legacyIps) this.legacyByIp.set(ip, d);
    }
  }

  verify(payload: Buffer | string, remote: string, t: number): VerifyResult {
    let msg: unknown;
    try {
      msg = JSON.parse(payload.toString());
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (typeof msg !== "object" || msg === null) return { ok: false, reason: "malformed" };
    const m = msg as Record<string, unknown>;

    if (m.v === undefined && typeof m.ping === "number") {
      const device = this.legacyByIp.get(remote);
      if (!device) return { ok: false, reason: "legacy-not-allowed" };
      return {
        ok: true,
        event: {
          siteId: device.siteId,
          deviceId: device.id,
          t,
          up: m.ping,
          boot: null,
          resetReason: null,
          transport: "udp-legacy",
          remote,
        },
      };
    }

    const { v, dev, boot, seq, up, rst, sig } = m;
    if (
      v !== 2 ||
      typeof dev !== "string" ||
      typeof boot !== "string" ||
      typeof seq !== "number" ||
      typeof up !== "number" ||
      typeof rst !== "string" ||
      typeof sig !== "string"
    ) {
      return { ok: false, reason: "malformed" };
    }
    const device = this.devices.get(dev);
    if (!device) return { ok: false, reason: "unknown-device" };
    if (!safeEqualHex(sig, signV2(device.secret, dev, boot, seq, up, rst))) {
      return { ok: false, reason: "bad-signature", deviceId: dev };
    }

    const state = this.replay.get(dev);
    if (state) {
      if (boot === state.boot) {
        if (seq <= state.seq) return { ok: false, reason: "replay", deviceId: dev };
        state.seq = seq;
      } else {
        if (state.recentBoots.includes(boot)) return { ok: false, reason: "replay", deviceId: dev };
        state.recentBoots = [...state.recentBoots, boot].slice(-RECENT_BOOTS);
        state.boot = boot;
        state.seq = seq;
      }
    } else {
      this.replay.set(dev, { boot, seq, recentBoots: [boot] });
    }
    return {
      ok: true,
      event: {
        siteId: device.siteId,
        deviceId: dev,
        t,
        up,
        boot,
        resetReason: rst,
        transport: "udp",
        remote,
      },
    };
  }
}

export type UdpHeartbeatServer = { port: number; close: () => Promise<void> };

export function startUdpHeartbeat(options: {
  port: number;
  host?: string;
  verifier: UdpHeartbeatVerifier;
  onEvent: (event: HeartbeatEvent) => void;
  onReject?: (reason: RejectReason, remote: string, deviceId?: string) => void;
  now?: () => number;
}): Promise<UdpHeartbeatServer> {
  const now = options.now ?? Date.now;
  const socket: Socket = createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (payload, info) => {
    const result = options.verifier.verify(payload, info.address, now());
    if (result.ok) options.onEvent(result.event);
    else options.onReject?.(result.reason, info.address, result.deviceId);
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(options.port, options.host ?? "0.0.0.0", () => {
      socket.off("error", reject);
      resolve({
        port: socket.address().port,
        close: () => new Promise<void>((done) => socket.close(() => done())),
      });
    });
  });
}

/** HTTP ping of the light_bot_tg firmware: X-Signature = hex HMAC-SHA256(secret, raw body). */
export class HttpHeartbeatVerifier {
  private readonly devices: EspDeviceConfig[];

  constructor(devices: readonly EspDeviceConfig[]) {
    this.devices = devices.filter((d) => d.transport === "http");
  }

  verify(rawBody: Buffer, signature: string | undefined, remote: string, t: number): VerifyResult {
    if (!signature) return { ok: false, reason: "bad-signature" };
    // The firmware does not name itself: the device is the one whose secret matches.
    const device = this.devices.find((d) =>
      safeEqualHex(signature.trim(), createHmac("sha256", d.secret).update(rawBody).digest("hex")),
    );
    if (!device) return { ok: false, reason: "bad-signature" };
    let up: number | null = null;
    try {
      const body = JSON.parse(rawBody.toString() || "{}") as Record<string, unknown>;
      const candidate = body.up ?? body.uptime ?? body.ping;
      if (typeof candidate === "number" && Number.isFinite(candidate)) up = candidate;
    } catch {
      // A signed body that is not JSON still proves the ESP is alive.
    }
    return {
      ok: true,
      event: {
        siteId: device.siteId,
        deviceId: device.id,
        t,
        up,
        boot: null,
        resetReason: null,
        transport: "http",
        remote,
      },
    };
  }
}

/** POST /iot/ping — answers fast, verification needs the raw body. */
export function registerIotRoutes(
  app: FastifyInstance,
  options: {
    verifier: HttpHeartbeatVerifier;
    onEvent: (event: HeartbeatEvent) => void;
    onReject?: (reason: RejectReason, remote: string) => void;
    now?: () => number;
  },
): void {
  const now = options.now ?? Date.now;
  app.register(async (scope) => {
    // The signature covers the exact bytes: keep every body raw in this scope (JSON included).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 4096 }, (_req, body, done) =>
      done(null, body),
    );
    scope.post("/iot/ping", async (request, reply) => {
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const header = request.headers["x-signature"];
      const signature = Array.isArray(header) ? header[0] : header;
      if (!signature) {
        options.onReject?.("bad-signature", request.ip);
        return reply.code(401).send({ ok: false });
      }
      const result = options.verifier.verify(raw, signature, request.ip, now());
      if (!result.ok) {
        options.onReject?.(result.reason, request.ip);
        return reply.code(403).send({ ok: false });
      }
      options.onEvent(result.event);
      reply.header("cache-control", "no-store");
      return { ok: true };
    });
  });
}
