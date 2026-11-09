/**
 * «Дурень» behind a door: the oval table with the players round it, the bout on the felt (attack
 * cards, the defence over them), the stock with its trump; under the table my hand and my moves —
 * or how it stands, or the stake to sit down with.
 */
import { useRef, useState } from "react";
import type { EveningMove, EveningTableView } from "./api.ts";
import { CardFace, clock, PLACES, SUITS, tableLayout, useSize } from "./cards.tsx";
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

export function DurakScreen({ v, api, door, run, left, error }: RoundScreenProps) {
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(box);
  // the defender's card picked to put on one of several attack cards it beats
  const [pick, setPick] = useState<{ key: string; card: string } | null>(null);
  const d = v.durak;
  if (!d) return null;
  const g = d.game;
  const me = v.me.id;
  const name = (id: number | undefined) => (id === undefined ? "" : playerName(v.players[id]));
  const done = g?.phase === "done";
  const boutKey = g ? `${g.bout}:${g.table.map((p) => p.defense ?? "-").join()}` : "";
  const picked = pick?.key === boutKey ? pick.card : null;
  const move = (m: EveningMove) => {
    setPick(null);
    run(() => api.move(door, m));
  };

  const ring = ringOf(g ? g.players.map((p) => p.id) : v.seats.map((s) => s.id), me);
  const places = PLACES[ring.length] ?? [];
  const L = tableLayout(w, h);
  const attackerId = g?.players[g.attacker]?.id;
  const defenderId = g?.players[g.defender]?.id;
  const turnId = g ? whoMoves(g) : undefined;
  const mine = g?.players.find((p) => p.id === me);
  const legal = g?.legal ?? null;
  const beatOf = (card: string) => legal?.beat.find((b) => b.card === card)?.targets ?? [];
  const targets = picked ? beatOf(picked) : [];

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
  const tap = (c: string) => {
    if (legal?.throw.includes(c)) return move({ type: "throw", card: c });
    const t = beatOf(c);
    if (t.length === 1) return move({ type: "beat", card: c, target: t[0] as number });
    if (t.length > 1) setPick(picked === c ? null : { key: boutKey, card: c });
  };

  return (
    <>
      <div ref={box} className="g-felt-box" data-game="durak" data-compact={L.compact || undefined}>
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
        <div className="g-felt-middle" style={{ top: L.middle }}>
          {g ? (
            <>
              <span
                className="g-stock"
                role="img"
                aria-label={`Козир ${cardLabel(g.trump)}, у колоді ${g.deck}, бито ${g.discard}`}
              >
                {g.deck > 0 ? (
                  <>
                    <span className="g-stock-back">
                      <CardFace size="board" />
                      <span className="g-count">{g.deck}</span>
                    </span>
                    <span className="g-stock-trump">
                      <CardFace card={g.trump} size="board" />
                    </span>
                  </>
                ) : (
                  <span
                    className="g-trump-suit"
                    data-red={/[hd]/.test(g.trump[1] ?? "") || undefined}
                  >
                    {SUITS[g.trump[1] ?? ""]}
                  </span>
                )}
                <span className="g-stock-text">
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
                      // biome-ignore lint/suspicious/noArrayIndexKey: a bout's pairs only grow
                      key={i}
                      type="button"
                      className="g-pair"
                      data-target={target || undefined}
                      disabled={!target}
                      aria-label={`${cardLabel(p.attack)}${p.defense ? ` побито ${cardLabel(p.defense)}` : ""}`}
                      onClick={() => picked && move({ type: "beat", card: picked, target: i })}
                    >
                      <CardFace card={p.attack} size="board" />
                      {p.defense && <CardFace card={p.defense} size="board" />}
                    </button>
                  );
                })}
              </span>
              <span className="g-pot">{boutLine}</span>
            </>
          ) : (
            <span className="g-felt-text">
              {ring.length < 2
                ? "Чекаємо гравців: гра почнеться, коли за столом буде двоє"
                : `Гра почнеться${left !== null ? ` за ${clock(left)}` : " ось-ось"} — ще можна сісти`}
              <small>
                Підкидний на 2–6 гравців. Хто лишиться з картами, той дурень: платить решті зі своєї
                ставки, кожному не більше, ніж той поставив сам
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
              />
            )}
            <div className="g-wait">
              <p>
                {picked
                  ? "Тепер торкнися карти на столі, яку б'єш"
                  : legal?.take
                    ? "Відбивайся або бери"
                    : legal?.done
                      ? `Підкинь ще або тисни «${g.took ? "Готово" : "Бито"}»`
                      : turnId === me && g.table.length === 0
                        ? "Твій хід: поклади карту"
                        : g.hand.some(playable)
                          ? "Можна підкинути"
                          : `Хід: ${name(turnId)}`}
              </p>
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
                <button type="button" className="g-btn" onClick={() => run(() => api.stand(door))}>
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
    </>
  );
}
