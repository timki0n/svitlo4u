/**
 * «Дурень» behind a door: the oval table with the players round it; on the felt the stock (its
 * trump under it, «бито») beside the bout — attack cards, the defence over them; under the table my
 * hand: a card is drawn up out of it onto the table (onto the card it beats), and my moves — or how
 * it stands, or the stake to sit down with. Cards fly: one put down from whoever put it, a finished
 * bout to the discard or to the one who took it, those drawn from the stock to each hand.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { EveningMove, EveningTableView } from "./api.ts";
import { CardFace, clock, PLACES, SUITS, tableLayout, useSize } from "./cards.tsx";
import {
  type Counted,
  counted,
  droppedAt,
  FlyIn,
  flyDraws,
  MotionContext,
  type Spot,
  useLeaving,
  useMotion,
} from "./motion.tsx";
import { Bolt, playerName } from "./Rating.tsx";
import { FanSeat, Hand, MePlate, type RoundScreenProps, RoundSeating, ringOf } from "./round.tsx";

type Durak = NonNullable<NonNullable<EveningTableView["durak"]>["game"]>;

/** A card in words, for a screen reader: «10♥». */
const cardLabel = (card: string) => `${card[0] === "T" ? "10" : card[0]}${SUITS[card[1] ?? ""]}`;

/** Whose move the clock runs on (as the core counts it). */
function whoMoves(g: Durak): number | undefined {
  if (g.phase === "done") return undefined;
  const unbeaten = g.table.some((p) => p.defense === null);
  const i = g.table.length > 0 && unbeaten && !g.took ? g.defender : g.attacker;
  return g.players[i]?.id;
}

/** What the last view showed, to tell what moved since. */
type Seen = {
  round: string;
  game: boolean;
  discard: number;
  defender: number | undefined;
  /** Cards on the table. */
  table: number;
  counts: Counted;
};

