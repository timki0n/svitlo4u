import { useState } from "react";
import type { TimelineDay } from "./api.ts";
import { dayLabel, hhmm } from "./format.ts";
import type { Live } from "./live.ts";
import {
  changes,
  clipPieces,
  dayPieces,
  type Piece,
  pct,
  spacedMarks,
  windowEdges,
} from "./timeline.ts";
import { ConnectionNotice, Header, Icon, LegendItem, Segmented, Split } from "./ui.tsx";

type Which = "today" | "tomorrow";

export function ScheduleScreen({ live }: { live: Live }) {
  const [which, setWhich] = useState<Which>("today");
  const { site, state, widget } = live;
  const day = widget?.timeline.days[which === "today" ? 0 : 1];
  return (
    <main className="screen">
      <Header>
        <h1 className="title">Графік</h1>
      </Header>
      <Segmented
        label="День"
        value={which}
        onChange={setWhich}
        options={[
          ["today", "Сьогодні"],
          ["tomorrow", "Завтра"],
        ]}
      />
      {site && (
        <ConnectionNotice connection={live.connection} updatedAt={live.updatedAt} tz={site.tz} />
      )}
      {!site || !widget || !day ? (
        <div className="skeleton" style={{ flex: 1, minHeight: 400 }} />
      ) : (
        <DayView
          live={live}
          day={day}
          today={which === "today"}
          updatedOn={state?.schedule?.updatedOn ?? null}
        />
      )}
    </main>
  );
}

function DayView({
  live,
  day,
  today,
  updatedOn,
}: {
  live: Live;
  day: TimelineDay;
  today: boolean;
  updatedOn: string | null;
}) {
  const tz = live.site?.tz ?? "Europe/Kyiv";
  const now = live.now;
  const first = day.segments[0];
  const last = day.segments[day.segments.length - 1];
  const emergency = day.overlay === "emergency";
  const published = day.status === "ScheduleApplies" || day.status === "NoOutages";

  if (!first || !last || (!published && !emergency && day.status !== "EmergencyShutdowns")) {
    return <NoSchedule waiting={day.status === "WaitingForSchedule"} today={today} />;
  }

  const range = { start: first.start, end: last.end };
  const plannedOff = day.segments.filter((s) => s.kind === "off");
  const actual = today ? (live.widget?.timeline.actual ?? []) : [];
  const pieces = dayPieces(range, now, actual, plannedOff, emergency ? "last" : "plan");
  const marks: { at: number; text: string; now?: boolean }[] = today
    ? changes(pieces).map((at) => ({ at, text: hhmm(at, tz) }))
    : windowEdges(plannedOff, range).map((at) => ({ at, text: hhmm(at, tz) }));
  if (today && now >= range.start && now < range.end)
    marks.push({ at: now, text: `зараз ${hhmm(now, tz)}`, now: true });
  const updated = updatedOn ? hhmm(Date.parse(updatedOn), tz) : null;

  let status: React.ReactNode;
  if (emergency || day.status === "EmergencyShutdowns") {
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
        {today ? what : `${dayLabel(day.date)} · ${what.toLowerCase()}`}
        {updated && ` · оновлено о ${updated}`}
      </p>
    );
  }

  const expected = day.totals?.expected ?? null;
  const past = day.totals?.past ?? null;
  return (
    <>
      {status}
      <section className="card schedule-card" aria-label={`Графік: ${day.label}`}>
        <div
          className="bands"
          role="img"
          aria-label={describe(day, pieces, tz, today ? now : null)}
        >
          {[0, 1, 2, 3].map((q) => (
            <Band
              key={q}
              from={range.start + q * 6 * 3_600_000}
              to={q === 3 ? range.end : range.start + (q + 1) * 6 * 3_600_000}
              firstHour={q * 6}
              pieces={pieces}
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
                onKind={today ? "on" : "light-plan"}
                offKind={today ? "off" : "plan"}
              />
            </>
          ) : (
            <>
              {emergency && (
                <div className="card-head">
                  <LegendItem kind="last">Останній графік</LegendItem>
                </div>
              )}
              {past && <Split onMs={past.onMs} offMs={past.offMs} />}
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
  pieces,
  marks,
}: {
  from: number;
  to: number;
  firstHour: number;
  pieces: readonly Piece[];
  marks: readonly { at: number; text: string; now?: boolean }[];
}) {
  const own = clipPieces(pieces, from, to);
  const inside = marks.filter((m) => m.at >= from && m.at < to);
  const labels = spacedMarks(marks, from, to);
  return (
    <div className="band">
      <div className="band-marks" aria-hidden="true">
        {labels.map((m) => {
          const p = pct(m.at, from, to);
          const shift = p > 80 ? "translateX(-100%)" : p < 12 ? "none" : "translateX(-50%)";
          return (
            <span key={m.at} style={{ left: `${p}%`, transform: shift }}>
              {m.text}
            </span>
          );
        })}
      </div>
      <div className="band-track" aria-hidden="true">
        {own.map((piece) => (
          <span
            key={piece.start}
            className="piece"
            data-kind={piece.kind}
            style={{
              left: `${pct(piece.start, from, to)}%`,
              width: `${pct(piece.end, from, to) - pct(piece.start, from, to)}%`,
            }}
          />
        ))}
        {[1, 2, 3, 4, 5].map((h) => (
          <span key={h} className="hour-line" style={{ left: `${(h / 6) * 100}%` }} />
        ))}
        {inside.map((m) => (
          <span
            key={`l${m.at}`}
            className={m.now ? "now-line" : "change-line"}
            style={{ left: `${pct(m.at, from, to)}%` }}
          />
        ))}
      </div>
      <div className="band-hours" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6].map((h) => (
          <span key={h}>{String(firstHour + h).padStart(2, "0")}</span>
        ))}
      </div>
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
