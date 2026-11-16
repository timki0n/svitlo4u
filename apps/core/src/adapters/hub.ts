/**
 * Hub adapter (docs/hub-protocol.md): POST /iot/hub with X-Signature = hex HMAC-SHA256(secret, raw
 * body). It verifies the report, rejects replays and translates it; the decisions belong to the
 * hub detector. The reply may carry a signed firmware offer (docs/hub-protocol.md → Updates).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { HubMains } from "@svitlo/domain";
import type { FastifyInstance } from "fastify";
import type { HubDeviceConfig } from "../sites-config.ts";

export type HubOtaState = "idle" | "downloading" | "ready" | "failed";

/** What the hub says about updates (absent in firmware without them). */
export type HubOtaStatus = {
  state: HubOtaState;
  /** The version being downloaded / ready / failed. */
  version: string | null;
  error: string | null;
  /** A version that did not confirm itself and was rolled back; the hub never takes it again. */
  rejected: string | null;
};

/** A firmware the hub should take; `url` is absolute or a path on the report server. */
export type HubFirmwareOffer = { version: string; url: string; size: number; sha256: string };

export type HubReportEvent = {
  siteId: string;
  deviceId: string;
  /** When the core received it. */
  t: number;
  boot: string;
  seq: number;
  /** Hub uptime, seconds. */
  up: number;
  rst: string;
  fw: string | null;
  paired: boolean;
  mains: HubMains;
  /** Hub uptime (s) when the current mains verdict began. */
  mainsSince: number | null;
  voltage: number | null;
  rssi: number | null;
  /**
   * Silences of the plug that were the radio, not the mains (this boot), and the longest, s.
   * Null from firmware that does not count them.
   */
  linkGaps: number | null;
  longestGap: number | null;
  events: { up: number; mains: "on" | "off" }[];
  ota: HubOtaStatus | null;
  remote: string;
};

export type HubRejectReason = "malformed" | "unknown-device" | "bad-signature" | "replay";

export type HubVerifyResult =
  | { ok: true; event: HubReportEvent }
  | { ok: false; reason: HubRejectReason; deviceId?: string };

const RECENT_BOOTS = 16;
const MAX_EVENTS = 64;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown, min: number, max: number): number | null | undefined =>
  v === null || v === undefined ? null : isNum(v) && v >= min && v <= max ? v : undefined;

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a.trim().toLowerCase(), "utf8");
  const y = Buffer.from(b.toLowerCase(), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signHub(secret: string, body: Buffer | string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** The offer's signature: binds it to this device and to the report it answers. */
export function signHubOffer(
  secret: string,
  report: Pick<HubReportEvent, "deviceId" | "boot" | "seq">,
  offer: HubFirmwareOffer,
): string {
  const text = [
    "ota",
    report.deviceId,
    report.boot,
    report.seq,
    offer.version,
    offer.size,
    offer.sha256,
  ];
  return signHub(secret, text.join("\n"));
}

const OTA_STATES: readonly string[] = ["idle", "downloading", "ready", "failed"];
const shortText = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

/** Lenient: a strange `ota` must not cost a power report. */
function parseOta(v: unknown): HubOtaStatus | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.state !== "string" || !OTA_STATES.includes(o.state)) return null;
  return {
    state: o.state as HubOtaState,
    version: shortText(o.version, 32),
    error: shortText(o.error, 64),
    rejected: shortText(o.rejected, 32),
  };
}

export class HubVerifier {
  private readonly devices = new Map<string, HubDeviceConfig>();
  private readonly replay = new Map<string, { boot: string; seq: number; recentBoots: string[] }>();

  /**
   * `lookup` finds hubs made at the bench after the start (their secret is in the DB); a hub with
   * no building yet has `siteId` "" — it is answered (and updated) but drives nothing.
   */
  private readonly lookup: (id: string) => HubDeviceConfig | undefined;

  constructor(
    devices: readonly HubDeviceConfig[],
    lookup: (id: string) => HubDeviceConfig | undefined = () => undefined,
  ) {
    for (const d of devices) this.devices.set(d.id, d);
    this.lookup = lookup;
  }

  device(id: string): HubDeviceConfig | undefined {
    const known = this.devices.get(id);
    if (known?.siteId) return known;
    const found = this.lookup(id);
    if (found) this.devices.set(id, found);
    return found ?? known;
  }

  /** A hub got (or changed) its building. */
  set(device: HubDeviceConfig): void {
    this.devices.set(device.id, device);
  }

  verify(raw: Buffer, signature: string | undefined, remote: string, t: number): HubVerifyResult {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "malformed" };
      body = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const dev = body.dev;
    if (typeof dev !== "string") return { ok: false, reason: "malformed" };
    const device = this.device(dev);
    if (!device) return { ok: false, reason: "unknown-device", deviceId: dev.slice(0, 64) };
    if (!signature || !safeEqualHex(signature, signHub(device.secret, raw))) {
      return { ok: false, reason: "bad-signature", deviceId: dev };
    }

