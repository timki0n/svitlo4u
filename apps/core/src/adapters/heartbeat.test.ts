import { createHmac } from "node:crypto";
import { createSocket } from "node:dgram";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { EspDeviceConfig } from "../sites-config.ts";
import {
  type HeartbeatEvent,
  HttpHeartbeatVerifier,
  registerIotRoutes,
  signV2,
  startUdpHeartbeat,
  UdpHeartbeatVerifier,
} from "./heartbeat.ts";

const udpDevice: EspDeviceConfig = {
  id: "esp-4u",
  kind: "esp",
  transport: "udp",
  secretEnv: "X",
  legacyIps: ["192.168.0.225"],
  siteId: "4u",
  secret: "udp-secret",
};
const httpDevice: EspDeviceConfig = {
  id: "esp-g6",
  kind: "esp",
  transport: "http",
  secretEnv: "Y",
  legacyIps: [],
  siteId: "g6",
  secret: "http-secret",
};

const packet = (
  boot: string,
  seq: number,
  up: number,
  secret = udpDevice.secret,
  rst = "poweron",
) =>
  JSON.stringify({
    v: 2,
    dev: "esp-4u",
    boot,
    seq,
    up,
    rst,
    sig: signV2(secret, "esp-4u", boot, seq, up, rst),
  });

describe("UDP heartbeat verifier", () => {
  it("signature matches an independent implementation (docs/esp-protocol.md test vector)", () => {
    // Python: hmac.new(b"test-secret", b"2|esp-4u|9f3a1c2e|1234|5678|poweron", sha256).digest()[:16].hex()
    expect(signV2("test-secret", "esp-4u", "9f3a1c2e", 1234, 5678, "poweron")).toBe(
      "e4a113039c6c786f1b9cf03a3ad5623c",
    );
  });

  it("accepts signed v2 packets and reports uptime, boot id and reset reason", () => {
    const v = new UdpHeartbeatVerifier([udpDevice]);
    expect(v.verify(packet("b1", 1, 5), "10.0.0.5", 1000)).toEqual({
      ok: true,
      event: {
        siteId: "4u",
        deviceId: "esp-4u",
        t: 1000,
        up: 5,
        boot: "b1",
        resetReason: "poweron",
        transport: "udp",
        remote: "10.0.0.5",
      },
    });
  });

  it("the reset reason is signed: changing it breaks the signature", () => {
    const v = new UdpHeartbeatVerifier([udpDevice]);
    const forged = packet("b1", 1, 5).replace('"rst":"poweron"', '"rst":"panic"');
    expect(v.verify(forged, "x", 0)).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("rejects forged, malformed and unknown packets", () => {
    const v = new UdpHeartbeatVerifier([udpDevice]);
    expect(v.verify(packet("b1", 1, 5, "wrong"), "x", 0)).toMatchObject({
      ok: false,
      reason: "bad-signature",
    });
    expect(v.verify("not json", "x", 0)).toMatchObject({ ok: false, reason: "malformed" });
    expect(v.verify(JSON.stringify({ v: 2, dev: "esp-4u" }), "x", 0)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(v.verify(packet("b1", 1, 5).replace('"esp-4u"', '"esp-x"'), "x", 0)).toMatchObject({
      ok: false,
      reason: "unknown-device",
    });
  });

  it("rejects replays within a boot and packets of an earlier boot", () => {
    const v = new UdpHeartbeatVerifier([udpDevice]);
    expect(v.verify(packet("b1", 10, 20), "x", 0).ok).toBe(true);
    expect(v.verify(packet("b1", 10, 20), "x", 0)).toMatchObject({ ok: false, reason: "replay" });
    expect(v.verify(packet("b1", 9, 19), "x", 0)).toMatchObject({ ok: false, reason: "replay" });
    expect(v.verify(packet("b2", 1, 3), "x", 0).ok).toBe(true); // reboot
    expect(v.verify(packet("b1", 11, 21), "x", 0)).toMatchObject({ ok: false, reason: "replay" });
  });

  it("legacy {ping} packets only from allow-listed addresses", () => {
    const v = new UdpHeartbeatVerifier([udpDevice]);
    expect(v.verify('{"ping":12318}', "192.168.0.225", 7)).toEqual({
      ok: true,
      event: {
        siteId: "4u",
        deviceId: "esp-4u",
        t: 7,
        up: 12318,
        boot: null,
        resetReason: null,
        transport: "udp-legacy",
        remote: "192.168.0.225",
      },
    });
    expect(v.verify('{"ping":1}', "192.168.0.99", 7)).toMatchObject({
      ok: false,
      reason: "legacy-not-allowed",
    });
  });
});

describe("UDP heartbeat server", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it("receives real datagrams on localhost", async () => {
    const events: HeartbeatEvent[] = [];
    const rejected: string[] = [];
    const server = await startUdpHeartbeat({
      port: 0,
      host: "127.0.0.1",
      verifier: new UdpHeartbeatVerifier([{ ...udpDevice, legacyIps: ["127.0.0.1"] }]),
      onEvent: (e) => events.push(e),
      onReject: (reason) => rejected.push(reason),
      now: () => 42,
    });
    close = server.close;
    const client = createSocket("udp4");
    const send = (msg: string) =>
      new Promise<void>((resolve, reject) =>
        client.send(msg, server.port, "127.0.0.1", (e) => (e ? reject(e) : resolve())),
      );
    await send(packet("b1", 1, 5));
    await send('{"ping":77}');
    await send(packet("b1", 1, 5)); // replay
    await new Promise((r) => setTimeout(r, 100));
    client.close();
    expect(events.map((e) => [e.transport, e.up])).toEqual([
      ["udp", 5],
      ["udp-legacy", 77],
    ]);
    expect(rejected).toEqual(["replay"]);
  });
});

describe("HTTP heartbeat (light_bot_tg firmware)", () => {
  const sign = (body: string, secret: string) =>
    createHmac("sha256", secret).update(body).digest("hex");

  async function app() {
    const events: HeartbeatEvent[] = [];
    const server = Fastify();
    registerIotRoutes(server, {
      verifier: new HttpHeartbeatVerifier([udpDevice, httpDevice]),
      onEvent: (e) => events.push(e),
      now: () => 5,
    });
    await server.ready();
    return { server, events };
  }

  it("a correctly signed body identifies the device", async () => {
    const { server, events } = await app();
    const body = JSON.stringify({ uptime: 321 });
    const response = await server.inject({
      method: "POST",
      url: "/iot/ping",
      payload: body,
      headers: { "content-type": "application/json", "x-signature": sign(body, "http-secret") },
    });
    expect(response.statusCode).toBe(200);
    expect(events).toMatchObject([
      { siteId: "g6", deviceId: "esp-g6", up: 321, transport: "http" },
    ]);
    await server.close();
  });

  it("missing signature → 401, wrong secret (even another device's UDP secret) → 403", async () => {
    const { server, events } = await app();
    const body = "{}";
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/iot/ping",
          payload: body,
          headers: { "content-type": "application/json" },
        })
      ).statusCode,
    ).toBe(401);
    const forged = await server.inject({
      method: "POST",
      url: "/iot/ping",
      payload: body,
      headers: { "content-type": "application/json", "x-signature": sign(body, "udp-secret") },
    });
    expect(forged.statusCode).toBe(403);
    expect(events).toEqual([]);
    await server.close();
  });
});
