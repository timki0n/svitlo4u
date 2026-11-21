import { useEffect, useState } from "react";
import { api, type Outage, type PastDay, type TimelineDay } from "./api.ts";
import { addDays, dayLabel, hhmm, zoned } from "./format.ts";
import type { Live } from "./live.ts";
import {
  changes,
  clipPieces,
  dayPieces,
  labelAnchor,
  type Piece,
  pct,
  spacedMarks,
} from "./timeline.ts";
import { ConnectionNotice, Header, Icon, LegendItem, Segmented, SiteName, Split } from "./ui.tsx";

type Which = "yesterday" | "today" | "tomorrow";

const HOUR = 3_600_000;

export function ScheduleScreen({ live }: { live: Live }) {
  const [which, setWhich] = useState<Which>("today");
  const { site, state, widget } = live;
  // «Вчора»: the day as it went, read when asked (it does not change any more).
  const yesterday = site ? addDays(zoned(live.now, site.tz).date, -1) : null;
  const key = site && yesterday ? `${site.id}/${yesterday}` : null;
  const [past, setPast] = useState<{ key: string; data: PastDay } | null>(null);
  const [pastFailed, setPastFailed] = useState(false);
  const pastReady = past !== null && past.key === key;

  useEffect(() => {
    if (which !== "yesterday" || !site || !yesterday || !key || pastReady) return;
    const ctrl = new AbortController();
    setPastFailed(false);
    api.day(site.id, yesterday, ctrl.signal).then(
      (data) => setPast({ key, data }),
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        console.error(e);
        setPastFailed(true);
      },
    );
    return () => ctrl.abort();
  }, [which, site, yesterday, key, pastReady]);

  const day =
    which === "yesterday"
      ? pastReady
        ? past.data.day
        : undefined
      : widget?.timeline.days[which === "today" ? 0 : 1];
  return (
    <main className="screen">
      <Header>{site && <SiteName name={site.name} />}</Header>
      <h1 className="sr-only">Графік</h1>
      <Segmented
        label="День"
        value={which}
        onChange={setWhich}
        options={[
          ["yesterday", "Вчора"],
          ["today", "Сьогодні"],
          ["tomorrow", "Завтра"],
        ]}
      />
      {site && (
        <ConnectionNotice connection={live.connection} updatedAt={live.updatedAt} tz={site.tz} />
      )}
      {which === "yesterday" && pastFailed ? (
        <p className="notice" role="alert">
          Не вдалося отримати вчорашній день. Спробуйте трохи пізніше.
        </p>
      ) : !site || !widget || !day ? (
        <div className="skeleton" style={{ flex: 1, minHeight: 400 }} />
      ) : (
        <DayView
          live={live}
          day={day}
          today={which === "today"}
          past={which === "yesterday" && pastReady ? past.data.actual : null}
          updatedOn={which === "yesterday" ? null : (state?.schedule?.updatedOn ?? null)}
        />
      )}
    </main>
  );
}

/** Whether the day has anything to draw: a schedule, or emergency shutdowns. */
export function drawable(day: TimelineDay): boolean {
  const published = day.status === "ScheduleApplies" || day.status === "NoOutages";
  return (
    day.segments.length > 0 &&
    (published || day.overlay === "emergency" || day.status === "EmergencyShutdowns")
  );
}

