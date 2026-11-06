import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Site, type State, type Widget } from "./api.ts";

export type Connection = "live" | "reconnecting" | "offline";

export type Live = {
  site: Site | null;
  state: State | null;
  widget: Widget | null;
  /** Server time now (the phone's clock may be off; the core's clock decides). */
  now: number;
  connection: Connection;
  /** When the data was last confirmed by the core. */
  updatedAt: number | null;
  error: boolean;
};

const TICK_MS = 20_000;
/** A dropped stream is "reconnecting" first; after this long the data is called out as stale. */
const OFFLINE_AFTER_MS = 45_000;
/** Even with a live stream the widget is re-read now and then (durations age, the day moves). */
const WIDGET_MAX_AGE_MS = 5 * 60_000;

/**
 * Live state of the first configured site: REST for the first paint, then the SSE stream.
 * Any event re-reads state and widget (they are small); the "state" event carries the state itself.
 */
export function useLive(): Live {
  const [site, setSite] = useState<Site | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [widget, setWidget] = useState<Widget | null>(null);
  const [connection, setConnection] = useState<Connection>("reconnecting");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [, setTick] = useState(0);
  const offset = useRef(0);
  const pending = useRef<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .sites(ctrl.signal)
      .then(({ sites }) => {
        setSite(sites[0] ?? null);
        if (!sites[0]) setError(true);
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) {
          console.error(e);
          setError(true);
        }
      });
    return () => ctrl.abort();
  }, []);

  const refresh = useCallback(async () => {
    if (!site) return;
    try {
      const [s, w] = await Promise.all([api.state(site.id), api.widget(site.id)]);
      offset.current = w.now - Date.now();
      setState(s);
      setWidget(w);
      setUpdatedAt(w.now);
      setError(false);
    } catch (e) {
      console.error(e);
      setError(true);
    }
  }, [site]);

  /** Coalesce bursts of events into one re-read. */
  const refreshSoon = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = window.setTimeout(() => {
      pending.current = null;
      void refresh();
    }, 250);
  }, [refresh]);

  // first read + stream
  useEffect(() => {
    if (!site) return;
    void refresh();
    const es = new EventSource(api.eventsUrl(site.id));
    let lostAt: number | null = null;
    let offlineTimer: number | null = null;
    es.onopen = () => {
      setConnection("live");
      if (lostAt !== null) refreshSoon(); // whatever happened meanwhile
      lostAt = null;
      if (offlineTimer !== null) window.clearTimeout(offlineTimer);
    };
    es.onerror = () => {
      if (lostAt === null) lostAt = Date.now();
      setConnection("reconnecting");
      if (offlineTimer === null)
        offlineTimer = window.setTimeout(() => {
          offlineTimer = null;
          if (lostAt !== null) setConnection("offline");
        }, OFFLINE_AFTER_MS);
    };
    es.addEventListener("state", (e) => {
      const s = JSON.parse((e as MessageEvent<string>).data) as State;
      offset.current = s.now - Date.now();
      setState(s);
      setUpdatedAt(s.now);
    });
    for (const name of [
      "power",
      "false-alarm",
      "schedule",
      "reminder",
      "voltage",
      "voltage-alert",
      "voltage-stabilized",
    ]) {
      es.addEventListener(name, refreshSoon);
    }
    return () => {
      es.close();
      if (offlineTimer !== null) window.clearTimeout(offlineTimer);
    };
  }, [site, refresh, refreshSoon]);

  // clock tick, planned re-reads, and catching up after the phone wakes
  useEffect(() => {
    const tick = window.setInterval(() => setTick((n) => n + 1), TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setTick((n) => n + 1);
        refreshSoon();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshSoon]);

  useEffect(() => {
    if (!widget) return;
    const now = Date.now() + offset.current;
    const at = Math.min(widget.refreshAt, widget.now + WIDGET_MAX_AGE_MS);
    const timer = window.setTimeout(refreshSoon, Math.max(1000, at - now));
    return () => window.clearTimeout(timer);
  }, [widget, refreshSoon]);

  return {
    site,
    state,
    widget,
    now: Date.now() + offset.current,
    connection,
    updatedAt,
    error,
  };
}
