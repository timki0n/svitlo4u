import {
  closeDatabase,
  createStore,
  type Db,
  type OutboxItem,
  openDatabase,
} from "@svitlo/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../runtime/clock.ts";
import { type DeliveryResult, MAX_AGE_MS, Outbox } from "./outbox.ts";

const T0 = Date.UTC(2026, 10, 10, 6, 0, 0);

let db: Db;
let store: ReturnType<typeof createStore>;
let clock: ManualClock;
beforeEach(() => {
  db = openDatabase(":memory:");
  store = createStore(db);
  store.sites.upsert({
    id: "4u",
    name: "ЖК 4U",
    tz: "Europe/Kyiv",
    yasnoRegion: 25,
    yasnoDso: 902,
    yasnoGroup: "12.1",
  });
  clock = new ManualClock(T0);
});
afterEach(() => closeDatabase(db));

/** A sender that answers from a script, then "sent" forever. */
function scripted(...results: DeliveryResult[]) {
  const calls: { target: string; text: string; at: number }[] = [];
  const send = async (item: OutboxItem): Promise<DeliveryResult> => {
    calls.push({
      target: item.target,
      text: (JSON.parse(item.payloadJson) as { text: string }).text,
      at: clock.now(),
    });
    return results.shift() ?? { status: "sent" };
  };
  return { calls, send };
}

function setup(sender: ReturnType<typeof scripted>) {
  const undelivered: { item: OutboxItem; error: string }[] = [];
  const outbox = new Outbox({
    store,
    clock,
    senders: new Map([["telegram", sender.send]]),
    onUndelivered: (item, error) => undelivered.push({ item, error }),
  });
  outbox.start();
  return { outbox, undelivered };
}

const msg = (target: string, text: string, dedupeKey?: string) => ({
  siteId: "4u",
  channel: "telegram",
  target,
  kind: "power",
  payload: { text },
  ...(dedupeKey ? { dedupeKey } : {}),
});

const network: DeliveryResult = { status: "retry", error: "network: ECONNRESET" };

