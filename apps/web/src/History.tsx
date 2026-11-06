import { useEffect, useState } from "react";
import {
  api,
  type Daily,
  type Heatmap,
  type PlanVsFact,
  type ScheduleChanges,
  type Site,
  type Summary,
  type VoltageStats,
} from "./api.ts";
import { addDays, duration, shortDate, zoned } from "./format.ts";
import { Guard } from "./Guard.tsx";
import { Header, Icon, Segmented } from "./ui.tsx";

const PERIODS = [
  ["7", "7 днів"],
  ["30", "30 днів"],
  ["90", "90 днів"],
] as const;
type Period = (typeof PERIODS)[number][0];

type Data = {
  summary: Summary;
  daily: Daily;
  pvf: PlanVsFact;
  heatmap: Heatmap;
  voltage: VoltageStats;
  changes: ScheduleChanges;
};

export function HistoryScreen({ site, now }: { site: Site | null; now: number }) {
  const [period, setPeriod] = useState<Period>("30");
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const today = site ? zoned(now, site.tz).date : null;
  const from = today ? addDays(today, -(Number(period) - 1)) : null;

  useEffect(() => {
    if (!site || !today || !from) return;
    const ctrl = new AbortController();
    const s = ctrl.signal;
    setFailed(false);
    Promise.all([
      api.summary(site.id, from, today, s),
      api.daily(site.id, from, today, s),
      api.planVsFact(site.id, from, today, s),
      api.heatmap(site.id, from, today, s),
      api.voltage(site.id, from, today, s),
      api.scheduleChanges(site.id, from, today, s),
    ])
      .then(([summary, daily, pvf, heatmap, voltage, changes]) =>
        setData({ summary, daily, pvf, heatmap, voltage, changes }),
      )
      .catch((e: unknown) => {
        if (!s.aborted) {
          console.error(e);
          setFailed(true);
        }
      });
    return () => ctrl.abort();
  }, [site, today, from]);

  return (
    <main className="screen">
      <Header>
        <h1 className="title">Історія</h1>
      </Header>
      <Segmented label="Період" value={period} onChange={setPeriod} options={PERIODS} />
      {from && today && (
        <p className="muted" style={{ marginTop: -4, fontSize: 13 }}>
          {shortDate(from)} — {shortDate(today)}
        </p>
      )}
      {failed && (
        <p className="notice" role="status">
          <Icon name="offline" size={16} />
          Не вдалося завантажити історію
        </p>
      )}
      {!data ? (
        <div className="skeleton" style={{ minHeight: 600 }} aria-busy="true" />
      ) : (
        <>
          <Guard>
            <Tiles summary={data.summary} />
          </Guard>
          <Guard>
            <DailyChart daily={data.daily} changes={data.changes} />
          </Guard>
          <Guard>
            <PlanCard pvf={data.pvf} />
          </Guard>
          <Guard>
            <HeatmapCard heatmap={data.heatmap} />
          </Guard>
          <Guard>
            <VoltageCard voltage={data.voltage} />
          </Guard>
        </>
      )}
    </main>
  );
}

function Tiles({ summary }: { summary: Summary }) {
  const light = Math.round((1 - summary.offShare) * 100);
  return (
    <div className="tiles">
      <div className="tile">
        <span className="tile-value glow">{light}%</span>
        <span className="tile-label">часу зі світлом</span>
      </div>
      <div className="tile">
        <span className="tile-value">{summary.outages}</span>
        <span className="tile-label">відключень</span>
      </div>
      <div className="tile">
        <span className="tile-value">{duration(summary.longestOutageMs)}</span>
        <span className="tile-label">найдовше без світла</span>
      </div>
      <div className="tile">
        <span className="tile-value">{duration(summary.averageOutageMs)}</span>
        <span className="tile-label">триває в середньому</span>
      </div>
    </div>
  );
}

function TableToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="table-toggle" aria-pressed={on} onClick={onToggle}>
      <Icon name="rows" size={14} />
      Таблицею
    </button>
  );
}

const W = 318;
const AXIS = 24;
const TOP = 14;
const PLOT = 120;
const HOUR = 3_600_000;

