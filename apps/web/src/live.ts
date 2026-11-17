import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Me, type Site, type State, type Widget } from "./api.ts";
import { inMiniApp, tgStartParam } from "./telegram.ts";

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
  /** The address names a building that does not exist. */
  notFound: boolean;
  /** In the Mini App: who opened it, their building and hubs; null elsewhere or before it loads. */
  me: Me | null;
};

const REMEMBER = "svitlo4u.site";
/** The buildings this browser showed lately, newest first («Нещодавні» in «Мої будинки»). */
const RECENT = "svitlo4u.recent";
const RECENT_MAX = 8;

export type SiteRef = { id: string; name: string };

export function recentSites(): SiteRef[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RECENT) ?? "[]");
    return Array.isArray(list)
      ? list.flatMap((x) => {
          const r = x as Partial<SiteRef> | null;
          return typeof r?.id === "string" && typeof r.name === "string"
            ? [{ id: r.id, name: r.name }]
            : [];
        })
      : [];
  } catch {
    return [];
  }
}

function saveRecent(list: SiteRef[]): SiteRef[] {
  try {
    localStorage.setItem(RECENT, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // storage blocked: nothing to keep
  }
  return list;
}

/** Drop a building from «Нещодавні»; the list left. */
export function forgetRecent(id: string): SiteRef[] {
  return saveRecent(recentSites().filter((r) => r.id !== id));
}

function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBER);
  } catch {
    return null;
  }
}

function remember(siteId: string): void {
  try {
    localStorage.setItem(REMEMBER, siteId);
  } catch {
    // storage blocked: the address still works
  }
}

/** A building by id; null when there is none. */
async function siteById(id: string, signal: AbortSignal): Promise<Site | null> {
  try {
    return await api.site(id, signal);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Which building to show: the one in the address (/<id>); else, in the Mini App, the link's or
 * the person's own; else the one this browser opened last; else the default (ЖК 4U).
 */
async function chooseSite(
  requested: string | null,
  me: Me | null,
  signal: AbortSignal,
): Promise<Site | null> {
  if (requested) return siteById(requested, signal);
  const candidates = [tgStartParam(), me?.siteId ?? null, remembered()];
  for (const id of candidates) {
    if (!id) continue;
    const found = await siteById(id, signal);
    if (found) return found;
  }
  const { sites, defaultSiteId } = await api.sites(signal);
  return sites.find((s) => s.id === defaultSiteId) ?? sites[0] ?? null;
}

const TICK_MS = 20_000;
/** A dropped stream is "reconnecting" first; after this long the data is called out as stale. */
const OFFLINE_AFTER_MS = 45_000;
/** Even with a live stream the widget is re-read now and then (durations age, the day moves). */
const WIDGET_MAX_AGE_MS = 5 * 60_000;

/**
 * Live state of a building (see chooseSite): REST for the first paint, then the SSE stream.
 * Any event re-reads state and widget (they are small); the "state" event carries the state itself.
 */
export function useLive(requested: string | null): Live {
  const [site, setSite] = useState<Site | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [notFound, setNotFound] = useState(false);
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
    (async () => {
      const mine = inMiniApp() ? await api.me().catch(() => null) : null;
      if (ctrl.signal.aborted) return;
      setMe(mine);
      const chosen = await chooseSite(requested, mine, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (!chosen) {
        if (requested) setNotFound(true);
        else setError(true);
        return;
      }
      setSite(chosen);
      saveRecent([
        { id: chosen.id, name: chosen.name },
        ...recentSites().filter((r) => r.id !== chosen.id),
      ]);
      // A building opened by its address becomes this browser's (and the person's) own.
      if (requested) {
        remember(chosen.id);
        if (mine && mine.siteId !== chosen.id) api.setMySite(chosen.id).then(setMe, () => {});
      }
    })().catch((e: unknown) => {
      if (!ctrl.signal.aborted) {
        console.error(e);
        setError(true);
      }
    });
    return () => ctrl.abort();
  }, [requested]);

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
    notFound,
    me,
  };
}
