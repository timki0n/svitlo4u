/**
 * «Кольори» behind a door: the oval table with the players round it, the draw pile and the top of
 * the discard pile in the middle, the colour to follow and which way the turn goes; under the table
 * my hand — a card is drawn up out of it onto the table (a wild then asks for its colour) — and my
 * moves, or how it stands, or the stake to sit with. A card played flies from whoever played it onto
 * the pile; those drawn fly from the stock to each hand.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { EveningMove } from "./api.ts";
import { CardFace, clock, placesOf, tableLayout, useSize } from "./cards.tsx";
import {
  type Counted,
  counted,
  droppedAt,
  FlyIn,
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

const COLOR_NAMES: Record<string, string> = {
  r: "червоний",
  y: "жовтий",
  g: "зелений",
  b: "синій",
};
const PICK: { code: "r" | "y" | "g" | "b"; label: string }[] = [
  { code: "r", label: "Червоний" },
  { code: "y", label: "Жовтий" },
  { code: "g", label: "Зелений" },
  { code: "b", label: "Синій" },
];

/** A card's mark: its number, ⊘ skip, ⇄ reverse, +2; a wild shows +4 or nothing. */
const glyph = (card: string) => {
  if (card === "W4") return "+4";
  if (card === "WW") return "";
  const value = card[1] ?? "";
  return value === "S" ? "⊘" : value === "R" ? "⇄" : value === "D" ? "+2" : value;
};

/** A card in words, for a screen reader. */
const cardLabel = (card: string) => {
  if (card === "WW") return "зміна кольору";
  if (card === "W4") return "+4 і зміна кольору";
  const value = card[1] ?? "";
  const what =
    value === "S" ? "пропуск" : value === "R" ? "розворот" : value === "D" ? "+2" : value;
  return `${COLOR_NAMES[card[0] ?? ""] ?? ""} ${what}`;
};

/** A card of «Кольори»: dark, its colour round the edge and in its mark; a wild — all four. */
export function ColorCard({ card, size }: { card?: string; size: "mini" | "board" | "big" }) {
  if (!card) return <CardFace size={size} />;
  const wild = card[0] === "W";
  return (
    <span className="g-ccard" data-size={size} data-c={wild ? "w" : card[0]}>
      <span className="g-ccard-mark">{glyph(card)}</span>
    </span>
  );
}

