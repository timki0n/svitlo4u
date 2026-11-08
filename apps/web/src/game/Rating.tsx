/** The game's rating: this outage, the week (from Monday) and all time, with avatars. */
import { useEffect, useState } from "react";
import { hhmm, shortDate } from "../format.ts";
import { tgUserId } from "../telegram.ts";
import { Icon, Segmented } from "../ui.tsx";
import type { GamePeriod, GameRating, GameRatingRow, GameState, gameApi } from "./api.ts";

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

export function RatingScreen({ api, tz }: { api: ReturnType<typeof gameApi>; tz: string }) {
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
    <main className="screen">
      <header className="header">
        <a className="g-back" href="#/game">
          <Icon name="back" size={18} />
          Фасад
        </a>
        <span className="label">Рейтинг</span>
      </header>
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
    </main>
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
