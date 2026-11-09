/**
 * What the round games' screens share («Дурень», «Кольори»): a player round the table with their
 * cards face down, my own plate, my hand of cards, and the card under the table while one is not
 * in a game — sitting down with a stake, waiting for the others, the queue.
 */
import { type ReactNode, useState } from "react";
import type { EveningTableView, gameApi } from "./api.ts";
import { CardFace, clock, Net, type Point } from "./cards.tsx";
import { Avatar, Bolt, playerName } from "./Rating.tsx";

type Api = ReturnType<typeof gameApi>;
export type RoundScreenProps = {
  v: EveningTableView;
  api: Api;
  door: number;
  run: (call: () => Promise<unknown>) => void;
  left: number | null;
  error: string | null;
};

/** «6 карт», «1 карта», «3 карти». */
export const cardsWord = (n: number) => {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return `${n} карт`;
  if (ones === 1) return `${n} карта`;
  if (ones >= 2 && ones <= 4) return `${n} карти`;
  return `${n} карт`;
};

type Flags = { turn?: boolean; win?: boolean; out?: boolean };
const flagsOf = ({ turn, win, out }: Flags) => ({
  "data-turn": turn || undefined,
  "data-win": win || undefined,
  "data-out": out || undefined,
});

/** Someone round the table: their cards face down (how many on them), the face, a plate. */
export function FanSeat({
  v,
  id,
  at,
  cards,
  role,
  net,
  compact,
  ...flags
}: {
  v: EveningTableView;
  id: number;
  at: Point;
  cards: number;
  role: string | null;
  net: number;
  compact: boolean;
} & Flags) {
  return (
    <div className="g-pseat" data-pid={id} style={{ left: at.x, top: at.y }} {...flagsOf(flags)}>
      <span className="g-pseat-cards g-fan">
        {Array.from({ length: Math.min(cards, 5) }, (_, k) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fan of backs
          <CardFace key={k} size="mini" />
        ))}
        {cards > 0 && <span className="g-count">{cards}</span>}
      </span>
      <span className="g-pseat-face">
        <Avatar id={id} player={v.players[id]} size={compact ? 34 : 40} />
      </span>
      <span className="g-pseat-plate">
        <b className="g-pname">{playerName(v.players[id])}</b>
        {role && <span data-role={role}>{role}</span>}
        {net !== 0 && <Net net={net} />}
      </span>
    </div>
  );
}

/** My own plate at the bottom of the table (my cards lie under it, in my hand). */
export function MePlate({
  id,
  cards,
  role,
  net,
  ...flags
}: { id: number; cards: number | null; role: string | null; net: number } & Flags) {
  return (
    <div className="g-pme" data-pid={id} {...flagsOf(flags)}>
      <span className="g-pme-plate">
        <b>Ти</b>
        {cards !== null && <span>{cardsWord(cards)}</span>}
        {role && <span className="g-muted">{role}</span>}
        {net !== 0 && <Net net={net} />}
      </span>
    </div>
  );
}

/** My hand: the cards in a row, overlapping to fit; the ones I may play stand out. */
export function Hand({
  cards,
  width,
  playable,
  picked,
  label,
  face,
  onTap,
  size = 44,
  tapAll = false,
}: {
  cards: string[];
  width: number;
  playable: (card: string) => boolean;
  picked?: string | null;
  label: (card: string) => string;
  face: (card: string) => ReactNode;
  onTap: (card: string) => void;
  /** A card's width. */
  size?: number;
  /** Every card may be tapped (to read what it does), not just the ones to play. */
  tapAll?: boolean;
}) {
  const step = cards.length > 1 ? Math.min(size + 4, (width - size) / (cards.length - 1)) : 0;
  const any = cards.some(playable);
  return (
    <span className="g-hand">
      {cards.map((c, i) => (
        <button
          // a hand may hold two cards alike
          // biome-ignore lint/suspicious/noArrayIndexKey: the place tells them apart
          key={`${c}:${i}`}
          type="button"
          className="g-hand-card"
          style={{ marginLeft: i === 0 ? 0 : step - size }}
          data-dim={(any && !playable(c)) || undefined}
          data-picked={picked === c || undefined}
          disabled={!tapAll && !playable(c)}
          aria-label={label(c)}
          onClick={() => onTap(c)}
        >
          {face(c)}
        </button>
      ))}
    </span>
  );
}

/** Under the table while I am not in a game: waiting at it, the queue, or a stake to sit with. */
export function RoundSeating({ v, api, door, run, left }: Omit<RoundScreenProps, "error">) {
  const [stake, setStake] = useState(v.minStake);
  const me = v.me.id;
  const playing = Boolean(v.durak?.game ?? v.colors?.game ?? v.blackout?.game);
  const stand = () => run(() => api.stand(door));
  if (v.seats.some((s) => s.id === me))
    return (
      <div className="g-wait">
        <p>
          {playing
            ? "Гра вже йде: сядеш у наступній"
            : v.seats.length < 2
              ? "Чекаємо на суперника"
              : `Гра почнеться${left !== null ? ` за ${clock(left)}` : " ось-ось"}`}
        </p>
        <button type="button" className="g-btn" onClick={stand}>
          Встати
        </button>
      </div>
    );
  if (v.me.queued)
    return (
      <div className="g-wait">
        <p>Ти в черзі: {v.queue.indexOf(me) + 1}-й. Сядеш у наступній грі</p>
        <button type="button" className="g-btn" onClick={stand}>
          Вийти
        </button>
      </div>
    );
  if (!v.open) return <p className="g-muted">Двері зачинилися: гру дограють без нових гравців</p>;
  if (v.available < v.minStake)
    return (
      <p className="g-muted">
        Щоб сісти, потрібно щонайменше {v.minStake}
        <Bolt size={12} /> цього відключення. Засвіти кілька вікон — і повертайся.
      </p>
    );
  const max = Math.max(v.minStake, v.available);
  const value = Math.min(Math.max(stake, v.minStake), max);
  return (
    <>
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
        {playing || v.seats.length >= 6 ? "Стати в чергу" : "Сісти за стіл"}
      </button>
    </>
  );
}

/** The ring: the game's players (or those seated while they gather), me at the bottom. */
export function ringOf(ids: number[], me: number): number[] {
  const at = ids.indexOf(me);
  return (at > 0 ? [...ids.slice(at), ...ids.slice(0, at)] : ids).slice(0, 6);
}
