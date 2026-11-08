/**
 * «Гра» (only in the Telegram Mini App): the back facade of the building; every window holds a
 * small puzzle generated for the session — the latest outage. Solving it scores points and lights
 * the window for everybody; the facade starts dark at every new outage. Windows someone is playing
 * blink. #/game is the facade, #/game/<floor>-<col> a window's puzzle, #/game/rating the rating.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GAME_FLOORS,
  GAME_WINDOWS,
  gamePoints,
  gameSessionKey,
} from "../../../../packages/domain/src/game.ts";
import { hhmm } from "../format.ts";
import type { Live } from "../live.ts";
import type { FacadeScene, FacadeWindow } from "../scene3d.ts";
import { inMiniApp } from "../telegram.ts";
import { Icon } from "../ui.tsx";
import { GameApiError, type GameState, gameApi, type SolveResult } from "./api.ts";
import { TIER_LABEL, type WindowGame, windowGame } from "./games.ts";
import { Avatar, Bolt, playerName, RatingScreen } from "./Rating.tsx";
import "./game.css";

/** The facade is re-read this often while it is on screen. */
const POLL_MS = 3000;
/** While a puzzle is open, the phone tells the core every so often (others see it blink). */
const HEARTBEAT_MS = 10_000;

type Route = { kind: "facade" } | { kind: "rating" } | { kind: "play"; win: FacadeWindow };

function route(): Route {
  const hash = location.hash;
  if (hash === "#/game/rating") return { kind: "rating" };
  const m = /^#\/game\/(\d+)-(\d+)$/.exec(hash);
  const floor = Number(m?.[1]);
  const col = Number(m?.[2]);
  return m && floor >= GAME_FLOORS.first && floor <= GAME_FLOORS.last && col >= 1 && col <= 8
    ? { kind: "play", win: { floor, col } }
    : { kind: "facade" };
}

const keyOf = (w: { floor: number; col: number }) => `${w.floor}-${w.col}`;

/** The facade state from the core, re-read while `active` and the page is visible. */
function useGame(siteId: string, active: boolean) {
  const api = useMemo(() => gameApi(siteId), [siteId]);
  const [state, setState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setError(null);
    } catch (e) {
      setError(e instanceof GameApiError && e.status === 401 ? "auth" : "network");
    }
  }, [api]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (document.visibilityState === "visible") await refresh();
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [active, refresh]);
  return { api, state, error, refresh };
}

