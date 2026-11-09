/**
 * Cards in motion on the round games' tables: a card that comes onto the table flies in from where
 * it came (a seat, the stock, the spot a finger let it go); cards that leave the table fly to whoever
 * takes them or to the discard; cards drawn fly from the stock to the seat (to my hand, for me).
 * Places are found inside the screen: `data-pid` (a player), `data-anchor` ("stock", "discard",
 * "hand"). Nothing moves for those who asked for less motion, nor on the view first shown.
 */
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";

export type Spot = { x: number; y: number };
export type Motion = {
  root: RefObject<HTMLElement | null>;
  me: number;
  /** Set once the first view is on the screen: what was there already does not fly in. */
  live: RefObject<boolean>;
  /** Where my finger let a card go (and when): it settles from there, not from my hand. */
  dropped: RefObject<{ card: string; at: Spot; t: number } | null>;
};
export const MotionContext = createContext<Motion | null>(null);

/** Nothing flies for one who asked for less motion, nor while the page is not seen. */
const still = () =>
  document.hidden || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

/** My finger let a card go here: when it lands on the table (soon), it comes from this spot. */
export function droppedAt(m: Motion, card: string, at: Spot) {
  m.dropped.current = { card, at, t: Date.now() };
}

/** A place's centre: "pid:7" (a player — me: my hand), or an anchor ("stock", "discard", "hand"). */
export function spotOf(root: HTMLElement, at: string, me: number): Spot | null {
  let el: Element | null = null;
  if (at.startsWith("pid:")) {
    const id = Number(at.slice(4));
    el =
      (id === me ? root.querySelector('[data-anchor="hand"]') : null) ??
      root.querySelector(`[data-pid="${id}"]`);
  } else el = root.querySelector(`[data-anchor="${at}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** The layer the copies of moving cards fly in, over everything. */
function layer(): HTMLElement {
  let l = document.querySelector<HTMLElement>(".g-card-flight");
  if (!l) {
    l = document.createElement("div");
    l.className = "g-card-flight";
    l.setAttribute("aria-hidden", "true");
    document.body.append(l);
  }
  return l;
}

/** How many cards each one holds, and the stock: what a view showed, to tell what moved since. */
export type Counted = { deck: number; cards: Map<number, number> };
export const counted = (g: {
  deck: number;
  players: { id: number; cards: number }[];
}): Counted => ({ deck: g.deck, cards: new Map(g.players.map((p) => [p.id, p.cards])) });

/**
 * From the stock to whoever holds more cards than the view before (none before: a game just
 * dealt, to each). `less` takes cards that came from elsewhere off someone's count (one who took).
 */
export function flyDraws(
  m: Motion,
  prev: Counted | null,
  now: Counted,
  less?: (id: number) => number,
) {
  let k = 0;
  for (const [id, n] of now.cards) {
    const more = n - (prev ? (prev.cards.get(id) ?? n) : 0) - (less?.(id) ?? 0);
    if (more > 0) flyBacks(m, "stock", `pid:${id}`, more, (prev ? 380 : 0) + k++ * 150);
  }
}

/** A copy of a card flies from one spot to another, then is gone. */
function flyCopy(node: Node, from: DOMRect | Spot, to: Spot, delay: number, fade: boolean) {
  const box = document.createElement("div");
  box.className = "g-card-copy";
  const x = "width" in from ? from.left + from.width / 2 : from.x;
  const y = "width" in from ? from.top + from.height / 2 : from.y;
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
  box.append(node);
  layer().append(box);
  box.animate(
    [
      { transform: "translate(-50%, -50%)", opacity: 1 },
      {
        transform: `translate(calc(-50% + ${to.x - x}px), calc(-50% + ${to.y - y}px)) scale(${fade ? 0.5 : 0.8})`,
        opacity: fade ? 0 : 0.9,
      },
    ],
    { duration: 480, delay, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "both" },
  ).onfinish = () => box.remove();
  // a page hidden mid-flight holds its animations: the copy goes all the same
  setTimeout(() => box.remove(), delay + 1500);
}

/** Card backs fly from one place to another — drawn from the stock, stolen, tucked back. */
export function flyBacks(m: Motion, from: string, to: string, count: number, delay = 0) {
  const root = m.root.current;
  if (!root || !m.live.current || still() || count <= 0) return;
  const a = spotOf(root, from, m.me);
  const b = spotOf(root, to, m.me);
  if (!a || !b) return;
  for (let i = 0; i < Math.min(count, 8); i++) {
    const back = document.createElement("span");
    back.className = "g-card g-card-back";
    back.dataset.size = "board";
    flyCopy(back, a, b, delay + i * 90, false);
  }
}

/** A card that, coming onto the table, flies in from where it came. */
export function FlyIn({
  from,
  card,
  className,
  children,
}: {
  /** Where it comes from (see spotOf); null: it just appears. */
  from: string | null;
  /** Which card: one my finger dropped settles from that spot. */
  card?: string;
  className?: string;
  children: ReactNode;
}) {
  const m = useContext(MotionContext);
  const ref = useRef<HTMLSpanElement>(null);
  // once: an effect run again (as React's strict mode does) must not send it off a second time
  const flown = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: it flies once, as it comes
  useLayoutEffect(() => {
    const el = ref.current;
    const root = m?.root.current;
    if (flown.current || !el || !m || !root || !m.live.current || still()) return;
    flown.current = true;
    const drop = m.dropped.current;
    const mine = drop && card && drop.card === card && Date.now() - drop.t < 5000;
    const src = mine ? drop.at : from ? spotOf(root, from, m.me) : null;
    if (mine) m.dropped.current = null;
    if (!src) return;
    const r = el.getBoundingClientRect();
    const dx = src.x - (r.left + r.width / 2);
    const dy = src.y - (r.top + r.height / 2);
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(0.75)`, opacity: 0.5 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 420, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
  }, []);
  return (
    <span ref={ref} className={className ?? "g-fly-in"}>
      {children}
    </span>
  );
}

