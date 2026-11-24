/**
 * The weather in Kyiv from Open-Meteo (open-meteo.com, CC BY 4.0), every 15 minutes: whether
 * anything falls from the sky and how much. While it does, the 3D buildings on the site are in
 * snow — rain and drizzle too. The core asks, not the visitors' browsers: one request for everyone,
 * and no visitor's address goes to a third party.
 */
import type { Clock, Timer } from "../runtime/clock.ts";

/** 0 nothing falls (or not known), 1 light, 2 moderate, 3 heavy. */
export type Precipitation = 0 | 1 | 2 | 3;

export type WeatherNow = {
  precipitation: Precipitation;
  /** WMO weather code, as Open-Meteo gives it. */
  code: number | null;
  /** °C. */
  temperature: number | null;
  /** The model's 15-minute step it is for. */
  at: number | null;
};

export const NO_WEATHER: WeatherNow = { precipitation: 0, code: null, temperature: null, at: null };

/** The city centre: the buildings are all in Kyiv, a few kilometres do not change the sky. */
export const KYIV = { latitude: 50.45, longitude: 30.52 };

export const WEATHER_EVERY_MS = 15 * 60_000;
const RETRY_MS = 3 * 60_000;
/** Older than this, the weather is not known any more: no snow rather than an old one. */
export const WEATHER_STALE_MS = 75 * 60_000;
const TIMEOUT_MS = 15_000;

/** WMO codes of drizzle, rain, snow, showers and thunderstorms: how much falls. */
const FALLING: Record<number, Precipitation> = {
  51: 1,
  53: 2,
  55: 3,
  56: 1,
  57: 2,
  61: 1,
  63: 2,
  65: 3,
  66: 1,
  67: 2,
  71: 1,
  73: 2,
  75: 3,
  77: 1,
  80: 1,
  81: 2,
  82: 3,
  85: 1,
  86: 3,
  95: 2,
  96: 3,
  99: 3,
};

/** How much falls: by the weather code, or by the millimetres of the last 15 minutes. */
export function precipitationOf(code: number | null, mm: number | null): Precipitation {
  const byCode = code === null ? 0 : (FALLING[code] ?? 0);
  const byAmount = mm === null || mm <= 0 ? 0 : mm < 0.5 ? 1 : mm < 2 ? 2 : 3;
  return Math.max(byCode, byAmount) as Precipitation;
}

export function weatherUrl(place: { latitude: number; longitude: number } = KYIV): string {
  return (
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${place.latitude}&longitude=${place.longitude}` +
    "&current=weather_code,precipitation,temperature_2m&timeformat=unixtime"
  );
}

/** Open-Meteo's answer → the weather now; null when it is not the answer expected. */
export function parseWeather(body: unknown): WeatherNow | null {
  const current = (body as { current?: Record<string, unknown> } | null)?.current;
  if (!current || typeof current.time !== "number") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const code = num(current.weather_code);
  return {
    precipitation: precipitationOf(code, num(current.precipitation)),
    code,
    temperature: num(current.temperature_2m),
    at: current.time * 1000,
  };
}

export type WeatherDeps = {
  clock: Clock;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
};

export class WeatherService {
  private readonly deps: WeatherDeps;
  private last: WeatherNow = NO_WEATHER;
  private timer: Timer | null = null;
  private failing = false;
  private stopped = false;

  constructor(deps: WeatherDeps) {
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    this.deps.clock.clearTimer(this.timer);
    this.timer = null;
  }

  /** The latest weather; nothing falls once it is too old to trust. */
  now(): WeatherNow {
    const { at } = this.last;
    if (at === null || this.deps.clock.now() - at > WEATHER_STALE_MS) return NO_WEATHER;
    return this.last;
  }

  /** One request now (tests call it directly), then the next one is planned. */
  async poll(): Promise<void> {
    const { clock, log } = this.deps;
    const fetchFn = this.deps.fetch ?? fetch;
    let ok = false;
    try {
      const response = await fetchFn(weatherUrl(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const weather = parseWeather(await response.json());
      if (!weather) throw new Error("unexpected answer");
      if (weather.precipitation !== this.last.precipitation) {
        log.info({ ...weather }, "weather: precipitation changed");
      }
      this.last = weather;
      ok = true;
      if (this.failing) log.info({}, "weather: Open-Meteo answers again");
      this.failing = false;
    } catch (err) {
      // once per streak: the site simply shows no snow meanwhile
      if (!this.failing) log.warn({ err }, "weather: Open-Meteo request failed");
      this.failing = true;
    }
    if (this.stopped) return;
    this.timer = clock.setTimer(clock.now() + (ok ? WEATHER_EVERY_MS : RETRY_MS), () => {
      void this.poll();
    });
  }
}
