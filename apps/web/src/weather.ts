import { useEffect, useState } from "react";
import { api } from "./api.ts";

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
