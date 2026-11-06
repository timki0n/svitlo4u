import { useState } from "react";
import type { TimelineDay } from "./api.ts";
import { dayLabel, hhmm } from "./format.ts";
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
import { ConnectionNotice, Header, Icon, LegendItem, Segmented, Split } from "./ui.tsx";

type Which = "today" | "tomorrow";

const HOUR = 3_600_000;

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
  updatedOn,
  showDate = true,
}: {
  live: Live;
  day: TimelineDay;
  today: boolean;
  updatedOn: string | null;
  /** The status line of a day ahead names its date (the picture has it in its title instead). */
  showDate?: boolean;
}) {
  const tz = live.site?.tz ?? "Europe/Kyiv";
  const now = live.now;
  const first = day.segments[0];
  const last = day.segments[day.segments.length - 1];
  const emergency = day.overlay === "emergency";

  if (!first || !last || !drawable(day)) {
    return <NoSchedule waiting={day.status === "WaitingForSchedule"} today={today} />;
  }

  const range = { start: first.start, end: last.end };
  const plannedOff = day.segments.filter((s) => s.kind === "off");
  const actual = today ? (live.widget?.timeline.actual ?? []) : [];
  // The cells carry the plan for the whole day; a thin line above them, what really happened.
  const plan: Piece[] = plannedOff.map((s) => ({
    start: s.start,
    end: s.end,
    kind: emergency ? "last" : "plan",
  }));
  const fact = today ? dayPieces(range, now, actual, []) : [];
  // The row above the cells belongs to the fact only: times of real changes and «now».
  const marks: { at: number; text: string; now?: boolean }[] = changes(fact).map((at) => ({
    at,
    text: hhmm(at, tz),
  }));
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
        {today || !showDate ? what : `${dayLabel(day.date)} · ${what.toLowerCase()}`}
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
          aria-label={describe(day, [...fact, ...plan], tz, today ? now : null)}
        >
          {[0, 1, 2, 3].map((q) => (
            <Band
              key={q}
              from={range.start + q * 6 * 3_600_000}
              to={q === 3 ? range.end : range.start + (q + 1) * 6 * 3_600_000}
              firstHour={q * 6}
              plan={plan}
              fact={fact}
              now={today ? now : null}
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
              {emergency && (
                <div className="card-head">
                  <LegendItem kind="last">Останній графік</LegendItem>
                </div>
              )}
              {past && (
                <Split onMs={past.onMs} offMs={past.offMs} onKind="bar-on" offKind="bar-off" />
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
}: {
  from: number;
  to: number;
  firstHour: number;
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
      <div className="band-track" aria-hidden="true">
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