describe("Outbox", () => {
  it("sends at once, in parallel for different targets", async () => {
    const sender = scripted();
    const { outbox } = setup(sender);
    expect(outbox.enqueue([msg("1", "a"), msg("2", "a")])).toBe(2);
    await outbox.idle();
    expect(sender.calls.map((c) => [c.target, c.at])).toEqual([
      ["1", T0],
      ["2", T0],
    ]);
    expect(store.outbox.pending()).toEqual([]);
  });

  it("does not enqueue the same dedupe key twice", async () => {
    const sender = scripted();
    const { outbox } = setup(sender);
    expect(outbox.enqueue([msg("1", "a", "power:off:1")])).toBe(1);
    expect(outbox.enqueue([msg("1", "a", "power:off:1")])).toBe(0);
    await outbox.idle();
    expect(sender.calls).toHaveLength(1);
  });

  it("retries network errors with backoff 5 s, 10 s, 15 s …", async () => {
    const sender = scripted(network, network, network);
    const { outbox } = setup(sender);
    outbox.enqueue([msg("1", "a")]);
    await outbox.idle();
    for (const step of [5_000, 10_000, 15_000]) {
      clock.advanceBy(step - 1);
      await outbox.idle();
      clock.advanceBy(1);
      await outbox.idle();
    }
    expect(sender.calls.map((c) => c.at - T0)).toEqual([0, 5_000, 15_000, 30_000]);
    expect(store.outbox.pending()).toEqual([]);
  });

  it("gives up after 30 minutes and reports it once", async () => {
    const sender = scripted(...Array.from({ length: 50 }, () => network));
    const { outbox, undelivered } = setup(sender);
    outbox.enqueue([msg("1", "a")]);
    await outbox.idle();
    for (let t = 0; t <= MAX_AGE_MS + 60_000; t += 5_000) {
      clock.advanceTo(T0 + t);
      await outbox.idle();
    }
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0]?.error).toMatch(/30 хв/);
    expect(store.outbox.pending()).toEqual([]);
    expect(sender.calls.at(-1)?.at).toBeLessThan(T0 + MAX_AGE_MS);
  });

  it("does not retry permanent errors; quiet ones are not reported", async () => {
    const sender = scripted(
      { status: "failed", error: "400 Bad Request: chat not found" },
      { status: "failed", error: "403 Forbidden: bot was blocked by the user", quiet: true },
    );
    const { outbox, undelivered } = setup(sender);
    outbox.enqueue([msg("1", "a"), msg("2", "a")]);
    await outbox.idle();
    clock.advanceBy(60_000);
    await outbox.idle();
    expect(sender.calls).toHaveLength(2);
    expect(undelivered.map((u) => u.item.target)).toEqual(["1"]);
  });

  it("keeps the order per target; a new message pulls a waiting retry forward", async () => {
    const sender = scripted(network);
    const { outbox } = setup(sender);
    outbox.enqueue([msg("1", "off")]);
    await outbox.idle();
    expect(sender.calls.map((c) => c.text)).toEqual(["off"]);

    // 2 s later power is back; the "off" retry was due only at +5 s.
    clock.advanceBy(2_000);
    outbox.enqueue([msg("1", "on")]);
    await outbox.idle();
    expect(sender.calls.map((c) => [c.text, c.at - T0])).toEqual([
      ["off", 0],
      ["off", 2_000],
      ["on", 2_000],
    ]);
  });

  it("any new message retries the site's waiting messages at once, except 429 waits", async () => {
    const sender = scripted(network, {
      status: "retry",
      error: "429 Too Many Requests: retry after 60",
      retryAt: T0 + 60_000,
    });
    const { outbox } = setup(sender);
    outbox.enqueue([msg("1", "a"), msg("2", "a")]);
    await outbox.idle();
    clock.advanceBy(1_000);
    outbox.enqueue([msg("3", "b")]);
    await outbox.idle();
    expect(sender.calls.map((c) => [c.target, c.at - T0])).toEqual([
      ["1", 0],
      ["2", 0],
      ["1", 1_000],
      ["3", 1_000],
    ]);
    clock.advanceTo(T0 + 60_000);
    await outbox.idle();
    expect(sender.calls.at(-1)).toMatchObject({ target: "2", at: T0 + 60_000 });
  });

  it("a success retries the site's waiting messages at once (connectivity is back)", async () => {
    const sender = scripted(network);
    const { outbox } = setup(sender);
    outbox.enqueue([msg("1", "a")]);
    await outbox.idle();
    // A message enqueued directly (e.g. by another process) and sent on the next pass.
    store.outbox.enqueue(msg("2", "b"), clock.now());
    store.outbox.markFailed(2, "network: ECONNRESET", T0 + 180_000);
    clock.advanceBy(5_000); // "1" retries and succeeds → "2" goes right away, not at +180 s
    await outbox.idle();
    expect(sender.calls.map((c) => [c.target, c.at - T0])).toEqual([
      ["1", 0],
      ["1", 5_000],
      ["2", 5_000],
    ]);
  });

  it("delivers what was pending before a restart; expired items are dropped", async () => {
    store.outbox.enqueue(msg("1", "old"), T0 - MAX_AGE_MS - 1);
    store.outbox.enqueue(msg("1", "fresh"), T0 - 60_000);
    const sender = scripted();
    const { outbox, undelivered } = setup(sender);
    await outbox.idle();
    expect(sender.calls.map((c) => c.text)).toEqual(["fresh"]);
    expect(undelivered).toHaveLength(1);
  });

  it("follows a chat that moved to a supergroup", async () => {
    const sender = scripted({ status: "redirect", error: "400 migrated", target: "-1009" });
    const { outbox } = setup(sender);
    outbox.enqueue([msg("-1", "a")]);
    await outbox.idle();
    expect(sender.calls.map((c) => c.target)).toEqual(["-1", "-1009"]);
  });
});
