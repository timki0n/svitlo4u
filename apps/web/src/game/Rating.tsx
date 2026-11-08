/**
 * The game's rating. «Гравці»: this outage, the week (from Monday) and all time, with avatars.
 * «Будівлі»: the facades of the outages, this one and the past, lit beyond a tenth.
 */
import { useEffect, useState } from "react";
import { GAME_WINDOWS } from "../../../../packages/domain/src/game.ts";
import { dayLabel, duration, hhmm, shortDate, zoned } from "../format.ts";
import { tgUserId } from "../telegram.ts";
import { Icon, Segmented } from "../ui.tsx";
import type {
  GameBuilding,
  GameBuildings,
  GamePeriod,
  GameRating,
  GameRatingRow,
  GameState,
  gameApi,
} from "./api.ts";

type PlayerView = GameState["players"][string];

export function playerName(p: PlayerView | undefined): string {
  return p?.name || (p?.username ? `@${p.username}` : "Сусід");
}

/** The game's points: a lightning bolt (screen readers hear «бали»). */
export function Bolt({ size = 14 }: { size?: number }) {
  return (
    <span className="g-bolt">
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill="var(--light)" />
      </svg>
      <span className="sr-only">бали</span>
    </span>
  );
}

const SHADES = ["#8fa3c8", "#d9b86a", "#c48f7a", "#8fb8a6", "#b49ac8", "#c8a27a"];

/** The Telegram photo the core saved, or the first letter on a calm colour. */
export function Avatar({
  id,
  player,
  size = 36,
}: {
  id: number;
  player: PlayerView | undefined;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (player?.avatar && !broken)
    return (
      <img
        className="g-avatar"
        src={player.avatar}
        alt=""
        style={style}
        onError={() => setBroken(true)}
      />
    );
  const letter = (player?.name || player?.username || "?").trim().charAt(0).toUpperCase();
  return (
    <span
      className="g-avatar"
      style={{ ...style, background: SHADES[Math.abs(id) % SHADES.length] }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

const PERIODS = [
  ["session", "Відключення"],
  ["week", "Тиждень"],
  ["all", "Весь час"],
] as const;

type View = "players" | "buildings";
const VIEWS = [
  ["players", "Гравці"],
  ["buildings", "Будівлі"],
] as const;

type Api = ReturnType<typeof gameApi>;

export function RatingScreen({ api, tz }: { api: Api; tz: string }) {
  const [view, setView] = useState<View>("players");
  return (
    <main className="screen">
      <header className="header">
        <a className="g-back" href="#/game">
          <Icon name="back" size={18} />
          Фасад
        </a>
        <span className="label">Рейтинг</span>
      </header>
      <Segmented label="Що показати" options={VIEWS} value={view} onChange={setView} />
      {view === "players" ? <Players api={api} tz={tz} /> : <Buildings api={api} tz={tz} />}
    </main>
  );
}

function Players({ api, tz }: { api: Api; tz: string }) {
  const [period, setPeriod] = useState<GamePeriod>("session");
  const [rating, setRating] = useState<GameRating | null>(null);
  const [failed, setFailed] = useState(false);
  const me = tgUserId();

  useEffect(() => {
    const ctrl = new AbortController();
    setRating(null);
    setFailed(false);
    api
      .rating(period, ctrl.signal)
      .then(setRating)
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed(true);
      });
    return () => ctrl.abort();
  }, [api, period]);

  const note =
    rating && period === "session" ? (
      rating.since ? (
        <>
          <Bolt size={12} /> за поточне відключення, з {hhmm(rating.since, tz)}. Нове відключення —
          новий фасад.
        </>
      ) : (
        "Ще не було жодного відключення."
      )
    ) : rating && period === "week" && rating.resetsAt ? (
      `Тиждень рахується з понеділка й почнеться заново ${shortDate(dateOf(rating.resetsAt, tz))} о 00:00.`
    ) : (
      <>
        Усі <Bolt size={12} /> від початку гри.
      </>
    );
  const meShown = rating?.rows.some((r) => r.id === me) ?? false;

  return (
    <>
      <Segmented label="Період рейтингу" options={PERIODS} value={period} onChange={setPeriod} />
      <section className="card" aria-live="polite">
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>
          {note}
        </p>
        {failed ? (
          <p className="g-warn">Немає зв'язку. Спробуй ще раз пізніше.</p>
        ) : !rating ? (
          <p className="muted">Завантаження…</p>
        ) : rating.rows.length === 0 ? (
          <p className="muted">Ще ніхто не засвітив жодного вікна.</p>
        ) : (
          <ol className="g-rating">
            {rating.rows.map((r) => (
              <Row key={r.id} row={r} me={r.id === me} />
            ))}
            {!meShown && rating.me && (
              <>
                <li className="g-gap" aria-hidden="true">
                  ⋯
                </li>
                <Row row={rating.me} me />
              </>
            )}
          </ol>
        )}
      </section>
    </>
  );
}

// ── the buildings ───────────────────────────────────────────────────────────────────────────

function Buildings({ api, tz }: { api: Api; tz: string }) {
  const [list, setList] = useState<GameBuildings | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .buildings(ctrl.signal)
      .then(setList)
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed(true);
      });
    return () => ctrl.abort();
  }, [api]);

  const min = Math.round((list?.minShare ?? 0.1) * 100);
  return (
    <section className="card" aria-live="polite">
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>
        Кожне відключення — новий будинок. Тут ті, що сусіди засвітили більше ніж на {min}%.
      </p>
      {failed ? (
        <p className="g-warn">Немає зв'язку. Спробуй ще раз пізніше.</p>
      ) : !list ? (
        <p className="muted">Завантаження…</p>
      ) : list.buildings.length === 0 ? (
        <p className="muted">Ще жоден будинок не засвітили більше ніж на {min}%.</p>
      ) : (
        <ol className="g-buildings">
          {list.buildings.map((b) => (
            <Building key={b.start} b={b} tz={tz} />
          ))}
        </ol>
      )}
    </section>
  );
}

