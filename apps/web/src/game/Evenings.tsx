/**
 * «Вечорниці»: the doors of the facade's ground floor. On the facade, a door's card (its parts,
 * who opened them, who sits at its table); behind a door, its table — «Графік» for two or poker —
 * kept live by asking the core again whenever it answers (it answers when something changes).
 */
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui.tsx";
import type {
  EveningDoor,
  EveningGame,
  EveningMove,
  EveningTableView,
  GameState,
  gameApi,
} from "./api.ts";
import { GameApiError } from "./api.ts";
import { BlackoutScreen } from "./Blackout.tsx";
import { ColorsScreen } from "./Colors.tsx";
import { CardFace, clock, Net, placesOf, tableLayout, useSize } from "./cards.tsx";
import { DurakScreen } from "./Durak.tsx";
import { Emotes } from "./emotes.tsx";
import { PayFlight } from "./flight.tsx";
import { Avatar, Bolt, playerName } from "./Rating.tsx";
import { GiveUp, Watchers } from "./round.tsx";

type Api = ReturnType<typeof gameApi>;

export const EVENING_NAMES: Record<EveningGame, string> = {
  battle: "Графік",
  poker: "Покер",
  durak: "Дурень",
  colors: "Кольори",
  blackout: "Блекаут",
};
const EVENING_ABOUT: Record<EveningGame, string> = {
  battle:
    "Двоє ховають блоки відключень у тижневому графіку й по черзі «прозвонюють» графік суперника",
  poker: "Техаський холдем на 2–6 гравців: фішки — бали цього відключення",
  durak: "Підкидний дурень на 2–6 гравців: хто лишиться з картами, той платить решті",
  colors: "Карта до карти за кольором чи значенням, на 2–6 гравців: хто першим скине всі, виграв",
  blackout:
    "Тягни карти й оминай блекаути, на 2–6 гравців: витягнув без генератора — вибув, останній виграв",
};

// ── the door's card on the facade ─────────────────────────────────────────────────────────────

