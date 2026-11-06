import { Building } from "./Building.tsx";
import { duration, hhmm } from "./format.ts";
import type { Live } from "./live.ts";
import type { BuildingMode } from "./scene3d.ts";
import { dayPieces, pct } from "./timeline.ts";
import { ConnectionNotice, Header, Icon, LegendItem, Split } from "./ui.tsx";

/** A reading older than this is not shown (the plug sends one every ~30 s while there is power). */
const VOLTAGE_FRESH_MS = 5 * 60_000;

export function NowScreen({ live }: { live: Live }) {
  const { site, state, widget, now } = live;
  if (!site || !state || !widget) return <NowSkeleton name={site?.name} />;
  const tz = site.tz;
  const today = widget.timeline.days[0];
  const emergency =
    today?.overlay === "emergency" || today?.status === "EmergencyShutdowns" || false;
  const voltage =
    state.power === "on" && state.voltage?.at && now - state.voltage.at < VOLTAGE_FRESH_MS
      ? state.voltage
      : null;
  const low = voltage?.level === "low";
  const mode: BuildingMode = state.power === "on" ? (low ? "low" : "on") : "off";
  const lamp = state.power === "on" ? (low ? "low" : "on") : state.power;
  const updatedOn = state.schedule?.updatedOn ? Date.parse(state.schedule.updatedOn) : null;

  return (
    <main className="screen">
      <Header>
        <span className="label">{site.name}</span>
      </Header>
      <ConnectionNotice connection={live.connection} updatedAt={live.updatedAt} tz={tz} />
      <Building mode={mode} />
      <section className="state" aria-live="polite">
        <div className="lamp" data-power={lamp} aria-hidden="true" />
        <h1>{widget.title}</h1>
        <p>
          {state.since !== null && state.power !== "unknown"
            ? `уже ${duration(now - state.since)} · з ${hhmm(state.since, tz)}`
            : "датчик ще не відповів"}
        </p>
      </section>

      {emergency && (
        <p className="banner">
          <Icon name="warn" color="var(--warn)" />
          Діють екстрені відключення. Графік не діє.
        </p>
      )}

      {state.next ? (
        <p className="next">
          {state.next.label}
          <span className="glow">через {duration(Math.max(0, state.next.at - now))}</span>
        </p>
      ) : (
        state.power === "off" && (
          <p className="muted" style={{ fontSize: 14, lineHeight: 1.45 }}>
            Коли повернуть світло — невідомо. Щойно воно з'явиться, стан тут оновиться сам.
          </p>
        )
      )}

      {(voltage || updatedOn) && (
        <div className="row">
          {voltage && (
            <span className="chip" data-level={voltage.level}>
              <Icon name={voltage.level === "normal" ? "plug" : "warn"} size={16} />
              {Math.round(voltage.value)} В{voltage.level === "low" && " · низька"}
              {voltage.level === "high" && " · висока"}
            </span>
          )}
          {updatedOn !== null && (
            <span className="muted" style={{ fontSize: 13 }}>
              Графік оновлено о {hhmm(updatedOn, tz)}
            </span>
          )}
        </div>
      )}

      {today && <DayCard live={live} />}
    </main>
  );
}

function DayCard({ live }: { live: Live }) {
  const { widget, now } = live;
  const today = widget?.timeline.days[0];
  if (!widget || !today) return null;
  const first = today.segments[0];
  const last = today.segments[today.segments.length - 1];
  if (!first || !last) return null;
  const day = { start: first.start, end: last.end };
  const planned = today.segments.filter((s) => s.kind === "off");
  const fact = dayPieces(day, now, widget.timeline.actual, []);
  const nowPct = pct(Math.min(Math.max(now, day.start), day.end), day.start, day.end);
  const planKind = today.overlay === "emergency" ? "last" : "plan";

  return (
    <section className="card" aria-labelledby="today-h">
      <div className="card-head">
        <h2 id="today-h" className="label">
          {today.label}
        </h2>
        {planned.length > 0 && (
          <LegendItem kind="strip-plan">
            {planKind === "last" ? "Останній графік" : "План"}
          </LegendItem>
        )}
      </div>
      <div className="strip" role="img" aria-label={stripLabel(live)}>
        <div className="strip-lanes">
          {planned.map((s) => (
            <span
              key={s.start}
              className="strip-plan"
              data-kind={planKind}
              style={{
                left: `${pct(s.start, day.start, day.end)}%`,
                width: `${pct(s.end, day.start, day.end) - pct(s.start, day.start, day.end)}%`,
              }}
            />
          ))}
          {fact.map((p) => (
            <span
              key={p.start}
              className="strip-fact"
              data-kind={p.kind}
              style={{
                left: `${pct(p.start, day.start, day.end) + 0.3}%`,
                width: `${Math.max(0.4, pct(p.end, day.start, day.end) - pct(p.start, day.start, day.end) - 0.6)}%`,
              }}
            />
          ))}
          <span className="strip-future" style={{ left: `${nowPct + 1}%` }} />
          <span className="now-line" style={{ left: `${nowPct}%` }} />
        </div>
      </div>
      <div className="hours" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      {/* totals arrived in API 1.4; an older core simply has no summary yet */}
      {today.totals && (
        <Split
          onMs={today.totals.past.onMs}
          offMs={today.totals.past.offMs}
          onKind="bar-on"
          offKind="bar-off"
          onLabel="Світло було"
          offLabel="Світла не було"
        />
      )}
    </section>
  );
}

function stripLabel({ widget, site, now }: Live): string {
  const today = widget?.timeline.days[0];
  if (!widget || !today || !site) return "";
  const tz = site.tz;
  const outages = widget.timeline.actual.map(
    (o) => `${hhmm(o.start, tz)}–${o.end === null ? "досі" : hhmm(o.end, tz)}`,
  );
  const planned = today.segments.filter((s) => s.kind === "off").map((s) => s.label);
  return [
    `${today.label}, зараз ${hhmm(now, tz)}.`,
    outages.length ? `Без світла: ${outages.join(", ")}.` : "Відключень сьогодні не було.",
    planned.length ? `За графіком: ${planned.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function NowSkeleton({ name }: { name?: string | undefined }) {
  return (
    <main className="screen" aria-busy="true">
      <Header>
        <span className="label">{name ?? "Світло"}</span>
      </Header>
      <div className="figure" />
      <div className="skeleton" style={{ height: 30, width: "60%" }} />
      <div className="skeleton" style={{ height: 16, width: "40%" }} />
      <div className="skeleton" style={{ height: 52 }} />
      <div className="skeleton" style={{ height: 150 }} />
    </main>
  );
}
