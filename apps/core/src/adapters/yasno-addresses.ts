/**
 * YASNO's address search (the one its site uses for «дізнатися чергу»): streets, their houses and
 * the queue of a house. Kyiv for now (region 25, DSO 902). Answers are cached for an hour: the
 * search runs as people type.
 */

export type AddressItem = { id: number; name: string };

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = "https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2";
const TTL_MS = 60 * 60_000;
const MAX_CACHED = 500;
const TIMEOUT_MS = 6_000;

export class YasnoAddresses {
  readonly region: number;
  readonly dso: number;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(options: { region: number; dso: number; fetch?: FetchFn; now?: () => number }) {
    this.region = options.region;
    this.dso = options.dso;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Streets whose name has the text (YASNO's spelling: «вул. Хрещатик»). */
  async streets(query: string): Promise<AddressItem[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    return items(
      await this.get(`streets?regionId=${this.region}&query=${enc(q)}&dsoId=${this.dso}`),
    );
  }

  /** Houses of a street whose number has the text ("" lists them). */
  async houses(streetId: number, query: string): Promise<AddressItem[]> {
    return items(
      await this.get(
        `houses?regionId=${this.region}&streetId=${streetId}&query=${enc(query.trim())}&dsoId=${this.dso}`,
      ),
    );
  }

  /** The house's queue, "12.1"; null when YASNO does not know it. */
  async group(streetId: number, houseId: number): Promise<string | null> {
    const body = await this.get(
      `group?regionId=${this.region}&streetId=${streetId}&houseId=${houseId}&dsoId=${this.dso}`,
    ).catch(() => null);
    const g = body as { group?: unknown; subgroup?: unknown } | null;
    return typeof g?.group === "number" && typeof g.subgroup === "number"
      ? `${g.group}.${g.subgroup}`
      : null;
  }

  private async get(path: string): Promise<unknown> {
    const now = this.now();
    const hit = this.cache.get(path);
    if (hit && now - hit.at < TTL_MS) return hit.value;
    const response = await this.fetchFn(`${BASE}/${path}`, {
      headers: {
        accept: "application/json",
        "user-agent": "svitlo4u/1.0 (+https://svitlo4u.info)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`yasno addresses: HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (this.cache.size >= MAX_CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(path, { at: now, value });
    return value;
  }
}

const enc = (s: string) => encodeURIComponent(s.slice(0, 60));

function items(body: unknown): AddressItem[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((x) => {
    const r = x as { id?: unknown; value?: unknown };
    return typeof r.id === "number" && typeof r.value === "string" && r.value.trim()
      ? [{ id: r.id, name: r.value.trim() }]
      : [];
  });
}
