import { lazy, Suspense, useEffect, useState } from "react";
import { Guard } from "./Guard.tsx";
import { HistoryScreen } from "./History.tsx";
import { useLive } from "./live.ts";
import { NowScreen } from "./Now.tsx";
import { RenderSchedule } from "./Render.tsx";
import { ScheduleScreen } from "./Schedule.tsx";
import { Header, Nav, type Tab } from "./ui.tsx";

/** The game (its puzzles and the facade) loads only when opened. */
const GameScreen = lazy(() => import("./game/GameScreen.tsx"));

function tabFromHash(): Tab {
  const hash = location.hash.replace(/^#\/?/, "");
  if (hash === "game" || hash.startsWith("game/")) return "game";
  return hash === "schedule" || hash === "history" ? hash : "now";
}

/** #/render/<site>/<today|tomorrow>: the schedule picture for Telegram (see Render.tsx). */
function renderTarget(): { siteId: string; which: "today" | "tomorrow" } | null {
  const m = /^#\/render\/([a-z0-9][a-z0-9-]*)\/(today|tomorrow)$/.exec(location.hash);
  return m ? { siteId: m[1] as string, which: m[2] as "today" | "tomorrow" } : null;
}

export function App() {
  const render = renderTarget();
  return render ? <RenderSchedule siteId={render.siteId} which={render.which} /> : <Site />;
}

function Site() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const live = useLive();

  useEffect(() => {
    const onHash = () => {
      setTab(tabFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const name = live.site?.name ?? "ЖК 4U";
    const title = live.widget?.title;
    document.title = title ? `${title} · ${name}` : `Світло · ${name}`;
  }, [live.site, live.widget]);

  return (
    <div className="app">
      {live.error && !live.state && (
        <p className="notice" role="alert">
          Не вдалося отримати дані. Перевірте з'єднання — сторінка спробує ще раз сама.
        </p>
      )}
      <Guard key={tab}>
        {tab === "now" && <NowScreen live={live} />}
        {tab === "schedule" && <ScheduleScreen live={live} />}
        {tab === "history" && <HistoryScreen site={live.site} now={live.now} />}
        {tab === "game" && (
          <Suspense
            fallback={
              <main className="screen">
                <Header>
                  <span className="label">Гра</span>
                </Header>
                <p className="muted">Завантаження…</p>
              </main>
            }
          >
            <GameScreen live={live} />
          </Suspense>
        )}
      </Guard>
      <Nav tab={tab} />
    </div>
  );
}
