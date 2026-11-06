import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextPollDelay, YasnoPoller, type YasnoUpdate, yasnoUrl } from "./yasno.ts";

const live = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../packages/domain/test/fixtures/yasno/live-2026-11-06.json",
      import.meta.url,
    ),
  ),
  "utf8",
);

type Call = { url: string; headers: Record<string, string> };

function fakeFetch(responses: Array<(url: string) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const respond = responses[Math.min(i++, responses.length - 1)];
    if (!respond) throw new Error("no response");
    return respond(url);
  };
  return { fn, calls };
}

const json =
  (body: string, headers: Record<string, string> = {}) =>
  () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });
const html = () => () =>
  new Response("<html>challenge</html>", { status: 200, headers: { "content-type": "text/html" } });

function poller(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  groups = ["12.1", "6.1"],
) {
  const updates: YasnoUpdate[] = [];
  const errors: string[] = [];
  const p = new YasnoPoller({
    region: 25,
    dso: 902,
    groups,
    fetch: fetchFn,
    now: () => 1_000,
    onUpdate: (u) => updates.push(u),
    onError: (e) => errors.push(e),
  });
  return { p, updates, errors };
}

describe("Yasno poller", () => {
  it("polls the origin (cache-busting), parses configured groups, then reports unchanged", async () => {
    const f = fakeFetch([json(live)]);
    const { p, updates } = poller(f.fn);
    const first = await p.pollOnce();
    expect(first.kind).toBe("changed");
    expect(f.calls[0]?.url).toBe(`${yasnoUrl(25, 902)}?_=1000`);
    expect(Object.keys(updates[0]?.groups ?? {})).toEqual(["12.1", "6.1"]);
    expect(updates[0]?.groups["12.1"]?.today.status).toBe("EmergencyShutdowns");
    expect(updates[0]?.source).toBe("origin");
    expect((await p.pollOnce()).kind).toBe("unchanged");
    expect(updates).toHaveLength(1);
  });

  it("a change in another group does not wake us up; a change in ours does", async () => {
    const data = JSON.parse(live) as Record<string, { today: { status: string } }>;
    const otherChanged = structuredClone(data);
    (otherChanged["1.1"] as { today: { status: string } }).today.status = "ScheduleApplies";
    const oursChanged = structuredClone(otherChanged);
    (oursChanged["12.1"] as { today: { status: string } }).today.status = "WaitingForSchedule";
    const f = fakeFetch([
      json(live),
      json(JSON.stringify(otherChanged)),
      json(JSON.stringify(oursChanged)),
    ]);
    const { p } = poller(f.fn);
    expect((await p.pollOnce()).kind).toBe("changed");
    expect((await p.pollOnce()).kind).toBe("unchanged");
    expect((await p.pollOnce()).kind).toBe("changed");
  });

  it("origin challenge (HTML) → CDN fallback with ETag; 304 means unchanged", async () => {
    const f = fakeFetch([
      html(),
      json(live, { etag: '"abc"' }),
      html(),
      () => new Response(null, { status: 304 }),
    ]);
    const { p, updates } = poller(f.fn);
    expect((await p.pollOnce()).kind).toBe("changed");
    expect(updates[0]?.source).toBe("cdn");
    expect(f.calls[1]?.url).toBe(yasnoUrl(25, 902));
    expect(await p.pollOnce()).toMatchObject({ kind: "unchanged", source: "cdn" });
    expect(f.calls[3]?.headers["if-none-match"]).toBe('"abc"');
  });

  it("errors are reported and counted; unexpected shapes fail loudly", async () => {
    const f = fakeFetch([
      () => new Response("x", { status: 503 }),
      () => {
        throw new Error("ECONNRESET");
      },
      json(
        '{"12.1":{"today":{"date":"2026-11-06","status":"ScheduleApplies","slots":[{"start":"0"}]}}}',
      ),
    ]);
    const { p, errors } = poller(f.fn);
    const outcome = await p.pollOnce();
    expect(outcome.kind).toBe("error");
    expect(errors[0]).toMatch(/origin: HTTP 503; cdn: ECONNRESET/);
    expect(await p.pollOnce()).toMatchObject({ kind: "error" });
    expect(errors[1]).toMatch(/unexpected response shape/);
  });

  it("missing configured groups are reported", async () => {
    const f = fakeFetch([json(live)]);
    const { p, updates } = poller(f.fn, ["12.1", "99.9"]);
    await p.pollOnce();
    expect(updates[0]?.missingGroups).toEqual(["99.9"]);
  });

  it("backoff: interval when healthy, doubling with jitter up to the cap", () => {
    const mid = () => 0.5;
    expect(nextPollDelay(0, 20_000, 300_000, mid)).toBe(20_000);
    expect(nextPollDelay(1, 20_000, 300_000, mid)).toBe(40_000);
    expect(nextPollDelay(3, 20_000, 300_000, mid)).toBe(160_000);
    expect(nextPollDelay(10, 20_000, 300_000, mid)).toBe(300_000);
    expect(nextPollDelay(1, 20_000, 300_000, () => 0)).toBe(36_000);
    expect(nextPollDelay(1, 20_000, 300_000, () => 1)).toBe(44_000);
  });
});
