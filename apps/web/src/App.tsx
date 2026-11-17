import { lazy, Suspense, useEffect, useState } from "react";
import { AboutScreen } from "./About.tsx";
import { AddScreen } from "./Add.tsx";
import { Guard } from "./Guard.tsx";
import { HistoryScreen } from "./History.tsx";
import { useLive } from "./live.ts";
import { MineScreen } from "./Mine.tsx";
import { NowScreen } from "./Now.tsx";
import { RenderSchedule } from "./Render.tsx";
import { ScheduleScreen } from "./Schedule.tsx";
import { Header, Nav, type Tab } from "./ui.tsx";

/** The game (its puzzles and the facade) loads only when opened. */
const GameScreen = lazy(() => import("./game/GameScreen.tsx"));

function tabFromHash(): Tab {
  const hash = location.hash.replace(/^#\/?/, "");
  if (hash === "game" || hash.startsWith("game/")) return "game";
  // «Мої будинки» (the button by the building's name) and «Знайти мій будинок» from there;
  // «Про проєкт» (the link at the right of the header)
  if (hash === "my" || hash.startsWith("my/")) return "my"; // #/my/<id>: one of my buildings
  if (hash === "add" || hash === "about") return hash;
  return hash === "schedule" || hash === "history" ? hash : "now";
}

/** #/render/<site>/<today|tomorrow>: the schedule picture for Telegram (see Render.tsx). */
function renderTarget(): { siteId: string; which: "today" | "tomorrow" } | null {
  const m = /^#\/render\/([a-z0-9][a-z0-9-]*)\/(today|tomorrow)$/.exec(location.hash);
  return m ? { siteId: m[1] as string, which: m[2] as "today" | "tomorrow" } : null;
}

/** The building in the address (/<id>), or null: the person's own or the default (/, /my). */
function siteFromPath(): string | null {
  const path = location.pathname.replace(/\/+$/, "");
  if (path === "/my") return null;
  const m = /^\/([a-z0-9][a-z0-9-]{0,39})$/.exec(path);
  return m ? (m[1] as string) : null;
}

/** The bot's «Мої будинки» opens /my: the same screen as #/my, so the tabs work from there. */
function openMy(): void {
  if (location.pathname.replace(/\/+$/, "") === "/my")
    history.replaceState(null, "", `/${location.search}#/my`);
}

export function App() {
  openMy();
  const render = renderTarget();
  if (render) return <RenderSchedule siteId={render.siteId} which={render.which} />;
  return <Site siteId={siteFromPath()} />;
}

function Site({ siteId }: { siteId: string | null }) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  // «Назад» from a sub-screen returns to the tab it was opened from.
  const [lastMain, setLastMain] = useState<Tab>("now");
  const back = lastMain === "now" ? "#/" : `#/${lastMain}`;
  const live = useLive(siteId);

  useEffect(() => {
    if (tab !== "my" && tab !== "add" && tab !== "about") setLastMain(tab);
  }, [tab]);

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

  if (live.notFound) {
    return (
      <div className="app">
        <main className="screen card empty">
          <h2>Такого будинку немає</h2>
          <p>Перевірте адресу. Можливо, посилання застаріло.</p>
          <a className="button" href="/">
            На головну
          </a>
        </main>
      </div>
    );
  }

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
        {tab === "my" && <MineScreen live={live} back={back} />}
        {tab === "add" && <AddScreen />}
        {tab === "about" && <AboutScreen back={back} />}
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
      <Nav tab={tab} site={live.site} />
    </div>
  );
}
