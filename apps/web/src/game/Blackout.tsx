/**
 * «Блекаут» behind a door: the oval table with the players round it; in the middle the draw pile,
 * the card played last, how many blackouts lie in the pile and the odds of drawing one, and what
 * just happened. Under the table: an action waiting out the window to cancel it (and «Скасувати!»
 * for one who can), the blackout to tuck back after a generator saved you, the top cards one saw,
 * my hand — a card drawn up out of it onto the table is played («Вкрасти»: onto the one to rob), a
 * tap tells what it does, then «Зіграти» — and «Взяти карту». Cards fly: one played from whoever
 * played it onto the pile, one drawn from the stock to the hand, one stolen from hand to hand, a
 * blackout tucked from the hand back into the stock.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { EveningMove } from "./api.ts";
import { CardFace, clock, PLACES, tableLayout, useSize } from "./cards.tsx";
import {
  type Counted,
  counted,
  droppedAt,
  FlyIn,
  flyBacks,
  flyDraws,
  MotionContext,
  type Spot,
  useMotion,
} from "./motion.tsx";
import { Bolt, playerName } from "./Rating.tsx";
import {
  FanSeat,
  GiveUp,
  Hand,
  MePlate,
  type RoundScreenProps,
  RoundSeating,
  ringOf,
  Watchers,
} from "./round.tsx";

/** Each card: its name, what it does, its mark and its colour. */
const CARDS: Record<string, { name: string; about: string; mark: string; tone: string }> = {
  BL: {
    name: "Блекаут",
    about: "Витягнеш без генератора — вибуваєш із гри",
    mark: "✕",
    tone: "danger",
  },
  GN: {
    name: "Генератор",
    about: "Рятує, коли витягнеш блекаут: тоді сам ховаєш його назад у колоду, куди захочеш",
    mark: "",
    tone: "light",
  },
  PK: {
    name: "Глянути графік",
    about: "Подивитися три верхні карти колоди — побачиш тільки ти",
    mark: "◉",
    tone: "cool",
  },
  SH: { name: "Перемішати", about: "Перемішати колоду", mark: "⟳", tone: "cool" },
  SK: {
    name: "Пропустити",
    about: "Закінчити хід, не беручи карти",
    mark: "»",
    tone: "green",
  },
  AT: {
    name: "Перекинути",
    about: "Закінчити хід, не беручи карти; наступний ходить двічі",
    mark: "×2",
    tone: "warn",
  },
  ST: {
    name: "Вкрасти",
    about: "Забрати випадкову карту в гравця, якого обереш",
    mark: "⇠",
    tone: "purple",
  },
  NO: {
    name: "Скасувати",
    about: "Скасувати чужу дію, поки вона не спрацювала (або чуже скасування)",
    mark: "⊘",
    tone: "danger",
  },
};
const cardName = (card: string) => CARDS[card]?.name ?? card;

/** A card of «Блекаут»: its name on a band of its colour, its mark below. */
export function BlackoutCard({
  card,
  size,
}: {
  card?: string | null;
  size: "mini" | "board" | "hand";
}) {
  if (!card) return <CardFace size={size === "hand" ? "big" : size} />;
  const c = CARDS[card];
  return (
    <span className="g-bcard" data-size={size} data-tone={c?.tone}>
      <span className="g-bcard-name">{c?.name}</span>
      <span className="g-bcard-mark">{card === "GN" ? <Bolt size={20} /> : c?.mark}</span>
    </span>
  );
}

/** Where a defused blackout may go back: top, second, third, the middle, the bottom, at random. */
const TUCK = (deck: number) => [
  { at: 0, label: "Зверху" },
  { at: Math.min(1, deck), label: "Другою" },
  { at: Math.min(2, deck), label: "Третьою" },
  { at: Math.floor(deck / 2), label: "Посередині" },
  { at: deck, label: "На дно" },
  { at: -1, label: "Навмання" },
];

