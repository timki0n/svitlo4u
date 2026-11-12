/**
 * «Гра» (only in the Telegram Mini App): the back facade of the building; every window holds a
 * small puzzle generated for the session — the latest outage. Solving it scores points and lights
 * the window for everybody; the facade starts dark at every new outage. Windows someone is playing
 * blink. #/game is the facade, #/game/<floor>-<col> a window's puzzle, #/game/rating the rating.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GAME_WINDOWS,
  gamePoints,
  gameSessionKey,
  isGameWindow,
} from "../../../../packages/domain/src/game.ts";
import { hhmm } from "../format.ts";
import type { Live } from "../live.ts";
import type { FacadeDoor, FacadeLit, FacadeScene, FacadeWindow } from "../scene3d.ts";
import { inMiniApp } from "../telegram.ts";
import { Icon } from "../ui.tsx";
import { GameApiError, type GameState, gameApi, type SolveResult } from "./api.ts";
import { DoorCard, EveningScreen } from "./Evenings.tsx";
import { partGame, TIER_LABEL, type WindowGame, windowGame } from "./games.ts";
import { Avatar, avatarLetter, avatarShade, Bolt, playerName, RatingScreen } from "./Rating.tsx";
import { rngOf } from "./rng.ts";
import "./game.css";

/** The facade is re-read this often while it is on screen. */
const POLL_MS = 3000;
/** While a puzzle is open, the phone tells the core every so often (others see it blink). */
const HEARTBEAT_MS = 10_000;

type Route =
  | { kind: "facade" }
  | { kind: "rating" }
  | { kind: "play"; win: FacadeWindow }
  | { kind: "part"; door: number; part: number }
  | { kind: "evening"; door: number };

function route(): Route {
  const hash = location.hash;
  if (hash === "#/game/rating") return { kind: "rating" };
  // «Вечорниці»: #/game/v/<door> its table, #/game/v/<door>/<part> a part's puzzle
  const v = /^#\/game\/v\/([1-5])(?:\/([1-3]))?$/.exec(hash);
  if (v)
    return v[2]
      ? { kind: "part", door: Number(v[1]), part: Number(v[2]) }
      : { kind: "evening", door: Number(v[1]) };
  const m = /^#\/game\/(\d+)-(\d+)$/.exec(hash);
  const floor = Number(m?.[1]);
  const col = Number(m?.[2]);
  return m && isGameWindow(floor, col) ? { kind: "play", win: { floor, col } } : { kind: "facade" };
}

const keyOf = (w: { floor: number; col: number }) => `${w.floor}-${w.col}`;