    const { v, boot, seq, up, rst, fw, plug, events, ota } = body;
    const p = (typeof plug === "object" && plug !== null ? plug : {}) as Record<string, unknown>;
    const mains = p.mains;
    const mainsSince = numOrNull(p.since, 0, 1e9);
    const voltage = numOrNull(p.voltage, 0, 1000);
    const rssi = numOrNull(p.rssi, -127, 20);
    // Lenient: diagnostics must not cost a power report.
    const linkGaps = numOrNull(p.gaps, 0, 1e9) ?? null;
    const longestGap = numOrNull(p.longestGap, 0, 1e7) ?? null;
    if (
      v !== 1 ||
      typeof boot !== "string" ||
      !/^[0-9a-f]{1,32}$/i.test(boot) ||
      !Number.isInteger(seq) ||
      (seq as number) < 0 ||
      !isNum(up) ||
      up < 0 ||
      typeof rst !== "string" ||
      rst.length > 16 ||
      (mains !== "on" && mains !== "off" && mains !== "unknown") ||
      mainsSince === undefined ||
      voltage === undefined ||
      rssi === undefined ||
      !Array.isArray(events) ||
      events.length > MAX_EVENTS
    ) {
      return { ok: false, reason: "malformed", deviceId: dev };
    }
    const parsedEvents: { up: number; mains: "on" | "off" }[] = [];
    for (const e of events as unknown[]) {
      const ev = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
      if (!isNum(ev.up) || ev.up < 0 || ev.up > up || (ev.mains !== "on" && ev.mains !== "off")) {
        return { ok: false, reason: "malformed", deviceId: dev };
      }
      parsedEvents.push({ up: ev.up, mains: ev.mains });
    }

    const state = this.replay.get(dev);
    if (state) {
      if (boot === state.boot) {
        if ((seq as number) <= state.seq) return { ok: false, reason: "replay", deviceId: dev };
        state.seq = seq as number;
      } else {
        if (state.recentBoots.includes(boot)) return { ok: false, reason: "replay", deviceId: dev };
        state.recentBoots = [...state.recentBoots, boot].slice(-RECENT_BOOTS);
        state.boot = boot;
        state.seq = seq as number;
      }
    } else {
      this.replay.set(dev, { boot, seq: seq as number, recentBoots: [boot] });
    }

    return {
      ok: true,
      event: {
        siteId: device.siteId,
        deviceId: dev,
        t,
        boot,
        seq: seq as number,
        up,
        rst,
        fw: typeof fw === "string" ? fw.slice(0, 32) : null,
        paired: p.paired === true,
        mains,
        mainsSince,
        voltage,
        rssi,
        linkGaps,
        longestGap,
        events: parsedEvents,
        ota: parseOta(ota),
        remote,
      },
    };
  }
}

/** POST /iot/hub — the signature covers the exact bytes, so the body stays raw. */
export function registerHubRoutes(
  app: FastifyInstance,
  options: {
    verifier: HubVerifier;
    onReport: (event: HubReportEvent) => void;
    onReject?: (reason: HubRejectReason, remote: string, deviceId?: string) => void;
    /** A firmware for this hub now, if any (it must not throw away the acknowledgement). */
    offer?: (event: HubReportEvent) => Promise<HubFirmwareOffer | null> | HubFirmwareOffer | null;
    onOfferError?: (error: unknown, event: HubReportEvent) => void;
    now?: () => number;
  },
): void {
  const now = options.now ?? Date.now;
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 8192 }, (_req, body, done) =>
      done(null, body),
    );
    scope.post("/iot/hub", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const header = request.headers["x-signature"];
      const signature = Array.isArray(header) ? header[0] : header;
      const result = options.verifier.verify(raw, signature, request.ip, now());
      if (!result.ok) {
        options.onReject?.(result.reason, request.ip, result.deviceId);
        const code =
          result.reason === "malformed"
            ? 400
            : result.reason === "replay"
              ? 409
              : signature
                ? 403
                : 401;
        return reply.code(code).send({ ok: false });
      }
      const event = result.event;
      options.onReport(event);
      const answer: { ok: true; ack: number; ota?: HubFirmwareOffer & { sig: string } } = {
        ok: true,
        ack: event.seq,
      };
      const device = options.verifier.device(event.deviceId);
      if (options.offer && device) {
        try {
          const offer = await options.offer(event);
          if (offer) answer.ota = { ...offer, sig: signHubOffer(device.secret, event, offer) };
        } catch (error) {
          options.onOfferError?.(error, event);
        }
      }
      return answer;
    });
  });
}