function DailyChart({ daily, changes }: { daily: Daily; changes: ScheduleChanges }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const buckets = daily.buckets;
  const emergency = new Set(changes.days.filter((d) => d.hadEmergency).map((d) => d.date));
  const maxH = Math.max(16, ...buckets.map((b) => Math.ceil(b.offMs / HOUR / 4) * 4));
  const slot = (W - AXIS) / Math.max(1, buckets.length);
  const bw = Math.min(24, Math.max(2, slot * 0.72));
  const y = (h: number) => TOP + PLOT - (h / maxH) * PLOT;
  const total = buckets.reduce((s, b) => s + b.offMs, 0);
  const average = buckets.length ? total / buckets.length : 0;
  const labelAt = new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (buckets.length - 1))));
  const tip = hover !== null ? buckets[hover] : undefined;

  return (
    <section className="card" aria-labelledby="daily-h">
      <div className="card-head">
        <h2 id="daily-h" className="card-title">
          Години без світла по днях
        </h2>
        <TableToggle on={table} onToggle={() => setTable(!table)} />
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        У середньому {duration(average)} на день
        {emergency.size > 0 && (
          <>
            {" · "}
            <span className="legend-item">
              <span className="dot" aria-hidden="true" />
              екстрені
            </span>
          </>
        )}
      </p>
      {table ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>День</th>
              <th>Без світла</th>
              <th>Відключень</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.key}>
                <td>
                  {shortDate(b.key)}
                  {emergency.has(b.key) ? " · екстрені" : ""}
                </td>
                <td>{duration(b.offMs)}</td>
                <td>{b.outages}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="chart">
          <svg
            viewBox={`0 0 ${W} ${TOP + PLOT + 22}`}
            role="img"
            aria-label={`Години без світла по днях, у середньому ${duration(average)} на день.`}
            onPointerMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const x = ((e.clientX - box.left) / box.width) * W;
              const i = Math.floor((x - AXIS) / slot);
              setHover(i >= 0 && i < buckets.length ? i : null);
            }}
            onPointerLeave={() => setHover(null)}
          >
            {[0, 6, 12, ...(maxH > 18 ? [18] : [])].map((h) => (
              <g key={h}>
                <line x1={AXIS} x2={W} y1={y(h)} y2={y(h)} stroke="#3a3c42" strokeWidth={1} />
                <text x={0} y={y(h) + 4} fill="#a3a5ad" fontSize={11}>
                  {h}
                </text>
              </g>
            ))}
            {buckets.map((b, i) => {
              const hours = b.offMs / HOUR;
              if (hours <= 0) return null;
              const x = AXIS + i * slot + (slot - bw) / 2;
              const top = y(hours);
              const height = TOP + PLOT - top;
              const r = Math.min(3, bw / 2, height);
              const fill = hover === i ? "#8fa3c8" : "#6c7fa6";
              return (
                <g key={b.key}>
                  <path
                    d={`M${x},${TOP + PLOT}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${TOP + PLOT}Z`}
                    fill={fill}
                  />
                  {emergency.has(b.key) && (
                    <circle
                      cx={x + bw / 2}
                      cy={top - 7}
                      r={Math.min(4, Math.max(2.5, bw / 2))}
                      fill="#ff6b57"
                      stroke="#2a2c31"
                      strokeWidth={2}
                    />
                  )}
                </g>
              );
            })}
            {buckets.map((b, i) =>
              labelAt.has(i) ? (
                <text
                  key={`t${b.key}`}
                  x={i === 0 ? AXIS : i === buckets.length - 1 ? W : AXIS + i * slot + slot / 2}
                  y={TOP + PLOT + 17}
                  textAnchor={i === 0 ? "start" : i === buckets.length - 1 ? "end" : "middle"}
                  fill="#a3a5ad"
                  fontSize={11}
                >
                  {shortDate(b.key)}
                </text>
              ) : null,
            )}
          </svg>
          {tip && hover !== null && (
            <div
              className="chart-tip"
              role="tooltip"
              style={{
                left: `${Math.min(80, Math.max(20, ((AXIS + hover * slot + slot / 2) / W) * 100))}%`,
                top: 0,
              }}
            >
              <strong style={{ display: "block" }}>{shortDate(tip.key)}</strong>
              {duration(tip.offMs)} без світла
              {emergency.has(tip.key) && (
                <span className="legend-item" style={{ display: "flex" }}>
                  <span className="dot" aria-hidden="true" />
                  екстрені
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Colours checked for colour-blind separation on the dark surface (dataviz validator). */
const OUTCOME_COLORS = {
  asPlanned: "#5b7fd1",
  early: "#d97316",
  late: "#9a6be0",
  none: "#7a7e8a",
  cancelled: "#e04f3c",
};

function PlanCard({ pvf }: { pvf: PlanVsFact }) {
  const o = pvf.totals.outcomes;
  const parts = [
    ["Як за планом", o.asPlanned, OUTCOME_COLORS.asPlanned],
    ["Повернули раніше", o.returnedEarly, OUTCOME_COLORS.early],
    ["Повернули пізніше", o.returnedLate, OUTCOME_COLORS.late],
    ["Не вимикали", o.noOutage, OUTCOME_COLORS.none],
    ["Скасовано екстреними", pvf.cancelledByEmergency.length, OUTCOME_COLORS.cancelled],
  ] as const;
  const total = parts.reduce((s, p) => s + p[1], 0);
  return (
    <section className="card" aria-labelledby="pvf-h">
      <h2 id="pvf-h" className="card-title">
        Як справджувався графік
      </h2>
      {total === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          За цей період планових відключень не було.
        </p>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            {total} планових вікон
          </p>
          <div
            className="parts"
            role="img"
            aria-label={parts
              .filter((p) => p[1] > 0)
              .map((p) => `${p[0]}: ${p[1]}`)
              .join("; ")}
          >
            {parts
              .filter((p) => p[1] > 0)
              .map(([name, count, color]) => {
                const share = Math.round((count / total) * 100);
                return (
                  <div
                    key={name}
                    title={`${name}: ${count}`}
                    style={{ flex: `${count} 1 0`, background: color }}
                  >
                    {share >= 18 && <span>{share}%</span>}
                  </div>
                );
              })}
          </div>
          <div className="row" style={{ gap: "6px 14px" }}>
            {parts
              .filter((p) => p[1] > 0)
              .map(([name, , color]) => (
                <span key={name} className="legend-item">
                  <span
                    className="swatch"
                    style={{ width: 10, height: 10, borderRadius: 3, background: color }}
                  />
                  {name}
                </span>
              ))}
          </div>
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              fontSize: 13,
              display: "grid",
              gap: 4,
            }}
          >
            {o.averageEarlyMs !== null && (
              <li>Раніше — у середньому на {duration(o.averageEarlyMs)}</li>
            )}
            {o.averageLateMs !== null && (
              <li>Пізніше — у середньому на {duration(o.averageLateMs)}</li>
            )}
            <li className="muted">
              «Як за планом» — світло повернули в межах 15 хв від кінця вікна
            </li>
          </ul>
        </>
      )}
    </section>
  );
}

const RAMP = ["#4a5b80", "#5c719e", "#7189bb", "#8ba3d6", "#b0c4ef"];
const EMPTY_CELL = "#303237";
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

function heatColor(share: number | null): string {
  if (share === null || share < 0.05) return EMPTY_CELL;
  const limits = [0.2, 0.35, 0.5, 0.65];
  const i = limits.findIndex((l) => share <= l);
  return RAMP[i === -1 ? 4 : i] as string;
}

function HeatmapCard({ heatmap }: { heatmap: Heatmap }) {
  return (
    <section className="card" aria-labelledby="heat-h">
      <h2 id="heat-h" className="card-title">
        Коли найчастіше без світла
      </h2>
      <p className="muted" style={{ fontSize: 13 }}>
        Частка часу без світла: година × день тижня
      </p>
      <div
        className="heatmap"
        role="img"
        aria-label="Теплова карта відключень за днями тижня й годинами"
      >
        {heatmap.share.map((row, d) => (
          <Row key={WEEKDAYS[d]} day={WEEKDAYS[d] ?? ""} row={row} />
        ))}
      </div>
      <div className="band-hours" style={{ paddingLeft: 24 }} aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      <div
        className="row"
        style={{ gap: 6, fontSize: 12, color: "var(--muted)" }}
        aria-hidden="true"
      >
        рідко
        {[EMPTY_CELL, ...RAMP].map((c) => (
          <span key={c} style={{ width: 16, height: 10, borderRadius: 2, background: c }} />
        ))}
        часто
      </div>
    </section>
  );
}

function Row({ day, row }: { day: string; row: (number | null)[] }) {
  return (
    <>
      <span className="heat-day">{day}</span>
      {row.map((share, h) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: hours are positional
          key={h}
          title={`${day}, ${String(h).padStart(2, "0")}:00 — ${share === null ? "немає даних" : `${Math.round(share * 100)}% часу без світла`}`}
          style={{ background: heatColor(share) }}
        />
      ))}
    </>
  );
}