/** The facade state from the core, re-read while `active` and the page is visible. */
function useGame(siteId: string, active: boolean) {
  const api = useMemo(() => gameApi(siteId), [siteId]);
  const [state, setState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      loaded.current = true;
      setError(null);
    } catch (e) {
      setError(e instanceof GameApiError && e.status === 401 ? "auth" : "network");
    }
  }, [api]);
  useEffect(() => {
    if (!active) {
      // a window's screen needs the session too: once, e.g. after a reload on its address
      if (!loaded.current) void refresh();
      return;
    }
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
  const [door, setDoor] = useState<number | null>(
    where.kind === "part" || where.kind === "evening" ? where.door : null,
  );
  useEffect(() => {
    if (where.kind === "play") {
      setSelected(where.win);
      setDoor(null);
    } else if (where.kind === "part" || where.kind === "evening") {
      setDoor(where.door);
      setSelected(null);
    }
  }, [where]);
  // Up close (a window or a door picked on the facade, a puzzle, a table) the tab bar hides
  // (game.css) and the screen is the game's; it comes back on the whole facade, the rating, or if
  // the game breaks.
  const close =
    Boolean(state?.session) &&
    (where.kind === "play" ||
      where.kind === "part" ||
      where.kind === "evening" ||
      (where.kind === "facade" && (selected !== null || door !== null)));
  useEffect(() => {
    if (!close) return;
    document.documentElement.setAttribute("data-game", "");
    return () => document.documentElement.removeAttribute("data-game");
  }, [close]);

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
    return (
      // a window of its own each time, even when one follows another without the facade between
      <Play
        key={keyOf(where.win)}
        api={api}
        session={session}
        target={{ kind: "window", win: where.win }}
        onScored={refresh}
      />
    );
  if (where.kind === "part")
    return (
      <Play
        key={`door${where.door}-${where.part}`}
        api={api}
        session={session}
        target={{ kind: "part", door: where.door, part: where.part }}
        onScored={refresh}
      />
    );
  if (where.kind === "evening") return <EveningScreen api={api} door={where.door} />;
  return (
    <Facade
      state={state}
      tz={tz}
      session={session}
      selected={selected}
      onSelect={(w) => {
        setSelected(w);
        if (w) setDoor(null);
      }}
      door={door}
      onDoor={(d) => {
        setDoor(d);
        if (d) setSelected(null);
      }}
      offline={error === "network"}
    />
  );
}

function Notice({ text }: { text: string }) {
  return (
    <main className="screen">
      <GameHeader />
      <p className="card muted">{text}</p>
    </main>
  );
}

/** A window's header (titled) leads back to the facade; the facade's leads to the rating. */
function GameHeader({ title }: { title?: string }) {
  return (
    <header className="header">
      {title ? (
        <a className="g-back" href="#/game">
          <Icon name="back" size={18} />
          Фасад
        </a>
      ) : (
        <span className="label">Гра</span>
      )}
      {title ? (
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
  door,
  onDoor,
  offline,
}: {
  state: GameState;
  tz: string;
  session: string;
  selected: FacadeWindow | null;
  onSelect: (w: FacadeWindow | null) => void;
  door: number | null;
  onDoor: (door: number | null) => void;
  offline: boolean;
}) {
  const lit = useMemo(
    () =>
      new Map<string, FacadeLit>(
        state.windows.map((w) => {
          // who lives behind a window solved twice: a cat or a dog, its own for every outage
          const rng = rngOf(`${session}:${keyOf(w)}:pet`);
          const pet = rng() < 0.5 ? "cat" : "dog";
          return [keyOf(w), { solves: w.solvers.length, pet, place: rng() }];
        }),
      ),
    [state.windows, session],
  );
  const playing = useMemo(() => new Set(state.playing.map(keyOf)), [state.playing]);
  const doors = useMemo(
    (): FacadeDoor[] =>
      state.evenings.doors.map((d) => ({
        door: d.door,
        parts: d.parts.map((by) => by !== null),
        opening: d.opening.map((ids) => ids.length > 0),
        open: d.open,
        players: d.players.map((id) => ({
          id,
          avatar: state.players[id]?.avatar ?? null,
          letter: avatarLetter(state.players[id]),
          shade: avatarShade(id),
        })),
      })),
    [state.evenings, state.players],
  );
  const up = selected !== null || door !== null;
  const s = state.session;
  const label = s
    ? s.end === null
      ? `Відключення з ${hhmm(s.start, tz)}`
      : `Відключення ${hhmm(s.start, tz)}–${hhmm(s.end, tz)}`
    : "";
  return (
    <main className="screen">
      <GameHeader />
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
          doors={doors}
          door={door}
          onDoor={onDoor}
          inset={up ? 0 : SIDE_WIDTH + SIDE_GAP}
        />
        {!up && <SidePanel state={state} lit={lit.size} />}
      </div>
      {door !== null ? (
        <DoorCard state={state} door={door} onClose={() => onDoor(null)} />
      ) : (
        <WindowCard
          state={state}
          tz={tz}
          session={session}
          selected={selected}
          onClose={() => onSelect(null)}
        />
      )}
    </main>
  );
}

/** Room on the right of the whole facade for the progress. */
const SIDE_WIDTH = 112;
/** Air between the building and the panel. */
const SIDE_GAP = 22;

const percent = (part: number) =>
  `${((part / GAME_WINDOWS) * 100).toLocaleString("uk-UA", { maximumFractionDigits: 1 })}%`;

/** The ring's whole percent: no «0%» once a window is lit, no «100%» while one is still dark. */
const wholePercent = (part: number) => {
  const p = (part / GAME_WINDOWS) * 100;
  if (part > 0 && p < 1) return "1%";
  if (part < GAME_WINDOWS && p > 99) return "99%";
  return `${Math.round(p)}%`;
};

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
  // playing a window, or opening a door's part
  const online = new Set([
    ...state.playing.flatMap((p) => p.ids),
    ...state.evenings.doors.flatMap((d) => d.opening.flat()),
  ]);
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
      <span className="g-ring-pct">{wholePercent(part)}</span>
    </div>
  );
}

function FacadeFigure({
  lit,
  playing,
  selected,
  onSelect,
  doors,
  door,
  onDoor,
  inset,
}: {
  lit: ReadonlyMap<string, FacadeLit>;
  playing: ReadonlySet<string>;
  selected: FacadeWindow | null;
  onSelect: (w: FacadeWindow) => void;
  doors: readonly FacadeDoor[];
  door: number | null;
  onDoor: (door: number) => void;
  /** Room kept free on the right (px). */
  inset: number;
}) {
  const host = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<FacadeScene | null>(null);
  const latest = useRef({ lit, playing, selected, onSelect, doors, door, onDoor, inset });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    latest.current = { lit, playing, selected, onSelect, doors, door, onDoor, inset };
  });

  useEffect(() => {
    let cancelled = false;
    import("../scene3d.ts")
      .then(({ createFacade }) => {
        if (cancelled || !host.current || !canvas.current) return;
        const s = createFacade(
          host.current,
          canvas.current,
          (w) => latest.current.onSelect(w),
          (d) => latest.current.onDoor(d),
        );
        s.setLit(latest.current.lit);
        s.setPlaying(latest.current.playing);
        s.setDoors(latest.current.doors);
        s.setInset(latest.current.inset);
        s.select(latest.current.selected);
        s.selectDoor(latest.current.door);
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
    scene.current?.setDoors(doors);
  }, [doors]);
  useEffect(() => {
    scene.current?.setInset(inset);
    scene.current?.select(selected);
    scene.current?.selectDoor(door);
  }, [selected, door, inset]);

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
          Крути будинок пальцем, торкнися вікна й пройди міні-гру: вікно засвітиться для всіх, а ти
          отримаєш <Bolt size={13} />. Хто засвітить першим — отримає в півтора раза більше.
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

/** Why a door's part may not be opened, as the core answers its start or solve. */
const PART_REFUSALS: Record<string, string> = {
  taken: "Цю частину вже відчинив хтось інший",
  one_part_each: "У цих дверях у тебе вже є своя частина: інші відчиняють сусіди",
  no_session: "Двері відчиняються лише під час відключення",
  bad_door: "Таких дверей немає",
};

/** What a puzzle opens: a window, or a part of a door of «Вечорниці». */
type PlayTarget =
  | { kind: "window"; win: FacadeWindow }
  | { kind: "part"; door: number; part: number };

function Play({
  api,
  session,
  target,
  onScored,
}: {
  api: ReturnType<typeof gameApi>;
  session: string;
  target: PlayTarget;
  onScored: () => void;
}) {
  const win = target.kind === "window" ? target.win : { floor: 0, col: 0 };
  const door = target.kind === "part" ? target : null;
  // plain numbers for the hooks: a door's part, or 0 for a window
  const doorNo = door?.door ?? 0;
  const partNo = door?.part ?? 0;
  const info = useMemo(
    () => (doorNo ? partGame(session, doorNo, partNo) : windowGame(session, win.floor, win.col)),
    [session, win.floor, win.col, doorNo, partNo],
  );
  const [line, setLine] = useState<{ text: string; warn?: string }>({ text: "" });
  const [result, setResult] = useState<{ text: string; ok: boolean; points?: number } | null>(null);
  const [round, setRound] = useState(0);
  /** A door's part one may not open (taken, or one's own part is another): said instead of a puzzle. */
  const [refused, setRefused] = useState<string | null>(null);
  /** The part opened here: its phone stops checking in. */
  const partDone = useRef(false);

  // the core learns the window (or the door's part) is being played — others see it blink — and
  // when it was opened; the phone checks in while it is, and says when it leaves
  useEffect(() => {
    if (doorNo) {
      setRefused(null);
      partDone.current = false;
      let refusedHere = false;
      const ping = () => {
        if (refusedHere || partDone.current) return;
        api.partStart(doorNo, partNo).catch((e: unknown) => {
          const text = e instanceof GameApiError ? PART_REFUSALS[e.code] : undefined;
          if (!text || partDone.current) return;
          refusedHere = true;
          setRefused(text);
        });
      };
      ping();
      const timer = window.setInterval(ping, HEARTBEAT_MS);
      return () => {
        window.clearInterval(timer);
        if (!partDone.current) api.partLeave(doorNo, partNo).catch(() => {});
      };
    }
    const ping = () => {
      api.start(win.floor, win.col).catch(() => {});
    };
    ping();
    const timer = window.setInterval(ping, HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      api.leave(win.floor, win.col).catch(() => {});
    };
  }, [api, win.floor, win.col, doorNo, partNo]);

  const solved = async (note: string, seconds: number) => {
    try {
      if (door) {
        partDone.current = true;
        const r = await api.partSolve(door.door, door.part);
        setResult({ ok: true, points: r.points, text: `${seconds} с · частину дверей відчинено` });
        navigator.vibrate?.(40);
        onScored();
        return;
      }
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
            : (code === "taken" || code === "one_part_each") && PART_REFUSALS[code]
              ? PART_REFUSALS[code]
              : code === "start_first" || code === "no_session"
                ? "Зв'язок із грою перервався. Зіграй ще раз"
                : "Не вдалося зарахувати: немає зв'язку. Зіграй ще раз, коли з'явиться",
      });
    }
  };

  if (refused)
    return (
      <main className="screen">
        <GameHeader title={`Вечорниця ${doorNo} · частина ${partNo}`} />
        <section className="card">
          <p className="g-result-text g-warn">{refused}</p>
          <a className="g-play" href="#/game">
            До фасаду
          </a>
        </section>
      </main>
    );

  return (
    <main className="screen">
      <GameHeader
        title={
          door
            ? `Вечорниця ${door.door} · частина ${door.part}`
            : `Поверх ${win.floor} · вікно ${win.col}`
        }
      />
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
              {line.text && " · "}
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

/** Kept free under a board: the card's padding and the page's own, down to the screen's edge. */
const BOARD_BELOW = 40;
/** Under the gauge of «Запобіжник»: its lights and its button. */
const FUSE_CONTROLS = 90;

/**
 * Fit a tall board into the screen's height, so its bottom (the bag's last items, the fuse's
 * button) is in reach without scrolling: the room below the board's top goes into --board-room
 * (the boards that size themselves read it), and an SVG board taller than that is made narrower,
 * its height following.
 */
function fitBoard(root: HTMLElement) {
  const screen = window.visualViewport?.height ?? window.innerHeight;
  const top = root.getBoundingClientRect().top + window.scrollY;
  const room = Math.max(260, Math.floor(screen - top - BOARD_BELOW));
  root.style.setProperty("--board-room", `${room}px`);
  for (const svg of root.querySelectorAll<SVGSVGElement>(":scope > svg.g-svg")) {
    const box = svg.viewBox.baseVal;
    if (!box?.height) continue;
    const fits = room - (svg.classList.contains("g-fuse") ? FUSE_CONTROLS : 0);
    svg.style.width =
      box.height > fits ? `${Math.max(160, (fits * box.width) / box.height)}px` : "";
  }
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
    fitBoard(root); // before the game mounts: the ones that size themselves read the room
    let raf = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitBoard(root));
    };
    const started = performance.now();
    const cleanup = info.game.start(root, info.key, info.tier, {
      say: (text, warn) => handlers.current.onSay(text, warn),
      done: (note) =>
        handlers.current.onDone(note, Math.round((performance.now() - started) / 1000)),
      fit: refit,
    });
    fitBoard(root);
    window.addEventListener("resize", refit);
    return () => {
      window.removeEventListener("resize", refit);
      cancelAnimationFrame(raf);
      cleanup?.();
      root.replaceChildren();
    };
  }, [info]);

  return <div className="g-board" ref={host} />;
}
