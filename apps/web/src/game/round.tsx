/**
 * What the round games' screens share («Дурень», «Кольори»): a player round the table with their
 * cards face down, my own plate, my hand of cards, and the card under the table while one is not
 * in a game — sitting down with a stake, waiting for the others, the queue.
 */
import { type ReactNode, useId, useRef, useState } from "react";
import type { EveningTableView, gameApi } from "./api.ts";
import { CardFace, clock, Net, type Point } from "./cards.tsx";
import type { Spot } from "./motion.tsx";
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
  drop,
  ...flags
}: {
  v: EveningTableView;
  id: number;
  at: Point;
  cards: number;
  role: string | null;
  net: number;
  compact: boolean;
  /** A card may be dropped on them (data-drop). */
  drop?: string | undefined;
} & Flags) {
  return (
    <div
      className="g-pseat"
      data-pid={id}
      data-drop={drop}
      style={{ left: at.x, top: at.y }}
      {...flagsOf(flags)}
    >
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

/** Who watches the table: an eye, their faces small in a row (the first few, then «+N»). */
export function Watchers({ v, size = 20 }: { v: EveningTableView; size?: number }) {
  const ids = v.watchers;
  if (ids.length === 0) return null;
  const shown = ids.slice(0, ids.length > 5 ? 4 : 5);
  // the viewer watching sees their own face among them: their reactions rise over it
  if (ids.includes(v.me.id) && !shown.includes(v.me.id)) shown[shown.length - 1] = v.me.id;
  const names = ids.map((id) => playerName(v.players[id])).join(", ");
  return (
    <span className="g-watchers" title={`Дивляться: ${names}`}>
      <span className="sr-only">Дивляться: {names}</span>
      <svg className="g-watchers-eye" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="3" fill="currentColor" />
      </svg>
      <span className="g-watchers-faces" aria-hidden="true">
        {shown.map((id) => (
          <span key={id} className="g-watcher" data-watcher={id}>
            <Avatar id={id} player={v.players[id]} size={size} />
          </span>
        ))}
        {ids.length > shown.length && (
          <span className="g-watchers-more">+{ids.length - shown.length}</span>
        )}
      </span>
    </span>
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

/**
 * My hand: the cards in a row, overlapping to fit; the ones I may play stand out. A finger slid
 * along it lifts the card under it (so a big hand is easy to aim at) and, let go there, picks it;
 * drawn up, that card follows the finger, and let go over a place (`data-drop`: the table, a card
 * on it, a player) it is played — let go anywhere well above the hand counts as the table.
 */
export function Hand({
  cards,
  width,
  playable,
  picked,
  label,
  face,
  onTap,
  onDrop,
  onLift,
  size = 44,
}: {
  cards: string[];
  width: number;
  playable: (card: string) => boolean;
  picked?: string | null;
  label: (card: string) => string;
  face: (card: string) => ReactNode;
  /** A tap, no drag: picks the card, or tells what it does. */
  onTap: (card: string) => void;
  /** Let go after a drag: over a place (its data-drop, or "table"), or back in the hand (null). */
  onDrop: (card: string, target: string | null, at: Spot) => void;
  /** A drag starts (the card) or ends (null): the screen may show where it may go. */
  onLift?: (card: string | null) => void;
  /** A card's width. */
  size?: number;
}) {
  const row = useRef<HTMLSpanElement>(null);
  const [touch, setTouch] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ i: number; card: string; x: number; y: number } | null>(null);
  // where the finger came down; x where it came onto the card it is on now; whether it slid
  const start = useRef<{ x: number; y: number; at: number; slid: boolean } | null>(null);
  const touched = useRef<number | null>(null);
  const dragging = useRef<{ i: number; card: string } | null>(null);
  const over = useRef<HTMLElement | null>(null);
  const step = cards.length > 1 ? Math.min(size + 4, (width - size) / (cards.length - 1)) : 0;
  const any = cards.some(playable);

  /** The card under a finger at x (the row's height: a finger a little off it still counts). */
  const indexAt = (x: number) => {
    const r = row.current?.getBoundingClientRect();
    if (!r) return null;
    const hit = document
      .elementFromPoint(Math.min(Math.max(x, r.left + 2), r.right - 2), r.bottom - 20)
      ?.closest<HTMLElement>(".g-hand-card");
    return hit && row.current?.contains(hit) ? Number(hit.dataset.i) : null;
  };
  const pickTouch = (i: number | null) => {
    touched.current = i;
    setTouch(i);
  };
  const hover = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]") ?? null;
    if (el === over.current) return;
    over.current?.removeAttribute("data-over");
    el?.setAttribute("data-over", "");
    over.current = el;
  };
  const end = () => {
    over.current?.removeAttribute("data-over");
    over.current = null;
    start.current = null;
    dragging.current = null;
    setDrag(null);
    pickTouch(null);
  };

  return (
    <span
      ref={row}
      className="g-hand"
      data-anchor="hand"
      onPointerDown={(e) => {
        try {
          row.current?.setPointerCapture(e.pointerId);
        } catch {
          // a pointer already gone: its moves just will not follow outside the row
        }
        start.current = { x: e.clientX, y: e.clientY, at: e.clientX, slid: false };
        pickTouch(indexAt(e.clientX));
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const d = dragging.current;
        if (d) {
          setDrag({ ...d, x: e.clientX, y: e.clientY });
          hover(e.clientX, e.clientY);
          return;
        }
        const dx = e.clientX - s.at;
        const dy = e.clientY - s.y;
        if (Math.hypot(e.clientX - s.x, dy) >= 10) s.slid = true;
        const i = touched.current;
        const card = i === null ? undefined : cards[i];
        // drawn up (from the card it slid onto): the card under the finger comes along
        if (i !== null && card && dy < -22 && -dy > Math.abs(dx) * 0.7 && playable(card)) {
          dragging.current = { i, card };
          setDrag({ i, card, x: e.clientX, y: e.clientY });
          onLift?.(card);
          return;
        }
        // slid along: the card under the finger rises
        const j = indexAt(e.clientX);
        if (j !== touched.current) {
          s.at = e.clientX;
          pickTouch(j);
        }
      }}
      onPointerUp={(e) => {
        const s = start.current;
        const d = dragging.current;
        if (d) {
          const el = document
            .elementFromPoint(e.clientX, e.clientY)
            ?.closest<HTMLElement>("[data-drop]");
          const top = row.current?.getBoundingClientRect().top ?? 0;
          const target = el?.dataset.drop ?? (e.clientY < top - 40 ? "table" : null);
          end();
          onLift?.(null);
          onDrop(d.card, target, { x: e.clientX, y: e.clientY });
          return;
        }
        // a tap; or let go after sliding along: the card it stopped on is picked (never played)
        const i = touched.current;
        const card = i === null ? undefined : cards[i];
        if (s && card && (!s.slid || card !== picked)) onTap(card);
        end();
      }}
      onPointerCancel={() => {
        if (dragging.current) onLift?.(null);
        end();
      }}
    >
      {cards.map((c, i) => (
        <button
          // a hand may hold two cards alike
          // biome-ignore lint/suspicious/noArrayIndexKey: the place tells them apart
          key={`${c}:${i}`}
          type="button"
          className="g-hand-card"
          data-i={i}
          style={{ marginLeft: i === 0 ? 0 : step - size }}
          data-dim={(any && !playable(c)) || undefined}
          data-picked={picked === c || undefined}
          data-touched={(touch === i && !drag) || undefined}
          data-lifted={drag?.i === i || undefined}
          aria-label={label(c)}
          // a key (no pointer) presses it: a finger's taps come through the row
          onClick={(e) => {
            if (e.detail === 0) onTap(c);
          }}
        >
          {face(c)}
        </button>
      ))}
      {drag && (
        <span className="g-drag-ghost" style={{ left: drag.x, top: drag.y }}>
          {face(drag.card)}
        </span>
      )}
    </span>
  );
}

/**
 * «Здатися», asked once more in a window over the page (giving up loses points, a slip of a finger
 * must not): what it costs, «Грати далі» (the one in focus) or «Здатися». A tap outside or Esc
 * closes it.
 */
export function GiveUp({ cost, onYes }: { cost: ReactNode; onYes: () => void }) {
  const box = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const title = useId();
  const close = () => box.current?.close();
  return (
    <>
      <button
        type="button"
        className="g-btn"
        onClick={() => {
          box.current?.showModal();
          // the safe answer in focus: a slip (or Enter) keeps playing
          stay.current?.focus();
        }}
      >
        Здатися
      </button>
      <dialog
        ref={box}
        className="g-confirm"
        aria-labelledby={title}
        onClick={(e) => {
          // the dialog itself is hit only round its card: the dimmed page
          if (e.target === box.current) close();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div className="g-confirm-card">
          <p id={title} className="g-confirm-title">
            Здатися?
          </p>
          <p className="g-confirm-text">{cost}</p>
          <div className="g-confirm-moves">
            <button
              type="button"
              className="g-btn g-confirm-yes"
              onClick={() => {
                close();
                onYes();
              }}
            >
              Здатися
            </button>
            <button ref={stay} type="button" className="g-play" onClick={close}>
              Грати далі
            </button>
          </div>
        </div>
      </dialog>
    </>
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