const V_MIN = 170;
const V_MAX = 260;
const NORM = [190, 245] as const;
const vx = (v: number) => ((Math.min(V_MAX, Math.max(V_MIN, v)) - V_MIN) / (V_MAX - V_MIN)) * 100;

function VoltageCard({ voltage }: { voltage: VoltageStats }) {
  const { min, max, avg } = voltage.summary;
  return (
    <section className="card" aria-labelledby="volt-h">
      <h2 id="volt-h" className="card-title">
        Напруга
      </h2>
      {min === null || max === null || avg === null ? (
        <p className="muted" style={{ fontSize: 13 }}>
          За цей період даних про напругу немає.
        </p>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            Мін {Math.round(min)} В · середня {Math.round(avg)} В · макс {Math.round(max)} В
          </p>
          <div
            className="vrange"
            role="img"
            aria-label={`Напруга: мінімум ${Math.round(min)} В, середня ${Math.round(avg)} В, максимум ${Math.round(max)} В. Норма ${NORM[0]}–${NORM[1]} В.`}
          >
            <div className="vrange-track" />
            <div
              className="vrange-norm"
              style={{ left: `${vx(NORM[0])}%`, width: `${vx(NORM[1]) - vx(NORM[0])}%` }}
            />
            <div
              className="vrange-span"
              style={{ left: `${vx(min)}%`, width: `${vx(max) - vx(min)}%` }}
            />
            {[min, avg, max].map((v, i) => {
              const out = v < NORM[0] || v >= NORM[1];
              return (
                <span key={["min", "avg", "max"][i]}>
                  <span
                    className="vrange-dot"
                    style={{ left: `${vx(v)}%`, background: out ? "var(--warn)" : "var(--text)" }}
                  />
                  <span className="vrange-value" style={{ left: `${vx(v)}%` }}>
                    {Math.round(v)}
                  </span>
                </span>
              );
            })}
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Сіра смуга — норма {NORM[0]}–{NORM[1]} В
          </p>
        </>
      )}
    </section>
  );
}