export function DoorCard({
  state,
  door,
  onClose,
}: {
  state: GameState;
  door: number;
  onClose: () => void;
}) {
  const d = state.evenings.doors[door - 1];
  if (!d) return null;
  const mine = d.parts.indexOf(state.me.id);
  return (
    <section className="card g-sheet" aria-live="polite">
      <div className="card-head">
        <span className="card-title">
          Вечорниця {door} · {EVENING_NAMES[d.game]}
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
      <p className="muted">{EVENING_ABOUT[d.game]}.</p>
      {d.open ? (
        <DoorTable d={d} state={state} door={door} />
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            Двері відчиняться, коли троє сусідів пройдуть по одній частині — важку гру, +50
            <Bolt size={12} /> кожному.
          </p>
          <ol className="g-parts" aria-label="Частини дверей">
            {d.parts.map((by, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the three parts never move
              <li key={i} data-open={by !== null || undefined}>
                {by !== null ? (
                  <>
                    <Avatar id={by} player={state.players[by]} size={22} />
                    <span className="g-part-name">{playerName(state.players[by])}</span>
                  </>
                ) : mine < 0 ? (
                  <a className="g-part-open" href={`#/game/v/${door}/${i + 1}`}>
                    Відчинити
                  </a>
                ) : (
                  <span className="g-muted">чекає сусіда</span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/** An open door: who sits at its table (the point of it), then, quietly, who opened it. */
function DoorTable({ d, state, door }: { d: EveningDoor; state: GameState; door: number }) {
  const name = (id: number) => playerName(state.players[id]);
  const openers = d.parts.filter((id): id is number => id !== null);
  const watching = d.watchers > 0 ? ` · дивляться: ${d.watchers}` : "";
  return (
    <>
      <div className="g-at-table">
        {d.players.length > 0 ? (
          <>
            <span className="g-faces" aria-hidden="true">
              {d.players.slice(0, 6).map((id) => (
                <span key={id} className="g-stack-face">
                  <Avatar id={id} player={state.players[id]} size={34} />
                </span>
              ))}
            </span>
            <span className="g-at-table-text">
              <b>{d.players.map(name).join(", ")}</b>
              <span className="g-muted">
                {d.live && <span className="g-dot" aria-hidden="true" />}
                {d.live
                  ? "грають зараз"
                  : d.players.length === 1
                    ? "чекає на суперника"
                    : "за столом"}
                {watching}
              </span>
            </span>
          </>
        ) : (
          <span className="g-muted">Стіл вільний: сідай першим{watching}</span>
        )}
      </div>
      <a className="g-play" href={`#/game/v/${door}`}>
        Увійти
      </a>
      <p className="g-openers">Відчинили: {openers.map(name).join(", ")}</p>
    </>
  );
}

// ── behind the door: its table ────────────────────────────────────────────────────────────────

/** The table, kept live: each answer of the core is a change, so ask again at once. */
function useTable(api: Api, door: number) {
  const [view, setView] = useState<{ v: EveningTableView; at: number } | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    let since = -1;
    (async () => {
      while (!ctrl.signal.aborted) {
        try {
          const v = await api.table(door, since, ctrl.signal);
          since = v.version;
          setView({ v, at: Date.now() });
          setOffline(false);
        } catch {
          if (ctrl.signal.aborted) return;
          setOffline(true);
          await new Promise((r) => setTimeout(r, 2500));
        }
      }
    })();
    return () => ctrl.abort();
  }, [api, door]);
  return { view, offline };
}

/** Seconds left on the move under way, ticking. */
function useCountdown(deadline: number | null, serverNow: number, at: number): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (deadline === null) return;
    const id = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, [deadline]);
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - serverNow - (Date.now() - at)) / 1000));
}

const REFUSALS: Record<string, string> = {
  closed: "Ці двері ще зачинені",
  at_a_table: "Ти вже за іншим столом або в черзі",
  stake_too_small: "Замала ставка",
  not_enough_points: "Не вистачає балів цього відключення",
  not_your_turn: "Зараз не твій хід",
  rung_already: "Цей проміжок уже прозвонено",
  no_session: "Зараз немає відключення",
  // «Дурень»: the screen offers only what may be done, so these come from a race
  rank_not_on_table: "Підкидати можна лише ранги, що вже є на столі",
  table_full: "На столі вже досить карт",
  does_not_beat: "Ця карта не б'є",
  not_your_lead: "Зараз ходить інший",
  took_already: "Карти вже беруть",
  // «Кольори»
  not_playable: "Цю карту зараз не можна покласти",
  wild_four_has_color: "+4 можна, лише коли нема карт потрібного кольору",
  must_play_drawn: "Після того як узяв, можна зіграти лише взяту карту",
  pick_color: "Обери колір",
  // «Блекаут»
  pending: "Зачекай: попередня дія ще не спрацювала",
  defusing: "Спершу сховай блекаут назад у колоду",
  bad_target: "У цього гравця не можна красти",
  nothing_pending: "Нічого скасовувати: дія вже спрацювала",
};
const refusal = (e: unknown) =>
  e instanceof GameApiError
    ? (REFUSALS[e.code] ?? "Не вийшло, спробуй ще раз")
    : "Немає зв'язку, спробуй ще раз";

export function EveningScreen({ api, door }: { api: Api; door: number }) {
  const { view, offline } = useTable(api, door);
  const main = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (call: () => Promise<unknown>) => {
    setError(null);
    call().catch((e: unknown) => setError(refusal(e)));
  };
  const v = view?.v;
  const left = useCountdown(v?.deadline ?? null, v?.now ?? 0, view?.at ?? 0);
  return (
    <main className="screen" ref={main}>
      <PayFlight
        result={v?.result}
        serverNow={v?.now ?? 0}
        root={main}
        from={v?.game === "poker" ? "pot" : "players"}
      />
      <header className="header">
        <a className="g-back" href="#/game">
          <Icon name="back" size={18} />
          Фасад
        </a>
        <span className="label">
          Вечорниця {door}
          {v && v.game !== "battle" && ` · ${EVENING_NAMES[v.game]}`}
        </span>
      </header>
      {!v ? (
        <p className="muted">{offline ? "Немає зв'язку…" : "Завантаження…"}</p>
      ) : v.game === "poker" ? (
        <PokerScreen v={v} api={api} door={door} run={run} left={left} error={error} />
      ) : v.game === "durak" ? (
        <DurakScreen v={v} api={api} door={door} run={run} left={left} error={error} />
      ) : v.game === "colors" ? (
        <ColorsScreen v={v} api={api} door={door} run={run} left={left} error={error} />
      ) : v.game === "blackout" ? (
        <BlackoutScreen v={v} api={api} door={door} run={run} left={left} error={error} />
      ) : (
        <>
          <section className="card g-table">
            <div className="card-head">
              <span className="card-title">{EVENING_NAMES[v.game]}</span>
              <span className="g-head-side muted">
                <Watchers v={v} size={18} />
                {left !== null && <span>⏱ {clock(left)}</span>}
              </span>
            </div>
            <BattleTable v={v} api={api} door={door} run={run} />
            {error && <p className="g-warn">{error}</p>}
          </section>
          <Seating v={v} api={api} door={door} run={run} />
        </>
      )}
      {v && <Emotes v={v} api={api} door={door} root={main} />}
    </main>
  );
}

type TableProps = {
  v: EveningTableView;
  api: Api;
  door: number;
  run: (call: () => Promise<unknown>) => void;
};

/** «Графік»: sitting down with a stake (a slider), the queue, standing up or giving in. */
function Seating({ v, api, door, run }: TableProps) {
  const max = Math.max(v.minStake, v.available);
  const [stake, setStake] = useState(v.minStake);
  const seat = v.seats.find((s) => s.id === playerOf(v));
  if (seat || v.me.seated) {
    const live = v.battle?.phase === "playing";
    return (
      <section className="card">
        <p className="muted" style={{ fontSize: 13 }}>
          Твоя ставка: <b>{seat?.stake ?? 0}</b>
          <Bolt size={12} />
        </p>
        {live ? (
          <GiveUp
            cost={
              <>
                Перемога дістанеться суперникові: віддаси йому{" "}
                {Math.min(
                  seat?.stake ?? 0,
                  v.seats.find((s) => s.id !== playerOf(v))?.stake ?? seat?.stake ?? 0,
                )}
                <Bolt size={12} />
              </>
            }
            onYes={() => run(() => api.stand(door))}
          />
        ) : (
          <button type="button" className="g-btn" onClick={() => run(() => api.stand(door))}>
            Встати з-за столу
          </button>
        )}
      </section>
    );
  }
  if (v.me.queued) {
    return (
      <section className="card">
        <p className="muted">
          Ти в черзі: {v.queue.indexOf(playerOf(v)) + 1}-й. Сядеш, щойно звільниться місце.
        </p>
        <button type="button" className="g-btn" onClick={() => run(() => api.stand(door))}>
          Вийти з черги
        </button>
      </section>
    );
  }
  if (!v.open) return null;
  if (v.available < v.minStake)
    return (
      <section className="card">
        <p className="muted">
          Щоб сісти, потрібно щонайменше {v.minStake}
          <Bolt size={12} /> цього відключення. Засвіти кілька вікон — і повертайся.
        </p>
      </section>
    );
  const value = Math.min(Math.max(stake, v.minStake), max);
  return (
    <section className="card">
      <label className="g-stake">
        <span>
          Моя ставка: <b>{value}</b>
          <Bolt size={12} /> <span className="g-muted">з {v.available}</span>
        </span>
        <input
          type="range"
          aria-label="Ставка"
          min={v.minStake}
          max={max}
          step={1}
          value={value}
          onChange={(e) => setStake(Number(e.target.value))}
        />
      </label>
      <button type="button" className="g-play" onClick={() => run(() => api.join(door, value))}>
        {v.seats.length >= 2 || v.battle ? "Стати в чергу" : "Сісти за стіл"}
      </button>
      <p className="g-muted" style={{ fontSize: 12 }}>
        Переможець забирає в суперника меншу з двох ставок.
      </p>
    </section>
  );
}

/** The viewer's own id. */
const playerOf = (v: EveningTableView): number => v.me.id;

// ── «Графік» ──────────────────────────────────────────────────────────────────────────────────

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

type Battle = NonNullable<EveningTableView["battle"]>;

function BattleTable({ v, api, door, run }: TableProps) {
  const b = v.battle;
  const me = playerOf(v);
  // my turn has come: a short buzz, so it is felt even with the eyes elsewhere
  const myTurn = b?.phase === "playing" && b.turn === me;
  useEffect(() => {
    if (myTurn) navigator.vibrate?.(35);
  }, [myTurn]);
  if (!b)
    return (
      <p className="muted">
        {v.seats.length === 1
          ? `${playerName(v.players[v.seats[0]?.id ?? 0])} чекає на суперника.`
          : "Стіл вільний: сідай і чекай на суперника."}
        {v.result && <ResultLine v={v} />}
      </p>
    );
  const mineIdx = b.sides.findIndex((s) => s.id === me);
  const seated = mineIdx >= 0;
  if (b.phase === "placing" && seated) {
    const ready = b.sides[mineIdx]?.ready;
    return (
      <div className="g-battle">
        <p className="muted" style={{ fontSize: 13 }}>
          {ready
            ? "Готово. Чекаємо, поки суперник сховає свої блоки…"
            : "Це твій графік відключень: суперник його не бачить. Перемішай, поки не сподобається, і тисни «Готово»."}
        </p>
        <Schedule b={b} blocks={b.draft ?? b.sides[mineIdx]?.blocks ?? []} rings={[]} />
        {!ready && (
          <div className="g-row">
            <button
              type="button"
              className="g-btn"
              onClick={() => run(() => api.move(door, { type: "shuffle" }))}
            >
              Перемішати
            </button>
            <button
              type="button"
              className="g-play"
              onClick={() => run(() => api.move(door, { type: "ready" }))}
            >
              Готово
            </button>
          </div>
        )}
      </div>
    );
  }
  const name = (id: number) => playerName(v.players[id]);
  const playing = b.phase === "playing";
  // a side's schedule: its blocks (as far as one may see them) and the other's rings on it
  const board = (i: 0 | 1) => {
    const side = b.sides[i];
    const rings = b.sides[i === 0 ? 1 : 0].shots;
    const rung = new Set(rings.map((r) => r.cell));
    const found = side.blocks.filter((bl) =>
      Array.from({ length: bl.len }, (_, k) => bl.day * b.slots + bl.from + k).every((c) =>
        rung.has(c),
      ),
    ).length;
    return { side, rings, found, last: rings[rings.length - 1]?.cell ?? null };
  };
  // the one who moves rings the other's schedule: theirs is shaded, the one rung stands out
  const state = (id: number) =>
    !playing ? undefined : b.turn === id ? "shaded" : b.turn === me ? "mine" : "rung";
  const field = (i: 0 | 1, mini: boolean) => {
    const { side, rings, found, last } = board(i);
    const theirs = seated && side.id !== me;
    return (
      <div
        key={side.id}
        className="g-field"
        data-mini={mini || undefined}
        data-state={state(side.id)}
      >
        <p className="g-schedule-title">
          <span className="g-pid" data-pid={side.id}>
            <Avatar id={side.id} player={v.players[side.id]} size={mini ? 18 : 22} />
          </span>
          <span className="g-field-name">
            {seated ? (theirs ? `Суперник · ${name(side.id)}` : "Мій графік") : name(side.id)}
          </span>
          <span className="g-found">
            {found}/{b.total}
          </span>
        </p>
        <Schedule
          b={b}
          blocks={side.blocks}
          rings={rings}
          last={last}
          mini={mini}
          onRing={
            theirs && myTurn
              ? (cell) => run(() => api.move(door, { type: "ring", cell }))
              : undefined
          }
        />
      </div>
    );
  };
  const rival: 0 | 1 = mineIdx === 0 ? 1 : 0;
  const mover = b.turn !== null ? name(b.turn) : "";
  return (
    <div className="g-battle">
      <div className="g-turn" data-mine={myTurn || undefined}>
        {b.phase === "placing" ? (
          <b>Гравці ховають свої блоки…</b>
        ) : b.phase === "done" ? (
          <b>{b.winner === me ? "Перемога за тобою!" : "Гру завершено"}</b>
        ) : myTurn ? (
          <>
            <b>Твій хід</b>
            <span>торкнися проміжку в графіку суперника</span>
          </>
        ) : (
          <>
            <b>Хід: {mover}</b>
            <span>
              {seated
                ? "дзвонить у твій графік"
                : `дзвонить у графік: ${name(b.sides.find((x) => x.id !== b.turn)?.id ?? 0)}`}
            </span>
          </>
        )}
      </div>
      {seated ? (
        <>
          {field(rival, false)}
          <div className="g-mine-row">
            {field(mineIdx as 0 | 1, true)}
            <p className="g-legend" data-column>
              <span>
                <span className="g-cell" data-k="light" /> світло є
              </span>
              <span>
                <span className="g-cell" data-k="hit" /> влучання
              </span>
              <span>
                <span className="g-cell" data-k="found" /> знайдений блок
              </span>
              <span className="g-muted">дзвониш ще раз, доки влучаєш</span>
            </p>
          </div>
        </>
      ) : (
        <>
          {field(0, false)}
          {field(1, false)}
          <p className="g-legend">
            <span className="g-cell" data-k="light" /> світло є
            <span className="g-cell" data-k="hit" /> влучання
            <span className="g-cell" data-k="found" /> знайдений блок
          </p>
        </>
      )}
      {v.result && <ResultLine v={v} />}
    </div>
  );
}

/** A week's schedule: days down, 3-hour slots across. */
function Schedule({
  b,
  blocks,
  rings,
  last = null,
  mini = false,
  onRing,
}: {
  b: Battle;
  blocks: { day: number; from: number; len: number }[];
  rings: { cell: number; hit: boolean; sunk: boolean }[];
  /** The cell rung last on it: marked, so what just happened is seen. */
  last?: number | null;
  /** Small, without the hours and the days: one's own schedule beside the rival's. */
  mini?: boolean;
  onRing?: ((cell: number) => void) | undefined;
}) {
  const kind = useMemo(() => {
    const out = new Map<number, string>();
    const inBlock = new Set<number>();
    for (const bl of blocks)
      for (let i = 0; i < bl.len; i++) inBlock.add(bl.day * b.slots + bl.from + i);
    const rung = new Map(rings.map((r) => [r.cell, r]));
    for (let c = 0; c < b.days * b.slots; c++) {
      const r = rung.get(c);
      if (r) out.set(c, r.hit ? "hit" : "light");
      else if (inBlock.has(c)) out.set(c, "block");
    }
    // a block rung whole is found, and around it there is light for sure
    for (const bl of blocks) {
      const all = Array.from({ length: bl.len }, (_, i) => bl.day * b.slots + bl.from + i);
      if (!all.every((c) => rung.has(c))) continue;
      for (const c of all) out.set(c, "found");
      for (let d = bl.day - 1; d <= bl.day + 1; d++)
        for (let s = bl.from - 1; s <= bl.from + bl.len; s++)
          if (d >= 0 && d < b.days && s >= 0 && s < b.slots && !out.has(d * b.slots + s))
            out.set(d * b.slots + s, "near");
    }
    return out;
  }, [b.days, b.slots, blocks, rings]);
  if (mini)
    return (
      <div
        className="g-schedule"
        data-mini
        style={{ gridTemplateColumns: `repeat(${b.slots}, 1fr)` }}
      >
        {Array.from({ length: b.days }, (_, d) => (
          <Row key={DAYS[d]} day={d} b={b} kind={kind} last={last} bare />
        ))}
      </div>
    );
  return (
    <div className="g-schedule" style={{ gridTemplateColumns: `26px repeat(${b.slots}, 1fr)` }}>
      <span />
      {Array.from({ length: b.slots }, (_, s) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hours of a day
        <span key={s} className="g-hour">
          {String((s * 24) / b.slots).padStart(2, "0")}
        </span>
      ))}
      {Array.from({ length: b.days }, (_, d) => (
        <Row key={DAYS[d]} day={d} b={b} kind={kind} last={last} onRing={onRing} />
      ))}
    </div>
  );
}

function Row({
  day,
  b,
  kind,
  last,
  bare = false,
  onRing,
}: {
  day: number;
  b: Battle;
  kind: Map<number, string>;
  last: number | null;
  /** Without the day's name (the mini view). */
  bare?: boolean;
  onRing?: ((cell: number) => void) | undefined;
}) {
  return (
    <>
      {!bare && <span className="g-day">{DAYS[day]}</span>}
      {Array.from({ length: b.slots }, (_, s) => {
        const cell = day * b.slots + s;
        const k = kind.get(cell);
        const can = onRing && (k === undefined || k === "block");
        return can ? (
          <button
            key={cell}
            type="button"
            className="g-cell g-cell-tap"
            data-k={k}
            aria-label={`${DAYS[day]}, ${String(s * 3).padStart(2, "0")}:00`}
            onClick={() => onRing?.(cell)}
          />
        ) : (
          <span key={cell} className="g-cell" data-k={k} data-last={cell === last || undefined} />
        );
      })}
    </>
  );
}

function ResultLine({ v }: { v: EveningTableView }) {
  const r = v.result;
  if (!r) return null;
  const names = r.winners.map((id) => playerName(v.players[id])).join(", ");
  return (
    <p className="g-result-text">
      {names ? `Перемога: ${names}` : "Роздачу завершено"}
      {v.game === "battle" && r.text && (
        <>
          {" "}
          · {r.text}
          <Bolt size={14} />
        </>
      )}
    </p>
  );
}

// ── poker ─────────────────────────────────────────────────────────────────────────────────────

/** The poker room: the table, round, and under it my moves (or my seat, or a stake to sit with). */
function PokerScreen({
  v,
  api,
  door,
  run,
  left,
  error,
}: TableProps & { left: number | null; error: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(box);
  const p = v.poker;
  if (!p) return null;
  const me = playerOf(v);
  const hand = p.hand;
  const done = hand?.street === "done";
  const name = (id: number) => playerName(v.players[id]);
  // the ring: the hand's seats in their order (one who busts keeps their place till the next
  // hand), then whoever waits for the next one; me at the bottom
  const ids = (hand?.seats ?? []).map((s) => s.id);
  for (const s of v.seats) if (!ids.includes(s.id)) ids.push(s.id);
  const at = ids.indexOf(me);
  const ring = (at > 0 ? [...ids.slice(at), ...ids.slice(0, at)] : ids).slice(0, 6);
  const places = placesOf(ring.length, ring[0] === me);
  const L = tableLayout(w, h);
  const turnId = hand && hand.turn !== null ? hand.seats[hand.turn]?.id : undefined;
  const buttonId = hand ? hand.seats[hand.button]?.id : undefined;
  const result = (id: number) => hand?.results?.find((r) => r.id === id);
  const pot = hand ? hand.seats.reduce((n, s) => n + s.total, 0) : 0;
  const winners = done ? (v.result?.winners ?? []) : [];
  return (
    <>
      <div ref={box} className="g-felt-box" data-compact={L.compact || undefined}>
        <div className="g-felt" style={L.felt} />
        {v.watchers.length > 0 && (
          <span className="g-felt-note" data-side="left">
            <Watchers v={v} />
          </span>
        )}
        {left !== null && (
          <span className="g-felt-note" data-side="right">
            ⏱ {clock(left)}
          </span>
        )}
        <div className="g-felt-middle" style={{ top: L.middle }}>
          {hand ? (
            <>
              <span className="g-community">
                {Array.from({ length: 5 }, (_, i) =>
                  hand.board[i] ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the five places of the board
                    <CardFace key={i} card={hand.board[i]} size="board" />
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the five places of the board
                    <span key={i} className="g-card-slot" />
                  ),
                )}
              </span>
              <span className="g-pot" data-pid="pot">
                {winners.length > 0 ? (
                  <>
                    Перемога: <b>{winners.map(name).join(", ")}</b>
                  </>
                ) : (
                  <>
                    Банк <b>{pot}</b>
                    <Bolt size={12} /> · роздача {p.handNo}
                  </>
                )}
              </span>
            </>
          ) : (
            <span className="g-felt-text">
              {ring.length < 2
                ? "Чекаємо гравців: роздача почнеться, коли за столом буде двоє"
                : "Роздача ось-ось почнеться…"}
              <small>
                Блайнди {p.blinds.small}/{p.blinds.big} · від кожного суперника виграєш не більше,
                ніж поставив сам
              </small>
            </span>
          )}
        </div>
        {ring.map((id, i) => {
          const place = places[i] ?? 0;
          const spot = L.places[place] ?? { x: 0, y: 0 };
          const chip = L.chips[place] ?? { x: 0, y: 0 };
          const hs = hand?.seats.find((s) => s.id === id);
          const seat = v.seats.find((s) => s.id === id);
          const stack = hs ? hs.stack : (seat?.stake ?? 0);
          const net = result(id)?.net ?? 0;
          const shown = result(id)?.hand;
          const bet = hs && !done ? hs.bet : 0;
          // a seat's cards are shown at the showdown
          const open = Boolean(hs && !hs.folded && hs.cards[0]);
          const state = done
            ? null
            : hs?.folded
              ? "пас"
              : hs?.allIn
                ? "ва-банк"
                : hand && !hs
                  ? "наступна роздача"
                  : seat?.leaving
                    ? "встає"
                    : null;
          const flags = {
            "data-turn": id === turnId || undefined,
            "data-out": hs?.folded || undefined,
            "data-win": winners.includes(id) || undefined,
          };
          const mine = id === me;
          return (
            <Fragment key={id}>
              {bet > 0 && (
                <span className="g-chip" style={{ left: chip.x, top: chip.y }}>
                  {bet}
                </span>
              )}
              {mine ? (
                <div className="g-pme" data-pid={id} {...flags}>
                  {hs && (
                    <span className="g-pme-cards">
                      <CardFace card={hs.cards[0]} size="big" />
                      <CardFace card={hs.cards[1]} size="big" />
                    </span>
                  )}
                  <span className="g-pme-plate">
                    <b>Ти</b>
                    <span>
                      {stack}
                      <Bolt size={11} />
                    </span>
                    {id === buttonId && <span className="g-dealer-mark">D</span>}
                    {state && <span className="g-muted">{state}</span>}
                    {done && net !== 0 && <Net net={net} />}
                    {done && shown && <span className="g-hand-name">{shown}</span>}
                  </span>
                </div>
              ) : (
                <div
                  className="g-pseat"
                  data-pid={id}
                  style={{ left: spot.x, top: spot.y }}
                  {...flags}
                >
                  {/* face down they peek out above the face; shown, they come out in front of it */}
                  <span className="g-pseat-cards" data-open={open || undefined}>
                    {hs && !hs.folded && (
                      <>
                        <CardFace card={hs.cards[0]} size={open ? "open" : "mini"} />
                        <CardFace card={hs.cards[1]} size={open ? "open" : "mini"} />
                      </>
                    )}
                  </span>
                  <span className="g-pseat-face">
                    <Avatar id={id} player={v.players[id]} size={L.compact ? 34 : 40} />
                    {id === buttonId && <span className="g-dealer">D</span>}
                  </span>
                  <span className="g-pseat-plate">
                    <b className="g-pname">{name(id)}</b>
                    {done && net !== 0 ? <Net net={net} /> : <span>{state ?? stack}</span>}
                    {done && shown && <span className="g-hand-name">{shown}</span>}
                  </span>
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      <PokerMoves v={v} api={api} door={door} run={run} error={error} />
    </>
  );
}

/** Under the table: my moves when it is my move; otherwise how it stands and «Встати»; or, for
 *  one who watches, the stake to sit down with. */
function PokerMoves({ v, api, door, run, error }: TableProps & { error: string | null }) {
  const p = v.poker;
  const me = playerOf(v);
  const hand = p?.hand ?? null;
  // the raise slider starts from the smallest raise on every new move
  const moveKey = `${p?.handNo}:${hand?.street}:${hand?.currentBet}`;
  const [raiseAt, setRaise] = useState({ key: "", to: 0 });
  const [stake, setStake] = useState(v.minStake);
  const name = (id: number | undefined) => (id === undefined ? "" : playerName(v.players[id]));
  const seat = v.seats.find((s) => s.id === me);
  const legal = p?.legal ?? null;
  const done = hand?.street === "done";
  let body: ReactNode;
  if (legal && hand && !done) {
    const canRaise = legal.maxRaiseTo > 0;
    const raiseTo = Math.min(
      Math.max(raiseAt.key === moveKey ? raiseAt.to : 0, legal.minRaiseTo),
      legal.maxRaiseTo,
    );
    const move = (m: EveningMove) => run(() => api.move(door, m));
    body = (
      <>
        {canRaise && (
          <input
            className="g-raise"
            type="range"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            step={1}
            value={raiseTo}
            onChange={(e) => setRaise({ key: moveKey, to: Number(e.target.value) })}
            aria-label="До скількох підняти"
          />
        )}
        <div className="g-moves" data-two={!canRaise || undefined}>
          <button type="button" className="g-btn" onClick={() => move({ type: "fold" })}>
            Пас
          </button>
          {legal.canCheck ? (
            <button type="button" className="g-btn" onClick={() => move({ type: "check" })}>
              Чек
            </button>
          ) : (
            <button type="button" className="g-btn g-btn-2" onClick={() => move({ type: "call" })}>
              <small>Колл</small>
              <b>{legal.toCall}</b>
            </button>
          )}
          {canRaise && (
            <button
              type="button"
              className="g-play g-btn-2"
              onClick={() => move({ type: "raise", to: raiseTo })}
            >
              <small>
                {raiseTo === legal.maxRaiseTo
                  ? "Ва-банк"
                  : hand.currentBet === 0
                    ? "Поставити"
                    : "Підняти до"}
              </small>
              <b>{raiseTo}</b>
            </button>
          )}
        </div>
      </>
    );
  } else if (seat) {
    const hs = hand?.seats.find((s) => s.id === me);
    const turnId = hand && hand.turn !== null ? hand.seats[hand.turn]?.id : undefined;
    const net = hand?.results?.find((r) => r.id === me)?.net ?? 0;
    const status = seat.leaving
      ? "Встанеш після цієї роздачі"
      : !hand
        ? v.seats.length < 2
          ? "Чекаємо на суперника"
          : "Роздача ось-ось почнеться…"
        : done
          ? `${
              net > 0
                ? `Твій виграш: +${net}`
                : net < 0
                  ? `Ця роздача: −${-net}`
                  : "Роздачу завершено"
            } · ${
              // who stays for the next hand: two or more — it comes in a moment
              v.seats.filter((s) => s.stake > 0 && !s.leaving).length >= 2
                ? "наступна роздача за мить"
                : "чекаємо на суперника"
            }`
          : !hs
            ? "Карти отримаєш у наступній роздачі"
            : hs.folded
              ? `Ти пасуєш · хід: ${name(turnId)}`
              : `Хід: ${name(turnId)}`;
    body = (
      <div className="g-wait">
        <p>{status}</p>
        {!seat.leaving && (
          <button type="button" className="g-btn" onClick={() => run(() => api.stand(door))}>
            Встати
          </button>
        )}
      </div>
    );
  } else if (v.me.queued) {
    body = (
      <div className="g-wait">
        <p>Ти в черзі: {v.queue.indexOf(me) + 1}-й. Сядеш, щойно звільниться місце</p>
        <button type="button" className="g-btn" onClick={() => run(() => api.stand(door))}>
          Вийти
        </button>
      </div>
    );
  } else if (!v.open) {
    body = <p className="g-muted">Двері зачинилися: гру дограють без нових гравців</p>;
  } else if (v.available < v.minStake) {
    body = (
      <p className="g-muted">
        Щоб сісти, потрібно щонайменше {v.minStake}
        <Bolt size={12} /> цього відключення. Засвіти кілька вікон — і повертайся.
      </p>
    );
  } else {
    const max = Math.max(v.minStake, v.available);
    const value = Math.min(Math.max(stake, v.minStake), max);
    body = (
      <>
        <label className="g-stake">
          <span>
            Беру фішок: <b>{value}</b>
            <Bolt size={12} />{" "}
            <span className="g-muted">
              з {v.available} · блайнди {p?.blinds.small}/{p?.blinds.big}
            </span>
          </span>
          <input
            type="range"
            aria-label="Скільки фішок узяти"
            min={v.minStake}
            max={max}
            step={1}
            value={value}
            onChange={(e) => setStake(Number(e.target.value))}
          />
        </label>
        <button type="button" className="g-play" onClick={() => run(() => api.join(door, value))}>
          {v.seats.length >= 6 ? "Стати в чергу" : "Сісти за стіл"}
        </button>
      </>
    );
  }
  return (
    <section className="card g-pact">
      {error && <p className="g-warn">{error}</p>}
      {body}
    </section>
  );
}
