import { useEffect, useRef, useState } from "react";
import { api, type Site, type State, type Widget } from "./api.ts";
import { dayLabel } from "./format.ts";
import type { Live } from "./live.ts";
import { DayView, drawable } from "./Schedule.tsx";

/**
 * The schedule card as a picture for Telegram: no navigation, fixed width. The core's headless
 * browser opens #/render/<site>/<today|tomorrow>, waits for [data-ready] and screenshots
 * [data-render]; [data-empty] means there is nothing to draw (no schedule yet, an error).
 */
export function RenderSchedule({ siteId, which }: { siteId: string; which: "today" | "tomorrow" }) {
  const [data, setData] = useState<{ site: Site | null; state: State; widget: Widget } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.render = "";
    Promise.all([api.sites(), api.state(siteId), api.widget(siteId)])
      .then(([{ sites }, state, widget]) =>
        setData({ site: sites.find((s) => s.id === siteId) ?? null, state, widget }),
      )
      .catch((e: unknown) => {
        console.error(e);
        setFailed(true);
      });
  }, [siteId]);

  useEffect(() => {
    if (!data && !failed) return;
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() => root.current?.setAttribute("data-ready", "")),
    );
  }, [data, failed]);

  const day = data?.widget.timeline.days[which === "today" ? 0 : 1];
  if (failed || !data?.site || !day || !drawable(day)) {
    return <div ref={root} data-render="" data-empty="" />;
  }
  const live: Live = {
    site: data.site,
    state: data.state,
    widget: data.widget,
    now: data.widget.now,
    connection: "live",
    updatedAt: data.widget.now,
    error: false,
  };

  return (
    <div ref={root} className="render" data-render="">
      <header className="render-head">
        <div>
          <span className="label">{data.site.name}</span>
          <h1 className="title">Графік на {which === "today" ? "сьогодні" : "завтра"}</h1>
        </div>
        <span className="render-date">{dayLabel(day.date)}</span>
      </header>
      <DayView
        live={live}
        day={day}
        today={which === "today"}
        updatedOn={data.state.schedule?.updatedOn ?? null}
        showDate={false}
      />
      <p className="render-foot">svitlo4u.info</p>
    </div>
  );
}