export function BlackoutScreen({ v, api, door, run, left, error }: RoundScreenProps) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(box);
  // a card tapped in my hand: what it does, and «Зіграти» when it may be played
  const [picked, setPicked] = useState<string | null>(null);
  // the card my finger carries
  const [lift, setLift] = useState<string | null>(null);
  const bo = v.blackout;
  const g = bo?.game ?? null;
  const me = v.me.id;
  const m = useMotion(root, me, Boolean(bo));
  // what the last view showed: the cards each held, the stock, the pile
  const seen = useRef<{ counts: Counted | null; discard: number } | null>(null);
  const was = seen.current;
  // who played the card new on the pile: whoever holds one less than before (or the last to act)
  const player =
    (g && was?.counts
      ? g.players.find((p) => p.cards < (was.counts?.cards.get(p.id) ?? 0))?.id
      : undefined) ?? g?.last?.id;
  useLayoutEffect(() => {
    const prev = seen.current;
    const now = g ? counted(g) : null;
    if (prev && now && g) {
      const before = prev.counts;
      if (!before || now.deck < before.deck) {
        // dealt, or drawn: a blackout drawn and saved leaves the hand as it was
        const any = [...now.cards].some(([id, n]) => n > (before?.cards.get(id) ?? 0));
        if (any || !before) flyDraws(m, before, now);
        else if (g.last) flyBacks(m, "stock", `pid:${g.last.id}`, before.deck - now.deck);
      } else if (now.deck > before.deck && g.last?.kind === "tuck")
        flyBacks(m, `pid:${g.last.id}`, "stock", 1);
      else if (now.deck === before.deck && g.discard.length === prev.discard) {
        // stolen: one has a card more, another one less
        const gain = [...now.cards].find(([id, n]) => n > (before.cards.get(id) ?? n));
        const loss = [...now.cards].find(([id, n]) => n < (before.cards.get(id) ?? n));
        if (gain && loss) flyBacks(m, `pid:${loss[0]}`, `pid:${gain[0]}`, 1);
      }
    }
    seen.current = { counts: now, discard: g?.discard.length ?? 0 };
  });

  if (!bo) return null;
  const name = (id: number | null | undefined) =>
    id === null || id === undefined ? "" : id === me ? "ти" : playerName(v.players[id]);
  const whoCap = (id: number | null | undefined) => {
    const n = name(id);
    return n === "ти" ? "Ти" : n;
  };
  const done = g?.phase === "done";
  const move = (m: EveningMove) => {
    setPicked(null);
    run(() => api.move(door, m));
  };

  const ring = ringOf(g ? g.players.map((p) => p.id) : v.seats.map((s) => s.id), me);
  const places = PLACES[ring.length] ?? [];
  const L = tableLayout(w, h);
  const turnId = g && !done ? g.players[g.turn]?.id : undefined;
  const mine = g?.players.find((p) => p.id === me);
  const legal = g?.legal ?? null;
  const myTurn = turnId === me;
  const hand: string[] = g?.hand ?? [];
  const sel = picked && hand.includes(picked) ? picked : null;
  // «Скасувати» may be played on another's action (one's own: only to undo another's «Скасувати»)
  const canNope = Boolean(
    legal?.nope && g?.pending && (g.pending.by !== me || g.pending.nopes % 2 === 1),
  );
  const canPlay = (c: string) => Boolean(legal?.play.includes(c as never));
  const playable = (c: string) => canPlay(c) || (c === "NO" && canNope);
  const drop = (c: string, target: string | null, at: Spot) => {
    if (!target) return;
    if (c === "NO" && canNope && !canPlay(c)) {
      droppedAt(m, c, at);
      return move({ type: "nope" });
    }
    if (!canPlay(c)) return;
    if (c === "ST") {
      const ts = legal?.targets ?? [];
      const id = target.startsWith("seat:")
        ? Number(target.slice(5))
        : ts.length === 1
          ? ts[0]
          : undefined;
      // whom to rob, the finger did not say: the card's panel asks
      if (id === undefined || !ts.includes(id)) return setPicked("ST");
      droppedAt(m, c, at);
      return move({ type: "play", card: "ST", target: id });
    }
    droppedAt(m, c, at);
    move({ type: "play", card: c });
  };

  const roleOf = (id: number): string | null => {
    if (!g) return null;
    const p = g.players.find((x) => x.id === id);
    if (done) return g.winner === id ? "перемога" : null;
    if (p?.out) return "вибув";
    const you = id === me;
    if (id === turnId)
      return g.defusing
        ? you
          ? "ховаєш блекаут"
          : "ховає блекаут"
        : `${you ? "ходиш" : "ходить"}${g.turns > 1 ? " ×2" : ""}`;
    return null;
  };

  /** What happened last, in words: «Катя бере карту», «Ти береш карту». */
  const lastLine = (() => {
    const l = g?.last;
    if (!g || !l) return null;
    const does = (they: string, you: string) =>
      l.id === me ? `Ти ${you}` : `${playerName(v.players[l.id])} ${they}`;
    const who = whoCap(l.id);
    const card = l.card ? `«${cardName(l.card)}»` : "";
    const to = l.target !== null ? ` → ${name(l.target)}` : "";
    switch (l.kind) {
      case "play":
        return `${who}: ${card}${to}`;
      case "nope":
        return `${who}: «Скасувати»!`;
      case "cancelled":
        return `${card} скасовано`;
      case "steal":
        return `${does("краде карту", "крадеш карту")}${to}`;
      case "done":
        return l.card === "PK"
          ? does("дивиться верх колоди", "дивишся верх колоди")
          : l.card === "SH"
            ? "Колоду перемішано"
            : l.card === "SK"
              ? does("пропускає хід", "пропускаєш хід")
              : l.card === "AT"
                ? `Хід перекинуто: ${turnId === me ? "ти ходиш" : `${name(turnId)} ходить`} двічі`
                : `${card} спрацювала`;
      case "draw":
        return does("бере карту", "береш карту");
      case "defuse":
        return `${who}: блекаут! Генератор рятує`;
      case "tuck":
        return does("ховає блекаут назад у колоду", "ховаєш блекаут назад у колоду");
      case "out":
        return `${does("вибуває", "вибуваєш")} — блекаут!`;
      default:
        return null;
    }
  })();

  const odds = g && g.deck > 0 ? Math.round((g.blackouts / g.deck) * 100) : 0;

  return (
    <MotionContext.Provider value={m}>
      <div ref={root} className="g-round">
        <div
          ref={box}
          className="g-felt-box"
          data-game="blackout"
          data-compact={L.compact || undefined}
          data-drop={myTurn || canNope ? "table" : undefined}
          data-lifting={lift !== null || undefined}
        >
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
          <div className="g-felt-middle" style={{ top: L.column }}>
            {g ? (
              <>
                <span className="g-piles">
                  <span
                    className="g-stock-back"
                    data-anchor="stock"
                    role="img"
                    aria-label={`У колоді ${g.deck}`}
                  >
                    <CardFace size="board" />
                    <span className="g-count">{g.deck}</span>
                  </span>
                  <span
                    className="g-discard"
                    data-anchor="discard"
                    role="img"
                    aria-label={
                      g.discard.length
                        ? `Остання: ${cardName(g.discard[g.discard.length - 1] ?? "")}`
                        : "Скинутих немає"
                    }
                  >
                    {g.discard.length > 1 && (
                      <span className="g-discard-under">
                        <BlackoutCard card={g.discard[g.discard.length - 2]} size="board" />
                      </span>
                    )}
                    {g.discard.length ? (
                      <FlyIn
                        key={g.discard.length}
                        from={player === undefined ? null : `pid:${player}`}
                        card={g.discard[g.discard.length - 1]}
                      >
                        <BlackoutCard card={g.discard[g.discard.length - 1]} size="board" />
                      </FlyIn>
                    ) : (
                      <span className="g-card-slot" />
                    )}
                  </span>
                </span>
                <span className="g-danger" data-high={odds >= 25 || undefined}>
                  <span className="g-danger-bar">
                    <span className="g-danger-fill" style={{ width: `${Math.min(100, odds)}%` }} />
                  </span>
                  блекаутів у колоді: {g.blackouts} · шанс {odds}%
                </span>
                <span className="g-pot">{done ? `Перемога: ${whoCap(g.winner)}` : lastLine}</span>
              </>
            ) : (
              <span className="g-felt-text">
                {ring.length < 2
                  ? "Чекаємо гравців: гра почнеться, коли за столом буде двоє"
                  : `Гра почнеться${left !== null ? ` за ${clock(left)}` : " ось-ось"} — ще можна сісти`}
                <small>
                  По черзі береш карту з колоди. Витягнув «Блекаут» без «Генератора» — вибув. Карти
                  дій допомагають його оминути. Хто лишиться останнім, той виграв
                </small>
              </span>
            )}
          </div>
          {ring.map((id, i) => {
            const p = g?.players.find((x) => x.id === id);
            const net = done ? (bo.pay?.[String(id)] ?? 0) : 0;
            const flags = { turn: id === turnId, win: done && g?.winner === id, out: p?.out };
            return id === me ? (
              <MePlate
                key={id}
                id={id}
                cards={p && !p.out && !done ? p.cards : null}
                role={roleOf(id)}
                net={net}
                {...flags}
              />
            ) : (
              <FanSeat
                key={id}
                v={v}
                id={id}
                at={L.places[places[i] ?? 0] ?? { x: 0, y: 0 }}
                cards={p?.cards ?? 0}
                role={roleOf(id)}
                net={net}
                compact={L.compact}
                drop={lift === "ST" && legal?.targets.includes(id) ? `seat:${id}` : undefined}
                {...flags}
              />
            );
          })}
        </div>

        <section className="card g-pact">
          {error && <p className="g-warn">{error}</p>}
          {g && mine && !done ? (
            mine.out ? (
              <p className="g-wait-line">Ти вибув. Чекаємо, хто лишиться останнім</p>
            ) : (
              <>
                {g.pending && (
                  <div className="g-pending" data-nope={legal?.nope || undefined}>
                    <BlackoutCard card={g.pending.card} size="mini" />
                    <span className="g-pending-text">
                      <b>
                        {whoCap(g.pending.by)}: «{cardName(g.pending.card)}»
                        {g.pending.target !== null && ` → ${name(g.pending.target)}`}
                      </b>
                      <small>
                        {g.pending.nopes % 2 === 1 ? "скасовано… " : ""}
                        спрацює за {left ?? 0} с, якщо ніхто не скасує
                      </small>
                    </span>
                    {canNope && (
                      <button
                        type="button"
                        className="g-nope"
                        onClick={() => move({ type: "nope" })}
                      >
                        Скасувати!
                      </button>
                    )}
                  </div>
                )}
                {g.peek && (
                  <div className="g-peek">
                    <small>Верх колоди (бачиш тільки ти):</small>
                    <span className="g-peek-row">
                      {g.peek.map((c, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: the order is the point
                        <span key={i} className="g-peek-card">
                          <i>{i + 1}</i>
                          <BlackoutCard card={c} size="board" />
                        </span>
                      ))}
                    </span>
                  </div>
                )}
                {legal?.tuck ? (
                  <div className="g-tuck">
                    <p>
                      <b className="g-tuck-title">Генератор врятував!</b> Куди сховати блекаут? Інші
                      не бачать
                    </p>
                    <div className="g-tuck-grid">
                      {TUCK(g.deck).map((t) => (
                        <button
                          key={t.label}
                          type="button"
                          className="g-btn"
                          onClick={() => move({ type: "tuck", at: t.at })}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <>
                    <Hand
                      cards={hand}
                      width={Math.max(200, w - 52)}
                      size={56}
                      playable={playable}
                      picked={sel}
                      label={cardName}
                      face={(c) => <BlackoutCard card={c} size="hand" />}
                      onTap={(c) => setPicked(sel === c ? null : c)}
                      onDrop={drop}
                      onLift={setLift}
                    />
                    {sel ? (
                      <div className="g-card-info">
                        <p>
                          <b>{cardName(sel)}</b> — {CARDS[sel]?.about}
                        </p>
                        {canPlay(sel) ? (
                          sel === "ST" ? (
                            <div className="g-targets">
                              {(legal?.targets ?? []).map((id) => (
                                <button
                                  key={id}
                                  type="button"
                                  className="g-btn"
                                  onClick={() => move({ type: "play", card: "ST", target: id })}
                                >
                                  Вкрасти: {playerName(v.players[id])}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="g-play"
                              onClick={() => move({ type: "play", card: sel })}
                            >
                              Зіграти «{cardName(sel)}»
                            </button>
                          )
                        ) : (
                          <p className="g-muted">
                            {sel === "GN"
                              ? "Спрацює сам, коли витягнеш блекаут"
                              : sel === "NO"
                                ? canNope
                                  ? "Тягни її на стіл або тисни «Скасувати!» вище"
                                  : "Грається, коли хтось зіграє дію: тоді тягни її на стіл"
                                : "Зараз зіграти не можна"}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="g-wait">
                        <p>
                          {g.pending
                            ? "Чекаємо, чи хтось скасує…"
                            : myTurn
                              ? `Твій хід${g.turns > 1 ? " (двічі)" : ""}: тягни карту на стіл або бери з колоди`
                              : `Хід: ${whoCap(turnId)}`}
                        </p>
                        {legal?.draw ? (
                          <button
                            type="button"
                            className="g-play"
                            onClick={() => move({ type: "draw" })}
                          >
                            Взяти карту
                          </button>
                        ) : (
                          !myTurn && (
                            <GiveUp
                              cost={
                                <>
                                  Ти вийдеш із гри, а переможець забере до{" "}
                                  {v.seats.find((s) => s.id === me)?.stake ?? 0}
                                  <Bolt size={12} /> твоєї ставки
                                </>
                              }
                              onYes={() => run(() => api.stand(door))}
                            />
                          )
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )
          ) : g && done ? (
            <p className="g-result-text">
              {!mine
                ? `Перемога: ${whoCap(g.winner)}`
                : g.winner === me
                  ? `Перемога за тобою: +${bo.pay?.[String(me)] ?? 0}`
                  : `Ця гра: −${-(bo.pay?.[String(me)] ?? 0)}`}
              {mine && <Bolt size={14} />}
            </p>
          ) : g?.pending ? (
            <p className="g-wait-line">
              {whoCap(g.pending.by)}: «{cardName(g.pending.card)}» — спрацює за {left ?? 0} с
            </p>
          ) : (
            <RoundSeating v={v} api={api} door={door} run={run} left={left} />
          )}
        </section>
      </div>
    </MotionContext.Provider>
  );
}
