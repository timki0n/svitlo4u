import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HubReportEvent } from "../adapters/hub.ts";
import { ManualClock } from "../runtime/clock.ts";
import {
  checkHubImage,
  compareVersions,
  FirmwareService,
  inspectHubImage,
  loadFirmwareConfig,
  pickHubFirmware,
} from "./firmware.ts";
import { fakeHubImage } from "./firmware-fixture.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function report(over: Partial<HubReportEvent> = {}): HubReportEvent {
  return {
    siteId: "hub-test",
    deviceId: "hub-2a4c11",
    t: 0,
    boot: "b1",
    seq: 3,
    up: 100,
    rst: "sw",
    fw: "0.2.0",
    paired: true,
    mains: "on",
    mainsSince: 10,
    voltage: 228,
    rssi: -60,
    linkGaps: 0,
    longestGap: 0,
    alertDelay: 8,
    rssiAvg: -55,
    events: [],
    ota: { state: "idle", version: null, error: null, rejected: null },
    remote: "127.0.0.1",
    ...over,
  };
}

describe("hub firmware images", () => {
  it("reads the version, project and chip from the image", () => {
    expect(inspectHubImage(fakeHubImage("0.2.1"))).toEqual({
      chip: 13,
      version: "0.2.1",
      project: "svitlo4u_hub",
    });
    expect(inspectHubImage(Buffer.alloc(4096))).toBeNull();
  });

  it("accepts only an ESP32-C6 svitlo4u_hub image of the expected version", () => {
    expect(checkHubImage(fakeHubImage("0.2.1"), "0.2.1")).toBeNull();
    expect(checkHubImage(fakeHubImage("0.2.0"), "0.2.1")).toMatch(/version/);
    expect(checkHubImage(fakeHubImage("0.2.1", { chip: 5 }), "0.2.1")).toMatch(/chip/);
    expect(checkHubImage(fakeHubImage("0.2.1", { project: "other" }), "0.2.1")).toMatch(/project/);
    expect(checkHubImage(fakeHubImage("0.2.1", { size: 0x1d0001 }), "0.2.1")).toMatch(/big/);
  });

  it("compares versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(["0.2.10", "0.2.9", "1.0.0"].sort(compareVersions)).toEqual([
      "0.2.9",
      "0.2.10",
      "1.0.0",
    ]);
  });
});

describe("which firmware a hub gets", () => {
  const available = ["0.2.0", "0.2.1", "0.3.0"];

  it("latest: the newest, upgrades only", () => {
    expect(pickHubFirmware("latest", "0.2.0", available, null)).toBe("0.3.0");
    expect(pickHubFirmware("latest", "0.3.0", available, null)).toBeNull();
    expect(pickHubFirmware("latest", "0.4.0", available, null)).toBeNull();
    expect(pickHubFirmware("latest", null, available, null)).toBe("0.3.0");
  });

  it("never a version the hub rolled back", () => {
    expect(pickHubFirmware("latest", "0.2.0", available, "0.3.0")).toBe("0.2.1");
    expect(pickHubFirmware("0.3.0", "0.2.0", available, "0.3.0")).toBeNull();
  });

  it("a pin also downgrades; off is off", () => {
    expect(pickHubFirmware("0.2.0", "0.3.0", available, null)).toBe("0.2.0");
    expect(pickHubFirmware("0.2.0", "0.2.0", available, null)).toBeNull();
    expect(pickHubFirmware("0.9.0", "0.2.0", available, null)).toBeNull();
    expect(pickHubFirmware("off", "0.1.0", available, null)).toBeNull();
  });
});