/** Where a card lies at rest: one still flying in is measured where it will land. */
function restRect(el: Element): DOMRect {
  const anims = el.closest(".g-fly-in")?.getAnimations() ?? [];
  if (anims.length === 0) return el.getBoundingClientRect();
  const was = anims.map((a) => a.currentTime);
  for (const a of anims) a.currentTime = Number(a.effect?.getComputedTiming().endTime ?? 0);
  const r = el.getBoundingClientRect();
  anims.forEach((a, i) => {
    a.currentTime = was[i] ?? null;
  });
  return r;
}

/**
 * Cards leaving the table: each view, a copy of what lies there is kept with where it lay; when
 * `round` changes (a new bout, a new turn), those copies fly to where the cards went — `goes` as the
 * new view tells it: "pid:…" for one who took them, "discard" for the discard, null: nowhere seen.
 */
export function useLeaving(m: Motion, round: string, selector: string, goes: string | null) {
  const last = useRef<{ round: string; cards: { node: Node; rect: DOMRect }[] }>({
    round,
    cards: [],
  });
  useLayoutEffect(() => {
    const root = m.root.current;
    const prev = last.current;
    if (root && m.live.current && !still() && prev.round !== round && goes) {
      const to = spotOf(root, goes, m.me);
      if (to)
        prev.cards.forEach((c, i) => {
          flyCopy(c.node, c.rect, to, i * 50, goes === "discard");
        });
    }
    last.current = {
      round,
      cards: root
        ? [...root.querySelectorAll(selector)].map((el) => ({
            node: el.cloneNode(true),
            rect: restRect(el),
          }))
        : [],
    };
  });
}

/** Turns the motion on once the first view has been shown (what was there does not fly in). */
export function useMotion(root: RefObject<HTMLElement | null>, me: number, ready: boolean): Motion {
  const live = useRef(false);
  const dropped = useRef<{ card: string; at: Spot; t: number } | null>(null);
  useLayoutEffect(() => {
    if (ready) live.current = true;
  });
  return { root, me, live, dropped };
}
