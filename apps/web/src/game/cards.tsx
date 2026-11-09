/**
 * What the card tables of «Вечорниці» share: a card face, a player's win or loss, and the oval
 * table — where the seats sit round it for a measured size.
 */
import { type RefObject, useEffect, useState } from "react";

export const SUITS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

/** A card, its rank over its suit; without one, its back. */
export function CardFace({
  card,
  size,
}: {
  card?: string | undefined;
  size: "mini" | "open" | "board" | "big";
}) {
  if (!card) return <span className="g-card g-card-back" data-size={size} />;
  const rank = card[0] === "T" ? "10" : card[0];
  const suit = card[1] ?? "";
  return (
    <span className="g-card" data-size={size} data-red={suit === "h" || suit === "d" || undefined}>
      <span className="g-card-rank">{rank}</span>
      {SUITS[suit]}
    </span>
  );
}

/** A player's win or loss in the hand just played. */
export function Net({ net }: { net: number }) {
  return (
    <span className="g-net" data-up={net > 0 || undefined}>
      {net > 0 ? `+${net}` : `−${-net}`}
    </span>
  );
}

/** An element's size, kept up to date. */
export function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 340, h: 440 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export type Point = { x: number; y: number };

/**
 * Where everything sits round an oval table of w × h: six places clockwise from the bottom (me),
 * the chips each puts in front of them, the felt, and the middle for the board. A place is the
 * centre of a face: its cards peek out above it, its name plate hangs below. The seats keep to
 * bands above and below the board, so nothing lies on anything; a short screen gets it compact.
 */
export function tableLayout(w: number, h: number) {
  const compact = h < 420;
  const up = compact ? 30 : 36; // from a face's centre up to its cards' top
  const down = compact ? 50 : 56; // down to its plate's bottom (with a hand's name)
  const pad = 6;
  const side = (compact ? 34 : 38) + pad;
  const top = up + pad;
  const upper = top + (compact ? 56 : 70);
  const lower = h - down - pad - (compact ? 48 : 58);
  const mine = compact ? 82 : 92; // my own cards and plate, at the bottom
  const inward = compact ? 54 : 60;
  return {
    compact,
    places: [
      { x: w / 2, y: h - down - pad },
      { x: side, y: lower },
      { x: side, y: upper },
      { x: w / 2, y: top },
      { x: w - side, y: upper },
      { x: w - side, y: lower },
    ] as Point[],
    chips: [
      { x: w / 2, y: h - pad - mine - 12 },
      { x: side + inward, y: lower - 4 },
      { x: side + inward, y: upper + 10 },
      { x: w / 2, y: top + down + 14 },
      { x: w - side - inward, y: upper + 10 },
      { x: w - side - inward, y: lower - 4 },
    ] as Point[],
    felt: { left: side, right: side, top, bottom: down + pad },
    middle: (upper + down + lower - up) / 2,
    /** The round games' middle: between the top seat's plate and my own plate at the bottom. */
    column: (top + down + h - pad - 34) / 2,
  };
}

/** Which of the six places the players take, by how many sit: across from one another. */
export const PLACES: Record<number, number[]> = {
  1: [0],
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 2, 3, 4],
  5: [0, 1, 2, 4, 5],
  6: [0, 1, 2, 3, 4, 5],
};

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
