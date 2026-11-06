/**
 * Replays the real ESP heartbeat timeline from production (2026-11-04..06) through the detector.
 * The legacy bot saw the same data with a 6 s → 20 s threshold; here we check that:
 * - every Wi-Fi gap (uptime continued) stays a gap — no outage, no false alarm;
 * - every real outage (uptime reset) is one off/on pair with exact boundaries;
 * - with a plug, outages are detected after suspect + 2 reads × timeout (9 s) instead of 20 s.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_DETECTOR_CONFIG, type DetectorInput } from "../src/index.ts";
import { espPackets, plugReports, simulate } from "./detector-sim.ts";

type Segment = { from: number; upFrom: number; to: number; upTo: number; packets: number };
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/heartbeat/esp-journal-2026-11.json", import.meta.url)),
    "utf8",
  ),
) as { intervalMs: number; segments: Segment[] };

const segments = fixture.segments;
const packets: DetectorInput[] = segments.flatMap((seg) =>
  espPackets(seg.from, seg.to, seg.upFrom, fixture.intervalMs),
);

const transitions = segments.slice(1).map((next, i) => {
  const prev = segments[i] as Segment;
  return { prev, next, realOutage: next.upFrom < prev.upTo };
});
const outages = transitions.filter((x) => x.realOutage);
const wifiGaps = transitions.filter((x) => !x.realOutage);

describe("replay of the production heartbeat journal", () => {
  it("fixture has 3 real outages and 7 Wi-Fi gaps", () => {
    expect(outages).toHaveLength(3);
    expect(wifiGaps).toHaveLength(7);
    expect(packets.length).toBeGreaterThan(28_000);
  });

  it("ESP only: exact outages, every Wi-Fi gap recognised, no false alarms", () => {
    const { effects } = simulate({
      config: { zigbee: false },
      start: segments[0]?.from ?? 0,
      inputs: packets,
    });
    const power = effects.filter((e) => e.type === "power");
    expect(power).toEqual(
      outages.flatMap(({ prev, next }) => [
        {
          type: "power",
          state: "off",
          at: prev.to,
          detectedAt: prev.to + 20_000,
          reason: "esp-timeout",
          approximate: false,
        },
        {
          type: "power",
          state: "on",
          at: next.from - next.upFrom * 1000,
          detectedAt: next.from,
          reason: "esp-reboot",
          approximate: false,
        },
      ]),
    );
    expect(effects.filter((e) => e.type === "network-gap")).toEqual(
      wifiGaps.map(({ prev, next }) => ({
        type: "network-gap",
        from: prev.to,
        to: next.from,
        confirmedBy: "uptime",
      })),
    );
    expect(effects.filter((e) => e.type === "false-alarm" || e.type === "blip")).toEqual([]);
  });

  it("with a plug: outages detected 9 s after the last packet (two reads), gaps confirmed by the plug", () => {
    // The plug lives on the same mains: it reports while power is on and answers probes only then.
    const powered = (t: number) =>
      segments.some((seg) => t >= seg.from && t <= seg.to) ||
      wifiGaps.some(({ prev, next }) => t > prev.to && t < next.from);
    const reports = segments.flatMap((seg) => plugReports(seg.from + 30_000, seg.to));
    const { effects } = simulate({
      config: { zigbee: true },
      start: segments[0]?.from ?? 0,
      inputs: [...packets, ...reports],
      plug: { answer: (t) => (powered(t) ? 230 : null), latencyMs: 300 },
    });

    const offs = effects.filter((e) => e.type === "power" && e.state === "off");
    expect(offs.map((e) => e.type === "power" && e.detectedAt - e.at)).toEqual(
      outages.map(
        () =>
          DEFAULT_DETECTOR_CONFIG.suspectAfterMs +
          DEFAULT_DETECTOR_CONFIG.probeTimeoutMs * DEFAULT_DETECTOR_CONFIG.probeAttempts,
      ),
    );
    expect(offs.map((e) => e.type === "power" && e.reason)).toEqual(
      outages.map(() => "probe-timeout"),
    );
    expect(effects.filter((e) => e.type === "power" && e.state === "on")).toHaveLength(
      outages.length,
    );
    expect(
      effects
        .filter((e) => e.type === "network-gap")
        .map((e) => e.type === "network-gap" && e.confirmedBy),
    ).toEqual(wifiGaps.map(() => "zigbee"));
    expect(effects.filter((e) => e.type === "false-alarm" || e.type === "blip")).toEqual([]);
  });
});
