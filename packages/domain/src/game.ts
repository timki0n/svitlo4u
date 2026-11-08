/**
 * Rules of the window game shared by the web (puzzles) and the core (points, rating).
 * A game session is an outage: it starts when the light goes out and lasts until the next outage.
 */
import { addDays, localDate, localMidnight } from "./time.ts";

/**
 * Residential storeys of the tower (the ground floor is shops) and the windows of a storey, numbered
 * round the tower going right as seen from outside: 1–10 the street side, 11–12 an end, 13–20 the
 * yard side (its open galleries have no windows), 21–22 the other end. The game shows the tower
 * alone (no annex), so every one of them can be played.
 */
export const GAME_FLOORS = { first: 2, last: 27 } as const;
export const GAME_COLS = 22;
export const GAME_WINDOWS = (GAME_FLOORS.last - GAME_FLOORS.first + 1) * GAME_COLS;

export type GameTier = 0 | 1 | 2;

export function isGameWindow(floor: number, col: number): boolean {
  return (
    Number.isInteger(floor) &&
    Number.isInteger(col) &&
    floor >= GAME_FLOORS.first &&
    floor <= GAME_FLOORS.last &&
    col >= 1 &&
    col <= GAME_COLS
  );
}

/** Difficulty from the storey: 2–9, 10–18, 19–27. */
export const gameTier = (floor: number): GameTier => (floor <= 9 ? 0 : floor <= 18 ? 1 : 2);

/** Points for a window: by difficulty; whoever lights it first in the session gets half more. */
export function gamePoints(floor: number, first: boolean): number {
  const base = [10, 20, 30][gameTier(floor)] as number;
  return first ? base + base / 2 : base;
}

/** Key of a session for the puzzles' seeds (the outage start). */
export const gameSessionKey = (start: number): string => `o${start}`;

/** Monday 00:00 (local) of the week holding `now`: the weekly rating starts over then. */
export function gameWeekStart(now: number, tz: string): number {
  const today = localDate(now, tz);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return localMidnight(addDays(today, -((weekday + 6) % 7)), tz);
}