export function DurakScreen({ v, api, door, run, left, error }: RoundScreenProps) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(box);
  // a card picked (a tap): where it may go lights up; a second tap plays it
  const [pick, setPick] = useState<{ key: string; card: string } | null>(null);
  // the card my finger carries
  const [lift, setLift] = useState<string | null>(null);
  // a card let go where it cannot lie
  const [miss, setMiss] = useState<string | null>(null);
  const d = v.durak;
  const g = d?.game ?? null;
  const me = v.me.id;
  const m = useMotion(root, me, Boolean(d));

  const round = g ? `${g.bout}:${g.phase}` : "none";
  const attackerId = g?.players[g.attacker]?.id;
  const defenderId = g?.players[g.defender]?.id;
  const seen = useRef<Seen | null>(null);
  const was = seen.current;
  // the bout just ended: its cards went to «бито», or to the one who took them
  const went =
    g && was?.game && was.round !== round
      ? g.discard > was.discard
        ? "discard"
        : was.defender !== undefined
          ? `pid:${was.defender}`
          : null
      : null;
  // who put down a card new on the table: whoever has one card less than before (the first of a
  // bout: the attacker)
  const thrower =
    (g && was?.game
      ? g.players.find((p) => p.id !== defenderId && p.cards < (was.counts.cards.get(p.id) ?? 0))
          ?.id
      : undefined) ?? attackerId;
  useLeaving(m, round, ".g-bout .g-card", went);
  useLayoutEffect(() => {
    const prev = seen.current;
    const now = g ? counted(g) : null;
    // dealt, or drawn up to six after a bout (the taker's cards apart)
    if (prev && now && (!prev.game || now.deck < prev.counts.deck))
      flyDraws(m, prev.game ? prev.counts : null, now, (id) =>
        went === `pid:${id}` ? prev.table : 0,
      );
    seen.current = {
      round,
      game: Boolean(g),
      discard: g?.discard ?? 0,
      defender: defenderId,
      table: g?.table.reduce((n, p) => n + (p.defense ? 2 : 1), 0) ?? 0,
      counts: now ?? { deck: 0, cards: new Map() },
    };
  });

  if (!d) return null;
  const name = (id: number | undefined) => (id === undefined ? "" : playerName(v.players[id]));
  const done = g?.phase === "done";
  const boutKey = g ? `${g.bout}:${g.table.map((p) => p.defense ?? "-").join()}` : "";
  const picked = pick?.key === boutKey ? pick.card : null;
  const missed = miss === boutKey;
  const move = (mv: EveningMove) => {
    setPick(null);
    setMiss(null);
    run(() => api.move(door, mv));
  };

  const ring = ringOf(g ? g.players.map((p) => p.id) : v.seats.map((s) => s.id), me);
  const places = PLACES[ring.length] ?? [];
  const L = tableLayout(w, h);
  const turnId = g ? whoMoves(g) : undefined;
  const mine = g?.players.find((p) => p.id === me);
  const legal = g?.legal ?? null;
  const beatOf = (card: string) => legal?.beat.find((b) => b.card === card)?.targets ?? [];
  const held = lift ?? picked;
  const targets = held ? beatOf(held) : [];

  const roleOf = (id: number): string | null => {
    if (!g) return null;
    const p = g.players.find((x) => x.id === id);
    if (done) return g.durak === id ? "дурень" : null;
    if (p?.out) return "вийшов";
    const you = id === me;
    if (id === defenderId)
      return g.took ? (you ? "береш" : "бере") : you ? "відбиваєшся" : "відбивається";
    if (id === attackerId) return you ? "ходиш" : "ходить";
    return null;
  };

  const boutLine = !g
    ? null
    : done
      ? g.durak === null
        ? "Нічия: дурня немає"
        : `Дурень: ${g.durak === me ? "ти" : name(g.durak)}`
      : g.took
        ? `${defenderId === me ? "Ти береш" : `${name(defenderId)} бере`} · можна ще підкинути`
        : `${attackerId === me ? "Ти ходиш" : `Ходить ${name(attackerId)}`} · ${
            defenderId === me ? "відбиваєшся ти" : `відбивається ${name(defenderId)}`
          }`;

  const playable = (c: string) => Boolean(legal?.throw.includes(c)) || beatOf(c).length > 0;
  /** The move a card makes where it goes only one way (a throw, or the one card it beats). */
  const only = (c: string): EveningMove | null => {
    if (legal?.throw.includes(c)) return { type: "throw", card: c };
    const t = beatOf(c);
    return t.length === 1 ? { type: "beat", card: c, target: t[0] as number } : null;
  };
  const tap = (c: string) => {
    if (!playable(c)) return;
    if (picked !== c) return setPick({ key: boutKey, card: c });
    const mv = only(c);
    if (mv) move(mv);
  };
  const drop = (c: string, target: string | null, at: Spot) => {
    if (!target) return;
    const i = target.startsWith("pair:") ? Number(target.slice(5)) : -1;
    const mv: EveningMove | null = beatOf(c).includes(i)
      ? { type: "beat", card: c, target: i }
      : only(c);
    if (!mv) {
      // it beats more than one: which, the finger did not say
      setPick({ key: boutKey, card: c });
      setMiss(boutKey);
      return;
    }
    droppedAt(m, c, at);
    move(mv);
  };

  const tip = !g
    ? ""
    : missed || (picked && beatOf(picked).length > 1)
      ? "Поклади карту на ту, яку б'єш"
      : picked
        ? "Перетягни карту на стіл або торкнись її ще раз"
        : legal?.take
          ? g.hand.some((c) => beatOf(c).length > 0)
            ? "Відбивайся: тягни карту на ту, яку б'єш, — або бери"
            : "Нема чим відбитися: бери"
          : legal?.done
            ? `Підкинь ще або тисни «${g.took ? "Готово" : "Бито"}»`
            : turnId === me && g.table.length === 0
              ? "Твій хід: тягни карту на стіл"
              : g.hand.some(playable)
                ? "Можна підкинути: тягни карту на стіл"
                : `Хід: ${name(turnId)}`;

  return (
    <MotionContext.Provider value={m}>
      <div ref={root} className="g-round">
        <div
          ref={box}
          className="g-felt-box"
          data-game="durak"
          data-compact={L.compact || undefined}
          data-drop={g && !done ? "table" : undefined}
          data-lifting={lift !== null || undefined}
        >
          <div className="g-felt" style={L.felt} />
          {v.watchers > 0 && (
            <span className="g-felt-note" data-side="left">
              дивляться: {v.watchers}
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
                <span className="g-durak">
                  <span
                    className="g-stock"
                    data-anchor="stock"
                    role="img"
                    aria-label={`Козир ${cardLabel(g.trump)}, у колоді ${g.deck}, бито ${g.discard}`}
                  >
                    {g.deck > 0 ? (
                      <span className="g-stock-pile">
                        <span className="g-stock-back">
                          <CardFace size="board" />
                          <span className="g-count">{g.deck}</span>
                        </span>
                        <span className="g-stock-trump">
                          <CardFace card={g.trump} size="board" />
                        </span>
                      </span>
                    ) : (
                      <span
                        className="g-trump-suit"
                        data-red={/[hd]/.test(g.trump[1] ?? "") || undefined}
                      >
                        {SUITS[g.trump[1] ?? ""]}
                      </span>
                    )}
                    <span className="g-stock-text" data-anchor="discard">
                      козир
                      <br />
                      бито {g.discard}
                    </span>
                  </span>
                  <span className="g-bout">
                    {g.table.map((p, i) => {
                      const target = targets.includes(i);
                      return (
                        <button
                          // biome-ignore lint/suspicious/noArrayIndexKey: a bout's pairs only grow, a new bout's are new
                          key={`${g.bout}:${i}`}
                          type="button"
                          className="g-pair"
                          data-target={target || undefined}
                          data-drop={target ? `pair:${i}` : undefined}
                          disabled={!target}
                          aria-label={`${cardLabel(p.attack)}${p.defense ? ` побито ${cardLabel(p.defense)}` : ""}`}
                          onClick={() => held && move({ type: "beat", card: held, target: i })}
                        >
                          <FlyIn
                            from={`pid:${i === 0 ? attackerId : thrower}`}
                            card={p.attack}
                            className="g-fly-in g-attack"
                          >
                            <CardFace card={p.attack} size="board" />
                          </FlyIn>
                          {p.defense && (
                            <FlyIn
                              key={p.defense}
                              from={`pid:${defenderId}`}
                              card={p.defense}
                              className="g-fly-in g-defense"
                            >
                              <CardFace card={p.defense} size="board" />
                            </FlyIn>
                          )}
                        </button>
                      );
                    })}
                  </span>
                </span>
                <span className="g-pot">{boutLine}</span>
              </>
            ) : (
              <span className="g-felt-text">
                {ring.length < 2
                  ? "Чекаємо гравців: гра почнеться, коли за столом буде двоє"
                  : `Гра почнеться${left !== null ? ` за ${clock(left)}` : " ось-ось"} — ще можна сісти`}
                <small>
                  Підкидний на 2–6 гравців. Хто лишиться з картами, той дурень: платить решті зі
                  своєї ставки, кожному не більше, ніж той поставив сам
                </small>
              </span>
            )}
          </div>
          {ring.map((id, i) => {
            const p = g?.players.find((x) => x.id === id);
            const net = done ? (d.pay?.[String(id)] ?? 0) : 0;
            const flags = {
              turn: id === turnId,
              win: done && g?.durak !== null && g?.durak !== id,
            };
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
            <>
              {mine.out ? (
                <p className="g-wait-line">Ти вийшов: карти скінчилися. Чекаємо, хто лишиться</p>
              ) : (
                <Hand
                  cards={g.hand}
                  width={Math.max(200, w - 52)}
                  playable={playable}
                  picked={picked}
                  label={cardLabel}
                  face={(c) => <CardFace card={c} size="big" />}
                  onTap={tap}
                  onDrop={drop}
                  onLift={setLift}
                />
              )}
              <div className="g-wait">
                <p>{tip}</p>
                {legal?.take && (
                  <button type="button" className="g-btn" onClick={() => move({ type: "take" })}>
                    Беру
                  </button>
                )}
                {legal?.done && (
                  <button type="button" className="g-play" onClick={() => move({ type: "done" })}>
                    {g.took ? "Готово" : "Бито"}
                  </button>
                )}
                {!legal?.take && !legal?.done && (
                  <button
                    type="button"
                    className="g-btn"
                    onClick={() => run(() => api.stand(door))}
                  >
                    Здатися
                  </button>
                )}
              </div>
            </>
          ) : g && done ? (
            <p className="g-result-text">
              {!mine
                ? boutLine
                : g.durak === null
                  ? "Нічия"
                  : g.durak === me
                    ? `Ти дурень: −${-(d.pay?.[String(me)] ?? 0)}`
                    : `Твій виграш: +${d.pay?.[String(me)] ?? 0}`}
              {mine && g.durak !== null && <Bolt size={14} />}
            </p>
          ) : (
            <RoundSeating v={v} api={api} door={door} run={run} left={left} />
          )}
        </section>
      </div>
    </MotionContext.Provider>
  );
}