export function ColorsScreen({ v, api, door, run, left, error }: RoundScreenProps) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(box);
  // a card picked (a tap): a second tap plays it; a wild asks for its colour first
  const [pick, setPick] = useState<{ key: string; card: string } | null>(null);
  const [lift, setLift] = useState<string | null>(null);
  const c = v.colors;
  const g = c?.game ?? null;
  const me = v.me.id;
  const m = useMotion(root, me, Boolean(c));
  // what the last view showed: the cards each held, the pile's top and the one under it
  const seen = useRef<{
    counts: Counted | null;
    played: number;
    top: string;
    under: string | null;
  } | null>(null);
  const was = seen.current;
  const under = g && was ? (was.played !== g.played ? was.top || null : was.under) : null;
  useLayoutEffect(() => {
    const prev = seen.current;
    const now = g ? counted(g) : null;
    if (prev && now) flyDraws(m, prev.counts, now);
    seen.current = { counts: now, played: g?.played ?? 0, top: g?.top ?? "", under };
  });

  if (!c) return null;
  const name = (id: number | undefined) => (id === undefined ? "" : playerName(v.players[id]));
  const done = g?.phase === "done";
  const moveKey = g ? `${g.played}:${g.turn}:${g.drawn ?? ""}` : "";
  const picked = pick?.key === moveKey ? pick.card : null;
  const picking = picked?.[0] === "W" ? picked : null;
  const move = (mv: EveningMove) => {
    setPick(null);
    run(() => api.move(door, mv));
  };

  const ring = ringOf(g ? g.players.map((p) => p.id) : v.seats.map((s) => s.id), me);
  const places = placesOf(ring.length, ring[0] === me);
  const L = tableLayout(w, h);
  const turnId = g && !done ? g.players[g.turn]?.id : undefined;
  const mine = g?.players.find((p) => p.id === me);
  const legal = g?.legal ?? null;
  const playable = (card: string) => Boolean(legal?.play.includes(card));

  const roleOf = (id: number): string | null => {
    if (!g) return null;
    const p = g.players.find((x) => x.id === id);
    if (done) return g.winner === id ? "перемога" : null;
    if (p?.out) return "вийшов";
    if (p?.cards === 1) return "одна!";
    if (id === turnId) return id === me ? "ходиш" : "ходить";
    return null;
  };

  const last = g?.last;
  const lastLine = !last ? null : last.card ? (
    <>
      {last.id === me ? "Ти" : name(last.id)}: <ColorCard card={last.card} size="mini" />
      {last.penalty &&
        ` → ${last.penalty.id === me ? "тобі" : name(last.penalty.id)} +${last.penalty.cards}`}
    </>
  ) : last.drew ? (
    last.id === me ? (
      "Ти береш карту"
    ) : (
      `${name(last.id)} бере карту`
    )
  ) : (
    `${last.id === me ? "Ти" : name(last.id)}: пас`
  );

  const tap = (card: string) => {
    if (!playable(card)) return;
    if (picked !== card) return setPick({ key: moveKey, card });
    if (card[0] === "W") setPick(null);
    else move({ type: "play", card });
  };
  const drop = (card: string, target: string | null, at: Spot) => {
    if (!target || !playable(card)) return;
    droppedAt(m, card, at);
    if (card[0] === "W") setPick({ key: moveKey, card });
    else move({ type: "play", card });
  };

  return (
    <MotionContext.Provider value={m}>
      <div ref={root} className="g-round">
        <div
          ref={box}
          className="g-felt-box"
          data-game="colors"
          data-compact={L.compact || undefined}
          data-drop={turnId === me ? "table" : undefined}
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
                    aria-label={`Зверху: ${cardLabel(g.top)}`}
                  >
                    {under && (
                      <span className="g-discard-under">
                        <ColorCard card={under} size="big" />
                      </span>
                    )}
                    <FlyIn key={g.played} from={last?.card ? `pid:${last.id}` : null} card={g.top}>
                      <ColorCard card={g.top} size="big" />
                    </FlyIn>
                  </span>
                  <span
                    className="g-follow"
                    role="img"
                    aria-label={`Колір: ${COLOR_NAMES[g.color] ?? ""}, ${g.direction === 1 ? "за годинниковою" : "проти годинникової"}`}
                  >
                    <span className="g-follow-dot" data-c={g.color} />
                    <span className="g-follow-way">{g.direction === 1 ? "↻" : "↺"}</span>
                  </span>
                </span>
                <span className="g-pot">
                  {done
                    ? g.winner === null
                      ? "Гру завершено"
                      : `Перемога: ${g.winner === me ? "твоя" : name(g.winner)}`
                    : lastLine}
                </span>
                {!done && (
                  <span className="g-pot">
                    {turnId === me ? "Твій хід" : `Хід: ${name(turnId)}`}
                  </span>
                )}
              </>
            ) : (
              <span className="g-felt-text">
                {ring.length < 2
                  ? "Чекаємо гравців: гра почнеться, коли за столом буде двоє"
                  : `Гра почнеться${left !== null ? ` за ${clock(left)}` : " ось-ось"} — ще можна сісти`}
                <small>
                  Клади карту того ж кольору чи значення. Хто першим скине всі карти, той виграв:
                  бере від кожного не більше, ніж поставив сам
                </small>
              </span>
            )}
          </div>
          {ring.map((id, i) => {
            const p = g?.players.find((x) => x.id === id);
            const net = done ? (c.pay?.[String(id)] ?? 0) : 0;
            const flags = { turn: id === turnId, win: done && g?.winner === id };
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
                {...flags}
              />
            );
          })}
        </div>

        <section className="card g-pact">
          {error && <p className="g-warn">{error}</p>}
          {g && mine && !done ? (
            mine.out ? (
              <p className="g-wait-line">Ти вийшов із гри. Чекаємо, хто переможе</p>
            ) : (
              <>
                <Hand
                  cards={g.hand}
                  width={Math.max(200, w - 52)}
                  playable={playable}
                  picked={picked}
                  label={cardLabel}
                  face={(card) => <ColorCard card={card} size="big" />}
                  onTap={tap}
                  onDrop={drop}
                  onLift={setLift}
                />
                {picking ? (
                  <div className="g-pick-color">
                    {PICK.map((p) => (
                      <button
                        key={p.code}
                        type="button"
                        className="g-color-btn"
                        data-c={p.code}
                        onClick={() => move({ type: "play", card: picking, color: p.code })}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="g-wait">
                    <p>
                      {turnId !== me
                        ? `Хід: ${name(turnId)}`
                        : picked
                          ? "Перетягни карту на стіл або торкнись її ще раз"
                          : legal?.pass
                            ? "Зіграй взяту карту або пасуй"
                            : g.hand.some(playable)
                              ? "Твій хід: тягни карту на стіл або бери з колоди"
                              : "Нема чим ходити: бери з колоди"}
                    </p>
                    {legal?.draw && (
                      <button
                        type="button"
                        className="g-btn"
                        onClick={() => move({ type: "draw" })}
                      >
                        Взяти карту
                      </button>
                    )}
                    {legal?.pass && (
                      <button
                        type="button"
                        className="g-btn"
                        onClick={() => move({ type: "pass" })}
                      >
                        Пас
                      </button>
                    )}
                    {turnId !== me && (
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
                    )}
                  </div>
                )}
              </>
            )
          ) : g && done ? (
            <p className="g-result-text">
              {!mine
                ? g.winner === null
                  ? "Гру завершено"
                  : `Перемога: ${name(g.winner)}`
                : g.winner === me
                  ? `Перемога за тобою: +${c.pay?.[String(me)] ?? 0}`
                  : `Ця гра: −${-(c.pay?.[String(me)] ?? 0)}`}
              {mine && <Bolt size={14} />}
            </p>
          ) : (
            <RoundSeating v={v} api={api} door={door} run={run} left={left} />
          )}
        </section>
      </div>
    </MotionContext.Provider>
  );
}