/** «5 гравців», «2 гравці», «1 гравець». */
function playersWord(n: number): string {
  const t = n % 100;
  const u = n % 10;
  if (t >= 11 && t <= 14) return `${n} гравців`;
  return `${n} ${u === 1 ? "гравець" : u >= 2 && u <= 4 ? "гравці" : "гравців"}`;
}

/** A whole percent, never «0%» for a lit facade nor «100%» for one with a dark window. */
function wholePercent(windows: number): string {
  const p = (windows / GAME_WINDOWS) * 100;
  if (windows > 0 && p < 1) return "1%";
  if (windows < GAME_WINDOWS && p > 99) return "99%";
  return `${Math.round(p)}%`;
}

function Building({ b, tz }: { b: GameBuilding; tz: string }) {
  const when = b.end ? `${hhmm(b.start, tz)}–${hhmm(b.end, tz)}` : `з ${hhmm(b.start, tz)}`;
  const tag = b.current ? "зараз" : b.end ? duration(b.end - b.start) : null;
  return (
    <li className="g-building" data-current={b.current || undefined}>
      <div className="g-building-head">
        <span>
          <b>{dayLabel(zoned(b.start, tz).date)}</b> · {when}
        </span>
        {tag && (
          <span className="g-tag" data-on={b.current || undefined}>
            {tag}
          </span>
        )}
      </div>
      <div
        className="g-meter"
        role="img"
        aria-label={`Засвічено ${b.windows} вікон з ${GAME_WINDOWS}`}
      >
        <div style={{ width: `${Math.min(100, b.share * 100)}%` }} />
      </div>
      <div className="g-building-stats">
        <span>
          <b>{wholePercent(b.windows)}</b> · {b.windows} з {GAME_WINDOWS} вікон
        </span>
        <span>
          {playersWord(b.players)} · {b.points}
          <Bolt size={12} />
        </span>
      </div>
      {b.top.length > 0 && (
        <ol className="g-podium" aria-label="Хто засвітив найбільше вікон першим">
          {b.top.map((t, i) => (
            <li key={t.id}>
              <span className="g-podium-face">
                <Avatar id={t.id} player={t} size={i === 0 ? 40 : 34} />
                <span className="g-podium-rank" aria-hidden="true">
                  {i + 1}
                </span>
              </span>
              <span className="g-podium-name">{playerName(t)}</span>
              <span className="g-podium-share">
                {((t.firsts / GAME_WINDOWS) * 100).toLocaleString("uk-UA", {
                  maximumFractionDigits: 1,
                })}
                %
              </span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function Row({ row, me }: { row: GameRatingRow; me: boolean }) {
  return (
    <li className="g-rank" data-me={me || undefined}>
      <span className="g-place">{row.rank}</span>
      <Avatar id={row.id} player={row} />
      <span className="g-who">
        <span>{playerName(row)}</span>
        {row.username && <span className="g-muted">@{row.username}</span>}
      </span>
      <span className="g-score">
        <b>
          {row.points}
          <Bolt />
        </b>
        <span className="g-muted">{row.windows} вік.</span>
      </span>
    </li>
  );
}

function dateOf(t: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(t);
}
