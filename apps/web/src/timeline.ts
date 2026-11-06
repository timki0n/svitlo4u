/**
 * Geometry of the day for drawing: what happened up to now and what is planned after it.
 * The numbers (totals, forecast) come from the API; this only cuts intervals into pieces to draw.
 */

export type Interval = { start: number; end: number };
export type OutageLike = { start: number; end: number | null };
/** on / off: what really happened; plan: planned outage ahead; last: last schedule, not in force. */
export type PieceKind = "on" | "off" | "plan" | "last";
export type Piece = Interval & { kind: PieceKind };

function merge(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/**
 * The day as pieces: before `now` — light or no light by real outages; after `now` — the planned
 * outage windows (`aheadKind`), the rest left empty.
 */
export function dayPieces(
  day: Interval,
  now: number,
  outages: readonly OutageLike[],
  plannedOff: readonly Interval[],
  aheadKind: "plan" | "last" = "plan",
): Piece[] {
  const pastEnd = Math.min(Math.max(now, day.start), day.end);
  const pieces: Piece[] = [];
  if (pastEnd > day.start) {
    const offs = merge(
      outages.map((o) => ({
        start: Math.max(o.start, day.start),
        end: Math.min(o.end ?? now, pastEnd),
      })),
    );
    let cursor = day.start;
    for (const off of offs) {
      if (off.start > cursor) pieces.push({ start: cursor, end: off.start, kind: "on" });
      pieces.push({ ...off, kind: "off" });
      cursor = off.end;
    }
    if (cursor < pastEnd) pieces.push({ start: cursor, end: pastEnd, kind: "on" });
  }
  for (const w of merge(plannedOff)) {
    const start = Math.max(w.start, pastEnd);
    const end = Math.min(w.end, day.end);
    if (start < end) pieces.push({ start, end, kind: aheadKind });
  }
  return pieces;
}

/** Pieces cut to [from, to). */
export function clipPieces(pieces: readonly Piece[], from: number, to: number): Piece[] {
  return pieces
    .map((p) => ({ ...p, start: Math.max(p.start, from), end: Math.min(p.end, to) }))
    .filter((p) => p.end > p.start);
}

/** Moments where light appeared or went (inside the day, before now). */
export function changes(pieces: readonly Piece[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < pieces.length; i++) {
    const prev = pieces[i - 1];
    const cur = pieces[i];
    if (!prev || !cur) continue;
    const real = (k: PieceKind) => k === "on" || k === "off";
    if (real(prev.kind) && real(cur.kind) && prev.kind !== cur.kind && cur.start === prev.end) {
      out.push(cur.start);
    }
  }
  return out;
}

/** Start and end of each planned window inside the day (labels for a day still ahead). */
export function windowEdges(plannedOff: readonly Interval[], day: Interval): number[] {
  const edges = new Set<number>();
  for (const w of merge(plannedOff)) {
    if (w.start > day.start && w.start < day.end) edges.add(w.start);
    if (w.end > day.start && w.end < day.end) edges.add(w.end);
  }
  return [...edges].sort((a, b) => a - b);
}

/**
 * Labels that fit side by side: «now» always stays, the others only with room around them
 * (widths in percent of the band; short flips a few minutes apart would print over each other).
 */
export function spacedMarks<T extends { at: number; now?: boolean }>(
  marks: readonly T[],
  from: number,
  to: number,
  width = { now: 26, other: 14 },
): T[] {
  const inside = marks.filter((m) => m.at >= from && m.at < to);
  const box = (m: T) => labelBox(pct(m.at, from, to), m.now ? width.now : width.other);
  const GAP = 2;
  const kept = inside.filter((m) => m.now);
  for (const m of inside.filter((x) => !x.now).sort((a, b) => a.at - b.at)) {
    const [left, right] = box(m);
    const fits = kept.every((k) => {
      const [kl, kr] = box(k);
      return right + GAP <= kl || kr + GAP <= left;
    });
    if (fits) kept.push(m);
  }
  return kept.sort((a, b) => a.at - b.at);
}

/** How a label sits at position p (percent): centred, or pinned to the start/end near an edge. */
export function labelAnchor(p: number): "start" | "middle" | "end" {
  return p > 80 ? "end" : p < 12 ? "start" : "middle";
}

/** The span [left, right] in percent that a label of width w takes at position p. */
export function labelBox(p: number, w: number): [number, number] {
  const anchor = labelAnchor(p);
  if (anchor === "end") return [p - w, p];
  if (anchor === "start") return [p, p + w];
  return [p - w / 2, p + w / 2];
}

/** Position inside [from, to) in percent. */
export function pct(t: number, from: number, to: number): number {
  return ((t - from) / (to - from)) * 100;
}