export function DayView({
  live,
  day,
  today,
  past = null,
  updatedOn,
  showDate = true,
}: {
  live: Live;
  day: TimelineDay;
  today: boolean;
  /** A day that is over («Вчора»): its real outages. The fact line then covers the whole day. */
  past?: readonly Outage[] | null;
  updatedOn: string | null;
  /** The status line of another day names its date (the picture has it in its title instead). */
  showDate?: boolean;
}) {
  const tz = live.site?.tz ?? "Europe/Kyiv";
  const now = live.now;
  const first = day.segments[0];
  const last = day.segments[day.segments.length - 1];
  const emergency = day.overlay === "emergency";
  const over = past !== null;

  // A day that is over is drawn by its facts even without a schedule.
  if (!first || !last || (!over && !drawable(day))) {
    return <NoSchedule waiting={day.status === "WaitingForSchedule"} today={today} />;
  }

  const range = { start: first.start, end: last.end };
  const plannedOff = day.segments.filter((s) => s.kind === "off");
  const actual = today ? (live.widget?.timeline.actual ?? []) : (past ?? []);
  // The cells carry the plan for the whole day; a thin line above them, what really happened.
  const plan: Piece[] = plannedOff.map((s) => ({
    start: s.start,
    end: s.end,
    kind: emergency ? "last" : "plan",
  }));
  const fact = today
    ? dayPieces(range, now, actual, [])
    : over
      ? dayPieces(range, range.end, actual, [])
      : [];
  // The row above the cells belongs to the fact only: times of real changes and «now».
  const marks: { at: number; text: string; now?: boolean }[] = changes(fact).map((at) => ({
    at,
    text: hhmm(at, tz),
  }));
  if (today && now >= range.start && now < range.end)
    marks.push({ at: now, text: `зараз ${hhmm(now, tz)}`, now: true });
  const updated = updatedOn ? hhmm(Date.parse(updatedOn), tz) : null;

  let status: React.ReactNode;
  if (over) {
    const what =
      emergency || day.status === "EmergencyShutdowns"
        ? emergency
          ? "екстрені — графік не діяв"
          : "екстрені відключення · графіка не було"
        : day.status === "NoOutages"
          ? "відключень не планували"
          : day.status === "ScheduleApplies"
            ? "графік діяв"
            : "графіка не було";
    status = (
      <p className="muted" style={{ marginTop: -4, fontSize: 13 }}>
        {dayLabel(day.date)} · {what}
      </p>
    );
  } else if (emergency || day.status === "EmergencyShutdowns") {
    status = (
      <p className="warn-line" style={{ marginTop: -4 }}>
        <Icon name="warn" size={16} color="var(--warn)" />
        {emergency ? "Екстрені — графік не діє" : "Екстрені відключення · графіка немає"}
      </p>
    );
  } else {
    const what = day.status === "NoOutages" ? "Відключень не заплановано" : "Графік діє";
    status = (
      <p className="muted" style={{ marginTop: -4, fontSize: 13 }}>
        {today || !showDate ? what : `${dayLabel(day.date)} · ${what.toLowerCase()}`}
        {updated && ` · оновлено о ${updated}`}
      </p>
    );
  }

  const expected = over ? null : (day.totals?.expected ?? null);
  const done = day.totals?.past ?? null;
  return (
    <>
      {status}
      <section className="card schedule-card" aria-label={`Графік: ${day.label}`}>
        <div
          className="bands"
          role="img"
          aria-label={describe(day, [...fact, ...plan], tz, today ? now : null)}
        >
          {[0, 1, 2, 3].map((q) => (
            <Band
              key={q}
              from={range.start + q * 6 * 3_600_000}
              to={q === 3 ? range.end : range.start + (q + 1) * 6 * 3_600_000}
              firstHour={q * 6}
              emergency={emergency || day.status === "EmergencyShutdowns"}
              plan={plan}
              fact={fact}
              now={today ? now : over ? range.end : null}
              marks={marks}
            />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {expected ? (
            <>
              <div className="card-head">
                <span className="small-label">
                  {today ? "Очікується за добу" : "Очікується за планом"}
                </span>
                {today && plannedOff.length > 0 && <LegendItem kind="plan">План</LegendItem>}
              </div>
              <Split
                onMs={expected.onMs}
                offMs={expected.offMs}
                onKind={today ? "bar-on" : "light-plan"}
                offKind={today ? "bar-off" : "plan"}
              />
            </>
          ) : (
            <>
              {over ? (
                <div className="card-head">
                  <span className="small-label">Було за добу</span>
                  {plannedOff.length > 0 &&
                    (emergency ? (
                      <LegendItem kind="last">Останній графік</LegendItem>
                    ) : (
                      <LegendItem kind="plan">План</LegendItem>
                    ))}
                </div>
              ) : (
                emergency && (
                  <div className="card-head">
                    <LegendItem kind="last">Останній графік</LegendItem>
                  </div>
                )
              )}
              {done && (
                <Split onMs={done.onMs} offMs={done.offMs} onKind="bar-on" offKind="bar-off" />
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}

/**
 * One 6-hour band. Hour boundaries do not cut outages. On a DST day (23 or 25 hours) the last band
 * is an hour shorter or longer and its hour labels are only approximate.
 */
function Band({
  from,
  to,
  firstHour,
  plan,
  fact,
  now,
  marks,
  emergency,
}: {
  from: number;
  to: number;
  firstHour: number;
  /** Emergency shutdowns: the schedule does not hold, red stripes over the cells. */
  emergency: boolean;
  plan: readonly Piece[];
  fact: readonly Piece[];
  /** Today: the fact line ends here, the rest of it is still ahead. */
  now: number | null;
  marks: readonly { at: number; text: string; now?: boolean }[];
}) {
  const planned = clipPieces(plan, from, to);
  const happened = clipPieces(fact, from, to);
  const inside = marks.filter((m) => m.at >= from && m.at < to);
  const labels = spacedMarks(marks, from, to);
  const ahead = now === null ? from : Math.min(Math.max(now, from), to);
  const nowHere = now !== null && now >= from && now < to;
  const span = (start: number, end: number) => ({
    left: `${pct(start, from, to)}%`,
    width: `${pct(end, from, to) - pct(start, from, to)}%`,
  });
  /** «08:00», or the plan's edge when a window starts or ends inside the hour: «08:30». */
  const edges = plan.flatMap((p) => [p.start, p.end]);
  const hourLabel = (h: number) => {
    const start = from + h * HOUR;
    const edge = edges.find((e) => e > start && e < start + HOUR);
    const minutes = edge === undefined ? 0 : Math.round((edge - start) / 60_000);
    return `${String(firstHour + h).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  };
  return (
    <div className="band">
      <div className="band-marks" aria-hidden="true">
        {labels.map((m) => {
          const p = pct(m.at, from, to);
          const anchor = labelAnchor(p);
          const shift =
            anchor === "end"
              ? "translateX(-100%)"
              : anchor === "start"
                ? "none"
                : "translateX(-50%)";
          return (
            <span key={m.at} style={{ left: `${p}%`, transform: shift }}>
              {m.text}
            </span>
          );
        })}
      </div>
      <div className="fact-line" aria-hidden="true">
        {happened.map((piece) => (
          <span
            key={piece.start}
            className="fact"
            data-kind={piece.kind}
            style={span(piece.start, piece.end)}
          />
        ))}
        {/* A day ahead has no fact yet: its line stays empty, the labels mark the plan. */}
        {now !== null && ahead < to && (
          <span className="fact-ahead" style={{ left: `${pct(ahead, from, to)}%` }} />
        )}
        {now !== null &&
          inside
            .filter((m) => !m.now)
            .map((m) => (
              <span key={m.at} className="fact-tick" style={{ left: `${pct(m.at, from, to)}%` }} />
            ))}
      </div>
      <div className="band-track" aria-hidden="true" data-emergency={emergency ? "" : undefined}>
        {/* The hours lie under the plan: its hatch is drawn over them. */}
        {[0, 1, 2, 3, 4, 5].map((h) => (
          <span key={`h${h}`} className="hour-label" style={{ left: `${((h + 0.5) / 6) * 100}%` }}>
            {hourLabel(h)}
          </span>
        ))}
        {planned.map((piece) => (
          <span
            key={piece.start}
            className="piece"
            data-kind={piece.kind}
            style={span(piece.start, piece.end)}
          />
        ))}
        {[1, 2, 3, 4, 5].map((h) => (
          <span key={h} className="hour-line" style={{ left: `${(h / 6) * 100}%` }} />
        ))}
      </div>
      {nowHere && <span className="band-now" style={{ left: `${pct(now, from, to)}%` }} />}
    </div>
  );
}

function describe(day: TimelineDay, pieces: readonly Piece[], tz: string, now: number | null) {
  const words: Record<Piece["kind"], string> = {
    on: "світло",
    off: "без світла",
    plan: "за планом без світла",
    last: "в останньому графіку без світла",
  };
  const end = (t: number) => (t >= (day.segments.at(-1)?.end ?? t) ? "24:00" : hhmm(t, tz));
  const parts = pieces.map((p) => `${words[p.kind]} ${hhmm(p.start, tz)}–${end(p.end)}`);
  if (now !== null) parts.push(`зараз ${hhmm(now, tz)}`);
  return `${day.label}: ${parts.join("; ")}.`;
}

function NoSchedule({ waiting, today }: { waiting: boolean; today: boolean }) {
  return (
    <section className="card empty" aria-labelledby="empty-h">
      <div className="empty-icon" aria-hidden="true">
        <Icon name="calendar" size={30} color="var(--muted)" />
      </div>
      <h2 id="empty-h">
        {waiting
          ? `Графік на ${today ? "сьогодні" : "завтра"} ще не опубліковано`
          : "Графік зараз недоступний"}
      </h2>
      <p>
        {waiting
          ? "Зазвичай він з'являється ввечері. Щойно його опублікують, він з'явиться тут."
          : "Спробуйте трохи пізніше — дані оновлюються самі."}
      </p>
    </section>
  );
}
