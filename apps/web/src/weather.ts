import { useEffect, useState } from "react";
import { api } from "./api.ts";

/**
 * How much of the snowfall shows for the weather's precipitation (/api/v1/weather): nothing, light,
 * moderate, heavy. Rain falls as snow here too.
 */
export const SNOW_AMOUNT = [0, 0.45, 0.72, 1] as const;

/** The amount drifts to the weather's this fast (per second): no flake pops in or out. */
const AMOUNT_RATE = 0.25;

/** The next amount on the way to `target`; the same once there. */
export function towardAmount(amount: number, target: number, dt: number): number {
  const step = AMOUNT_RATE * dt;
  return amount < target ? Math.min(target, amount + step) : Math.max(target, amount - step);
}

/** Asked again this often while the page is seen (the core asks Open-Meteo every 15 minutes). */
const EVERY_MS = 10 * 60_000;

/**
 * How much falls from Kyiv's sky now, 0–3 (/api/v1/weather): rain or snow, the 3D buildings are
 * in snow meanwhile. 0 until it is known; a failed request keeps what was known.
 */
export function usePrecipitation(): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let stopped = false;
    let askedAt = Number.NEGATIVE_INFINITY;
    let ctrl: AbortController | null = null;
    const load = () => {
      if (document.hidden || Date.now() - askedAt < EVERY_MS - 1000) return;
      askedAt = Date.now();
      ctrl?.abort();
      ctrl = new AbortController();
      api.weather(ctrl.signal).then(
        (w) => {
          if (!stopped) setLevel(w.precipitation);
        },
        () => {},
      );
    };
    load();
    const timer = window.setInterval(load, EVERY_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      stopped = true;
      ctrl?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  return level;
}
