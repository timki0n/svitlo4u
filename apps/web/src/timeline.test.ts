import { describe, expect, it } from "vitest";
import { changes, clipPieces, dayPieces, spacedMarks, windowEdges } from "./timeline.ts";

const H = 3_600_000;
const M = 60_000;
const day = { start: 0, end: 24 * H };
const t = (h: number, m = 0) => h * H + m * M;

describe("day pieces", () => {
  const outages = [
    { start: t(8, 2), end: t(11, 20) },
    { start: t(15, 30), end: t(17, 22) },
  ];
  const plan = [
    { start: t(8), end: t(12) },
    { start: t(20), end: t(24) },
  ];

  it("fact up to now, plan after it", () => {
    const pieces = dayPieces(day, t(19, 37), outages, plan);
    expect(pieces.map((p) => [p.kind, p.start / M, p.end / M])).toEqual([
      ["on", 0, 8 * 60 + 2],
      ["off", 8 * 60 + 2, 11 * 60 + 20],
      ["on", 11 * 60 + 20, 15 * 60 + 30],
      ["off", 15 * 60 + 30, 17 * 60 + 22],
      ["on", 17 * 60 + 22, 19 * 60 + 37],
      ["plan", 20 * 60, 24 * 60],
    ]);
    expect(changes(pieces).map((x) => x / M)).toEqual([482, 680, 930, 1042]);
  });

  it("an ongoing outage runs to now; the rest of a running window is still plan", () => {
    const pieces = dayPieces(day, t(21), [{ start: t(20, 1), end: null }], plan, "last");
    expect(pieces.slice(-2).map((p) => [p.kind, p.start / M, p.end / M])).toEqual([
      ["off", 20 * 60 + 1, 21 * 60],
      ["last", 21 * 60, 24 * 60],
    ]);
  });

  it("a day ahead is only plan; bands cut it in six-hour parts", () => {
    const pieces = dayPieces(day, -H, [], plan);
    expect(pieces.map((p) => p.kind)).toEqual(["plan", "plan"]);
    expect(clipPieces(pieces, t(6), t(12)).map((p) => [p.start / H, p.end / H])).toEqual([[8, 12]]);
    expect(windowEdges(plan, day).map((x) => x / H)).toEqual([8, 12, 20]);
  });
});

describe("labels above a band", () => {
  it("keep «now», drop the ones that would overlap", () => {
    const marks = [
      { at: t(19, 11) },
      { at: t(19, 13) },
      { at: t(19, 59) },
      { at: t(22, 21), now: true },
      { at: t(22, 40) },
    ];
    const kept = spacedMarks(marks, t(18), t(24)).map((m) => m.at / M);
    expect(kept).toEqual([19 * 60 + 11, 22 * 60 + 21]);
  });

  it("a label pinned to the end of the band takes its room to the left", () => {
    // «зараз 23:35» sits right-aligned and covers 22:21, though their centres are far apart
    const marks = [{ at: t(22, 21) }, { at: t(23, 35), now: true }];
    expect(spacedMarks(marks, t(18), t(24)).map((m) => m.at / M)).toEqual([23 * 60 + 35]);
  });
});
