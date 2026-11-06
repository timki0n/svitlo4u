import { useEffect, useState } from "react";
import { Guard } from "./Guard.tsx";
import { HistoryScreen } from "./History.tsx";
import { useLive } from "./live.ts";
import { NowScreen } from "./Now.tsx";
import { ScheduleScreen } from "./Schedule.tsx";
import { Nav, type Tab } from "./ui.tsx";

function tabFromHash(): Tab {
  const hash = location.hash.replace(/^#\/?/, "");
  return hash === "schedule" || hash === "history" ? hash : "now";
}

export function App() {
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
      </Guard>
      <Nav tab={tab} />
    </div>
  );
}
