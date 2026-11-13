/**
 * A board left half done, kept on this phone: going off to other windows and coming back finds it
 * as it was. Kept per window of an outage (the board's key holds the outage), forgotten once it is
 * solved, started over or a day old.
 */

const PREFIX = "svitlo4u.board:";
/** Older than this, a board kept is long over: its outage has ended. */
const KEEP_MS = 24 * 3600_000;

/** What a board kept: its game's own state, and how long it had been played. */
export type KeptBoard = { state: unknown; ms: number };

/** The name a board is kept under: its window (of an outage) and its game. */
export const boardName = (key: string, game: string) => `${PREFIX}${key}:${game}`;

export function loadBoard(name: string): KeptBoard | null {
  try {
    const raw = localStorage.getItem(name);
    if (!raw) return null;
    const kept = JSON.parse(raw) as { at?: unknown; ms?: unknown; state?: unknown };
    if (typeof kept.at !== "number" || Date.now() - kept.at > KEEP_MS) {
      localStorage.removeItem(name);
      return null;
    }
    return { state: kept.state, ms: typeof kept.ms === "number" ? kept.ms : 0 };
  } catch {
    return null;
  }
}

export function saveBoard(name: string, state: unknown, ms: number): void {
  try {
    localStorage.setItem(name, JSON.stringify({ at: Date.now(), ms: Math.round(ms), state }));
    forgetOld();
  } catch {
    // full or shut: the board is just not kept
  }
}

export function dropBoard(name: string): void {
  try {
    localStorage.removeItem(name);
  } catch {
    // nothing kept to drop
  }
}

/** The boards kept longer than a day: gone. */
function forgetOld() {
  const now = Date.now();
  for (let k = localStorage.length - 1; k >= 0; k--) {
    const name = localStorage.key(k);
    if (!name?.startsWith(PREFIX)) continue;
    try {
      const at = (JSON.parse(localStorage.getItem(name) ?? "{}") as { at?: unknown }).at;
      if (typeof at !== "number" || now - at > KEEP_MS) localStorage.removeItem(name);
    } catch {
      localStorage.removeItem(name);
    }
  }
}