export default function GameScreen({ live }: { live: Live }) {
  const [where, setWhere] = useState(route);
  useEffect(() => {
    const onHash = () => setWhere(route());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (!inMiniApp()) {
    return (
      <main className="screen">
        <header className="header">
          <span className="label">Гра</span>
        </header>
        <p className="card muted">Гра доступна лише в міні-застосунку.</p>
      </main>
    );
  }
  if (!live.site) return <Loading />;
  return <Game siteId={live.site.id} tz={live.site.tz} where={where} />;
}

function Loading() {
  return (
    <main className="screen">
      <header className="header">
        <span className="label">Гра</span>
      </header>
      <p className="muted">Завантаження…</p>
    </main>
  );
}

function Game({ siteId, tz, where }: { siteId: string; tz: string; where: Route }) {
  const { api, state, error, refresh } = useGame(siteId, where.kind === "facade");
  const [selected, setSelected] = useState<FacadeWindow | null>(
    where.kind === "play" ? where.win : null,
  );
  useEffect(() => {
    if (where.kind === "play") setSelected(where.win);
  }, [where]);

  if (where.kind === "rating") return <RatingScreen api={api} tz={tz} />;
  if (!state) {
    return error === "auth" ? (
      <Notice text="Не вдалося увійти. Закрий гру й відкрий її знову з кнопки бота." />
    ) : error ? (
      <Notice text="Немає зв'язку. Гра спробує ще раз сама." />
    ) : (
      <Loading />
    );
  }
  if (!state.session) return <Notice text="Гра почнеться з першим відключенням світла." />;
  const session = gameSessionKey(state.session.start);
  if (where.kind === "play")
    return <Play api={api} session={session} win={where.win} onScored={refresh} />;
  return (
    <Facade
      state={state}
      tz={tz}
      session={session}
      selected={selected}
      onSelect={setSelected}
      offline={error === "network"}
    />
  );
}

function Notice({ text }: { text: string }) {
  return (
    <main className="screen">
      <GameHeader title="Гра" />
      <p className="card muted">{text}</p>
    </main>
  );
}

function GameHeader({ title, back }: { title: string; back?: boolean }) {
  return (
    <header className="header">
      {back ? (
        <a className="g-back" href="#/game">
          <Icon name="back" size={18} />
          Фасад
        </a>
      ) : (
        <span className="label">{title}</span>
      )}
      {back ? (
        <span className="label">{title}</span>
      ) : (
        <a className="g-back" href="#/game/rating">
          <Icon name="trophy" size={18} color="var(--light)" />
          Рейтинг
        </a>
      )}
    </header>
  );
}

// ── the facade ────────────────────────────────────────────────────────────────────────────────

function Facade({
  state,
  tz,
  session,
  selected,
  onSelect,
  offline,
}: {
  state: GameState;
  tz: string;
  session: string;
  selected: FacadeWindow | null;
  onSelect: (w: FacadeWindow | null) => void;
  offline: boolean;
}) {
  const lit = useMemo(() => new Set(state.windows.map(keyOf)), [state.windows]);
  const playing = useMemo(() => new Set(state.playing.map(keyOf)), [state.playing]);
  const s = state.session;
  const label = s
    ? s.end === null
      ? `Відключення з ${hhmm(s.start, tz)}`
      : `Відключення ${hhmm(s.start, tz)}–${hhmm(s.end, tz)}`
    : "";
  return (
    <main className="screen">
      <GameHeader title="Гра" />
      <p className="g-meta">
        <span>{offline ? "Немає зв'язку" : label}</span>
        <span>
          мої <b>{state.me.points.session}</b>
          <Bolt size={13} />
        </span>
      </p>
      {/* the whole facade moves left for the progress; close to a window it takes all the room */}
      <div className="g-stage">
        <FacadeFigure
          lit={lit}
          playing={playing}
          selected={selected}
          onSelect={onSelect}
          inset={selected ? 0 : SIDE_WIDTH}
        />
        {!selected && <SidePanel state={state} lit={lit.size} />}
      </div>
      <WindowCard
        state={state}
        tz={tz}
        session={session}
        selected={selected}
        onClose={() => onSelect(null)}
      />
    </main>
  );
}

/** Room on the right of the whole facade for the progress. */
const SIDE_WIDTH = 116;

const percent = (part: number) =>
  `${((part / GAME_WINDOWS) * 100).toLocaleString("uk-UA", { maximumFractionDigits: 1 })}%`;

/**
 * Beside the whole facade: the share lit as a ring, and the neighbours with the share each of them
 * lit (windows they were first to light); whoever is playing right now has a blinking dot.
 */
function SidePanel({ state, lit }: { state: GameState; lit: number }) {
  const firsts = new Map<number, number>();
  for (const w of state.windows) {
    const first = w.solvers[0];
    if (first) firsts.set(first.id, (firsts.get(first.id) ?? 0) + 1);
  }
  const online = new Set(state.playing.flatMap((p) => p.ids));
  const ids = [...firsts.keys()]
    .sort((a, b) => (firsts.get(b) ?? 0) - (firsts.get(a) ?? 0))
    .slice(0, 6);
  for (const id of online) if (!ids.includes(id)) ids.push(id);
  return (
    <aside className="g-side" style={{ width: SIDE_WIDTH }} aria-label="Прогрес фасаду">
      <Ring part={lit} />
      {ids.length > 0 && (
        <ul className="g-people">
          {ids.map((id) => (
            <li key={id} data-me={id === state.me.id || undefined}>
              <span className="g-face">
                <Avatar id={id} player={state.players[id]} size={22} />
                {online.has(id) && (
                  <span className="g-dot g-face-dot">
                    <span className="sr-only">грає зараз</span>
                  </span>
                )}
              </span>
              <span className="g-people-name">{playerName(state.players[id])}</span>
              <span className="g-people-share">{percent(firsts.get(id) ?? 0)}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/** How much of the facade is lit: a ring filling round, the percentage inside. */
function Ring({ part }: { part: number }) {
  const r = 31;
  const length = 2 * Math.PI * r;
  const share = part / GAME_WINDOWS;
  return (
    <div className="g-ring" role="img" aria-label={`Засвічено ${part} вікон з ${GAME_WINDOWS}`}>
      <svg viewBox="0 0 76 76" width="76" height="76" aria-hidden="true">
        <circle className="g-ring-track" cx="38" cy="38" r={r} />
        {part > 0 && (
          <circle
            className="g-ring-fill"
            cx="38"
            cy="38"
            r={r}
            strokeDasharray={`${Math.max(share * length, 2)} ${length}`}
            transform="rotate(-90 38 38)"
          />
        )}
      </svg>
      <span className="g-ring-pct">{Math.round(share * 100)}%</span>
    </div>
  );
}

function FacadeFigure({
  lit,
  playing,
  selected,
  onSelect,
  inset,
}: {
  lit: ReadonlySet<string>;
  playing: ReadonlySet<string>;
  selected: FacadeWindow | null;
  onSelect: (w: FacadeWindow) => void;
  /** Room kept free on the right (px). */
  inset: number;
}) {
  const host = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<FacadeScene | null>(null);
  const latest = useRef({ lit, playing, selected, onSelect, inset });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    latest.current = { lit, playing, selected, onSelect, inset };
  });

  useEffect(() => {
    let cancelled = false;
    import("../scene3d.ts")
      .then(({ createFacade }) => {
        if (cancelled || !host.current || !canvas.current) return;
        const s = createFacade(host.current, canvas.current, (w) => latest.current.onSelect(w));
        s.setLit(latest.current.lit);
        s.setPlaying(latest.current.playing);
        s.setInset(latest.current.inset);
        s.select(latest.current.selected);
        scene.current = s;
      })
      .catch((e: unknown) => {
        console.error(e);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.setLit(lit);
  }, [lit]);
  useEffect(() => {
    scene.current?.setPlaying(playing);
  }, [playing]);
  useEffect(() => {
    scene.current?.setInset(inset);
    scene.current?.select(selected);
  }, [selected, inset]);

  return (
    <figure className="g-facade" ref={host}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Фасад будинку: засвічено ${lit.size} вікон з ${GAME_WINDOWS}. Торкніться вікна, щоб обрати його`}
      />
      {failed && <p className="figure-fallback">3D-модель недоступна на цьому пристрої.</p>}
    </figure>
  );
}

function WindowCard({
  state,
  tz,
  session,
  selected,
  onClose,
}: {
  state: GameState;
  tz: string;
  session: string;
  selected: FacadeWindow | null;
  onClose: () => void;
}) {
  if (!selected) {
    return (
      <section className="card g-sheet">
        <p className="muted">
          Торкнися вікна на фасаді й пройди міні-гру: вікно засвітиться для всіх, а ти отримаєш{" "}
          <Bolt size={13} />. Хто засвітить першим — отримає в півтора раза більше.
        </p>
      </section>
    );
  }
  const info = windowGame(session, selected.floor, selected.col);
  const key = keyOf(selected);
  const solvers = state.windows.find((w) => keyOf(w) === key)?.solvers ?? [];
  const now = state.playing.find((p) => keyOf(p) === key)?.ids ?? [];
  const mine = solvers.some((x) => x.id === state.me.id);
  const points = gamePoints(selected.floor, solvers.length === 0);
  return (
    <section className="card g-sheet" aria-live="polite">
      <div className="card-head">
        <span className="card-title">
          Поверх {selected.floor} · вікно {selected.col}
        </span>
        <button
          type="button"
          className="g-close"
          onClick={onClose}
          aria-label="Показати весь фасад"
        >
          Весь фасад
        </button>
      </div>
      <p className="muted">
        {info.game.name} · {TIER_LABEL[info.tier]} ·{" "}
        {mine ? (
          "ти вже засвітив"
        ) : (
          <>
            +{points}
            <Bolt size={13} />
            {solvers.length === 0 ? " першому" : ""}
          </>
        )}
      </p>
      {now.length > 0 && (
        <p className="g-playing">
          <span className="g-dot" aria-hidden="true" />
          Зараз грає: {now.map((id) => playerName(state.players[id])).join(", ")}
        </p>
      )}
      {solvers.length > 0 && (
        <ul className="g-solvers" aria-label="Хто пройшов це вікно">
          {solvers.map((x, i) => (
            <li key={x.id}>
              <Avatar id={x.id} player={state.players[x.id]} size={28} />
              <span className="g-solver-name">
                {playerName(state.players[x.id])}
                {i === 0 && <span className="g-first">перший</span>}
              </span>
              <span className="g-muted">
                {hhmm(x.at, tz)} · +{x.points}
                <Bolt size={12} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <a className="g-play" href={`#/game/${selected.floor}-${selected.col}`}>
        {mine ? "Зіграти ще раз" : solvers.length > 0 ? "Грати" : "Засвітити"}
      </a>
    </section>
  );
}

// ── a window's puzzle ─────────────────────────────────────────────────────────────────────────

function Play({
  api,
  session,
  win,
  onScored,
}: {
  api: ReturnType<typeof gameApi>;
  session: string;
  win: FacadeWindow;
  onScored: () => void;
}) {
  const info = useMemo(
    () => windowGame(session, win.floor, win.col),
    [session, win.floor, win.col],
  );
  const [line, setLine] = useState<{ text: string; warn?: string }>({ text: "" });
  const [result, setResult] = useState<{ text: string; ok: boolean; points?: number } | null>(null);
  const [round, setRound] = useState(0);

  // the core learns the window is being played (others see it blink) and when it was opened
  useEffect(() => {
    const ping = () => {
      api.start(win.floor, win.col).catch(() => {});
    };
    ping();
    const timer = window.setInterval(ping, HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      api.leave(win.floor, win.col).catch(() => {});
    };
  }, [api, win.floor, win.col]);

  const solved = async (note: string, seconds: number) => {
    try {
      const r: SolveResult = await api.solve(win.floor, win.col);
      setResult(
        r.already
          ? { ok: true, text: `Вікно пройдено за ${seconds} с · за нього вже зараховано` }
          : {
              ok: true,
              points: r.points,
              text: `${r.first ? "ти засвітив першим! · " : ""}${seconds} с · ${note}`,
            },
      );
      navigator.vibrate?.(40);
      onScored();
    } catch (e) {
      const code = e instanceof GameApiError ? e.code : "network";
      setResult({
        ok: false,
        text:
          code === "too_fast"
            ? "Надто швидко — так не рахується. Зіграй ще раз"
            : code === "start_first" || code === "no_session"
              ? "Зв'язок із грою перервався. Зіграй ще раз"
              : "Не вдалося зарахувати: немає зв'язку. Зіграй ще раз, коли з'явиться",
      });
    }
  };

  return (
    <main className="screen">
      <GameHeader title={`Поверх ${win.floor} · вікно ${win.col}`} back />
      <section className="card">
        <div className="card-head">
          <span className="card-title">{info.game.name}</span>
          <span className="muted" style={{ fontSize: 13 }}>
            {TIER_LABEL[info.tier]}
          </span>
        </div>
        <p className="g-hint" aria-live="polite">
          {line.text}
          {line.warn && (
            <>
              {" · "}
              <span className="g-warn">{line.warn}</span>
            </>
          )}
        </p>
        <Board
          key={`${info.key}:${round}`}
          info={info}
          onSay={(text, warn) => setLine(warn ? { text, warn } : { text })}
          onDone={(note, seconds) => void solved(note, seconds)}
        />
      </section>
      {result ? (
        <section className="card">
          <p className={result.ok ? "g-result-text" : "g-result-text g-warn"}>
            {result.points !== undefined && (
              <>
                +{result.points}
                <Bolt size={16} />
                {" · "}
              </>
            )}
            {result.text}
          </p>
          {result.ok ? (
            <a className="g-play" href="#/game">
              До фасаду
            </a>
          ) : (
            <button
              type="button"
              className="g-btn"
              onClick={() => {
                setResult(null);
                setRound((r) => r + 1);
              }}
            >
              Зіграти ще раз
            </button>
          )}
        </section>
      ) : (
        <button
          type="button"
          className="g-btn"
          onClick={() => {
            setLine({ text: "" });
            setRound((r) => r + 1);
          }}
        >
          Почати спочатку
        </button>
      )}
    </main>
  );
}

/** One mounted puzzle; a new key starts it over. */
function Board({
  info,
  onSay,
  onDone,
}: {
  info: WindowGame;
  onSay: (text: string, warn?: string) => void;
  onDone: (note: string, seconds: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onSay, onDone });

  useEffect(() => {
    handlers.current = { onSay, onDone };
  });

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    root.replaceChildren();
    const started = performance.now();
    const cleanup = info.game.start(root, info.key, info.tier, {
      say: (text, warn) => handlers.current.onSay(text, warn),
      done: (note) =>
        handlers.current.onDone(note, Math.round((performance.now() - started) / 1000)),
    });
    return () => {
      cleanup?.();
      root.replaceChildren();
    };
  }, [info]);

  return <div className="g-board" ref={host} />;
}
