/**
 * «Блекаут» behind a door: the oval table with the players round it; in the middle the draw pile,
 * the card played last, how many blackouts lie in the pile and the odds of drawing one, and what
 * just happened. Under the table: an action waiting out the window to cancel it (and «Скасувати!»
 * for one who can), the blackout to tuck back after a generator saved you, the top cards one saw,
 * my hand — a tap tells what a card does, then «Зіграти» — and «Взяти карту».
 */
import { useRef, useState } from "react";
import type { EveningMove } from "./api.ts";
import { CardFace, clock, PLACES, tableLayout, useSize } from "./cards.tsx";
import { Bolt, playerName } from "./Rating.tsx";
import { FanSeat, Hand, MePlate, type RoundScreenProps, RoundSeating, ringOf } from "./round.tsx";

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
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(box);
  // a card tapped in my hand: what it does, and «Зіграти» when it may be played
  const [picked, setPicked] = useState<string | null>(null);
  const bo = v.blackout;
  if (!bo) return null;
  const g = bo.game;
  const me = v.me.id;
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
    <>
      <div
        ref={box}
        className="g-felt-box"
        data-game="blackout"
        data-compact={L.compact || undefined}
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
        <div className="g-felt-middle" style={{ top: L.middle }}>
          {g ? (
            <>
              <span className="g-piles">
                <span className="g-stock-back" role="img" aria-label={`У колоді ${g.deck}`}>
                  <CardFace size="board" />
                  <span className="g-count">{g.deck}</span>
                </span>
                <span
                  role="img"
                  aria-label={
                    g.discard.length
                      ? `Остання: ${cardName(g.discard[g.discard.length - 1] ?? "")}`
                      : "Скинутих немає"
                  }
                >
                  {g.discard.length ? (
                    <BlackoutCard card={g.discard[g.discard.length - 1]} size="board" />
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
                  {/* one's own action: only to undo another's «Скасувати» */}
                  {legal?.nope && (g.pending.by !== me || g.pending.nopes % 2 === 1) && (
                    <button type="button" className="g-nope" onClick={() => move({ type: "nope" })}>
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
                    playable={(c) => Boolean(legal?.play.includes(c as never))}
                    picked={sel}
                    label={cardName}
                    face={(c) => <BlackoutCard card={c} size="hand" />}
                    onTap={(c) => setPicked(sel === c ? null : c)}
                    tapAll
                  />
                  {sel ? (
                    <div className="g-card-info">
                      <p>
                        <b>{cardName(sel)}</b> — {CARDS[sel]?.about}
                      </p>
                      {legal?.play.includes(sel as never) ? (
                        sel === "ST" ? (
                          <div className="g-targets">
                            {legal.targets.map((id) => (
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
                              ? "Грається, коли хтось зіграє дію: з'явиться кнопка «Скасувати!»"
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
                            ? `Твій хід${g.turns > 1 ? " (двічі)" : ""}: зіграй карту або бери з колоди`
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
                          <button
                            type="button"
                            className="g-btn"
                            onClick={() => run(() => api.stand(door))}
                          >
                            Здатися
                          </button>
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
    </>
  );
}
