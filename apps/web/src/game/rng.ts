/** Seeded randomness: the same key gives the same puzzle on every phone. */
export type Rng = () => number;

/** FNV-1a: a short string key → 32-bit seed. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 seeded from the key. */
export function rngOf(key: string): Rng {
  let a = seedOf(key);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
export const ri = (rng: Rng, n: number): number => Math.floor(rng() * n);

export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = ri(rng, i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}