describe("FirmwareService", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "svitlo-fw-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const good = fakeHubImage("0.2.1");
  const mislabeled = fakeHubImage("0.2.2");
  const asset = (tag: string, data: Buffer, digest = sha(data)) => ({
    name: "svitlo4u_hub.bin",
    size: data.length,
    digest: `sha256:${digest}`,
    browser_download_url: `https://github.com/o/r/releases/download/${tag}/svitlo4u_hub.bin`,
  });
  const releases = [
    {
      tag_name: "hub-v0.2.1",
      draft: false,
      prerelease: false,
      assets: [asset("hub-v0.2.1", good)],
    },
    // the image inside says 0.2.2
    {
      tag_name: "hub-v0.2.3",
      draft: false,
      prerelease: false,
      assets: [asset("hub-v0.2.3", mislabeled)],
    },
    // bytes differ from the digest
    {
      tag_name: "hub-v0.2.4",
      draft: false,
      prerelease: false,
      assets: [asset("hub-v0.2.4", fakeHubImage("0.2.4"), "0".repeat(64))],
    },
    { tag_name: "hub-v0.9.0", draft: false, prerelease: true, assets: [asset("hub-v0.9.0", good)] },
    { tag_name: "v1.0.0", draft: false, prerelease: false, assets: [] },
  ];

  function network() {
    const calls: string[] = [];
    const r2 = new Map<string, Buffer>();
    const fetch = async (request: Request): Promise<Response> => {
      calls.push(`${request.method} ${request.url}`);
      const url = new URL(request.url);
      if (url.host === "api.github.com") return Response.json(releases);
      if (url.host === "github.com") {
        const tag = url.pathname.split("/")[5];
        const data = {
          "hub-v0.2.1": good,
          "hub-v0.2.3": mislabeled,
          "hub-v0.2.4": fakeHubImage("0.2.4"),
        }[tag as string];
        return data ? new Response(new Uint8Array(data)) : new Response("", { status: 404 });
      }
      if (url.host === "acc.r2.cloudflarestorage.com") {
        expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
        if (request.method === "HEAD") {
          const object = r2.get(url.pathname);
          return new Response(null, {
            status: object ? 200 : 404,
            headers: object ? { "content-length": String(object.length) } : {},
          });
        }
        if (request.method === "PUT") {
          r2.set(url.pathname, Buffer.from(await request.arrayBuffer()));
          return new Response("", { status: 200 });
        }
      }
      return new Response("", { status: 500 });
    };
    return { calls, r2, fetch };
  }

  const s3 = {
    endpoint: "https://acc.r2.cloudflarestorage.com",
    bucket: "backups",
    accessKeyId: "key",
    secretAccessKey: "secret",
    prefix: "svitlo4u/",
  };

  it("mirrors good releases into the cache and R2, offers presigned URLs", async () => {
    const net = network();
    const service = new FirmwareService({
      config: { dir, repo: "o/r", s3 },
      clock: new ManualClock(Date.UTC(2026, 10, 15)),
      fetch: net.fetch,
    });
    await service.refresh();
    expect(service.status.error).toBeNull();
    expect(service.versions()).toEqual(["0.2.1"]);
    expect(existsSync(join(dir, "hub-0.2.1.bin"))).toBe(true);
    expect([...net.r2.keys()]).toEqual(["/backups/svitlo4u/firmware/hub/svitlo4u_hub-0.2.1.bin"]);
    expect(net.r2.get("/backups/svitlo4u/firmware/hub/svitlo4u_hub-0.2.1.bin")?.equals(good)).toBe(
      true,
    );

    const offer = await service.offer("latest", report());
    expect(offer).toMatchObject({ version: "0.2.1", size: good.length, sha256: sha(good) });
    const url = new URL(offer?.url as string);
    expect(url.origin + url.pathname).toBe(
      "https://acc.r2.cloudflarestorage.com/backups/svitlo4u/firmware/hub/svitlo4u_hub-0.2.1.bin",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    // Nothing is fetched twice: neither the mirrored release nor the ones that failed the checks.
    const before = net.calls.length;
    await service.refresh();
    expect(net.calls.slice(before)).toEqual([
      "GET https://api.github.com/repos/o/r/releases?per_page=30",
    ]);
  });

  it("without R2 the hub downloads from the core; images put by hand count", async () => {
    writeFileSync(join(dir, "hub-0.3.0.bin"), fakeHubImage("0.3.0"));
    writeFileSync(join(dir, "hub-0.4.0.bin"), fakeHubImage("0.3.9")); // lies about its version
    const service = new FirmwareService({
      config: { dir, repo: null, s3: null },
      clock: new ManualClock(0),
    });
    service.scan();
    expect(service.versions()).toEqual(["0.3.0"]);
    expect((await service.offer("latest", report()))?.url).toBe("/iot/hub/firmware/hub-0.3.0.bin");
  });

  it("offers only when the hub can update and nothing would be blurred by the restart", async () => {
    writeFileSync(join(dir, "hub-0.3.0.bin"), fakeHubImage("0.3.0"));
    const service = new FirmwareService({
      config: { dir, repo: null, s3: null },
      clock: new ManualClock(0),
    });
    service.scan();
    const idle = { state: "idle", version: null, error: null, rejected: null } as const;
    expect(await service.offer("latest", report())).not.toBeNull();
    expect(await service.offer("latest", report({ ota: null }))).toBeNull(); // firmware without updates
    expect(await service.offer("latest", report({ mains: "off" }))).toBeNull();
    expect(await service.offer("latest", report({ events: [{ up: 90, mains: "on" }] }))).toBeNull();
    expect(
      await service.offer(
        "latest",
        report({ ota: { ...idle, state: "downloading", version: "0.3.0" } }),
      ),
    ).toBeNull();
    expect(
      await service.offer("latest", report({ ota: { ...idle, rejected: "0.3.0" } })),
    ).toBeNull();
    expect(await service.offer("off", report())).toBeNull();
    // a failed attempt is offered again (the hub itself waits before retrying)
    expect(
      await service.offer(
        "latest",
        report({ ota: { ...idle, state: "failed", version: "0.3.0", error: "read" } }),
      ),
    ).not.toBeNull();
  });

  it("config: the cache next to the database, this repository by default", () => {
    expect(loadFirmwareConfig({}, "/data/svitlo4u.db", null)).toEqual({
      dir: join("/data", "firmware"),
      repo: "timki0n/svitlo4u",
      s3: null,
    });
    expect(loadFirmwareConfig({ FIRMWARE_REPO: "off" }, "/data/x.db", null)?.repo).toBeNull();
    expect(loadFirmwareConfig({}, ":memory:", null)).toBeNull();
    expect(() => loadFirmwareConfig({ FIRMWARE_REPO: "x" }, "/data/x.db", null)).toThrow(
      /owner\/name/,
    );
  });
});
