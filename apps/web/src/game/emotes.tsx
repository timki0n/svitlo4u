/**
 * Reactions round a table: one at it taps an emoji in the row under the game; one watching taps a
 * phrase while the table gathers («Граєм?», «Удачі!»…), an emoji while a game is played. On every
 * screen a player's rises over their face like a tooltip, then fades; one watching's leaves their
 * face in the row of those watching, smaller, and fades within a second — several said at once
 * spread out: the leftmost goes left, the rightmost right, the rest down. The faces are found inside
 * the screen: `data-pid` (a seat's avatar, my plate, a field's head in «Графік»), `data-watcher` (a
 * face in the row; one not shown there leaves the row). Mine shows at once, as I tap; the core's
 * copy of it is then not shown again. Each one shows once, only while fresh, and without the motion
 * for those who asked for less.
 */
import { type RefObject, useEffect, useRef, useState } from "react";
import type {
  EveningEmote,
  EveningPhrase,
  EveningReaction,
  EveningTableView,
  gameApi,
} from "./api.ts";

type Api = ReturnType<typeof gameApi>;

/** The row's emojis (the core takes these and no others), with their names for a screen reader. */
const EMOTES: { emoji: EveningEmote; name: string }[] = [
  { emoji: "👍", name: "Клас" },
  { emoji: "😂", name: "Сміх" },
  { emoji: "😎", name: "Круто" },
  { emoji: "😱", name: "Жах" },
  { emoji: "😢", name: "Сумно" },
  { emoji: "😡", name: "Злість" },
  { emoji: "🤔", name: "Хм" },
  { emoji: "🔥", name: "Вогонь" },
];
/** What one watching may say while the table gathers (the core takes these and no others). */
const PHRASES: EveningPhrase[] = [
  "Привіт!",
  "Граєм?",
  "ГО!",
  "Я все.",
  "В іншу гру!",
  "Удачі!",
  "Скоро буду!",
  "Дякую за гру!",
  "Було весело!",
];
/** The core takes one a second from a player: the row rests as long after a tap. */
const REST_MS = 1_000;
/** One that reached the screen later than this after it was sent is not shown. */
const FRESH_MS = 2_500;
const RISE_MS = 2_400;
/** A bubble keeps this far from the screen's edges. */
const EDGE = 8;

/**
 * How long a reaction of one watching moves away from their face, fading as it goes: a phrase
 * longer than an emoji, time to read it.
 */
const fallMs = (what: string) => ((PHRASES as string[]).includes(what) ? 1_500 : 1_000);
/** Reactions of those watching that come this close together count as said at once. */
const TOGETHER_MS = 150;
/** A row of them under the faces: the taller one (an emoji) and a gap. */
const ROW = 28;

type Way = "left" | "down" | "right";
/** A reaction of one watching on the screen: their face's centre, and when it is gone. */
type Falling = { x: number; until: number };

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** A bubble with the reaction in it, put on the layer to be measured and placed. */
function bubbleOf(layer: HTMLElement, what: string, watching: boolean) {
  const box = document.createElement("span");
  box.className = watching ? "g-emote g-emote-fall" : "g-emote";
  const bubble = document.createElement("span");
  bubble.className = "g-emote-bubble";
  if ((PHRASES as string[]).includes(what)) bubble.dataset.text = "";
  if (watching) bubble.dataset.small = "";
  bubble.textContent = what;
  box.append(bubble);
  layer.append(box);
  return { box, bubble };
}

/**
 * The layer lies on the page (bubbles scroll with the faces they belong to): its box on the screen,
 * and the leftmost and rightmost a bubble may reach, off the edges of both.
 */
function frameOf(layer: HTMLElement) {
  const box = layer.getBoundingClientRect();
  return {
    box,
    lo: Math.max(box.left, 0) + EDGE,
    hi: Math.min(box.right, window.innerWidth) - EDGE,
  };
}

/**
 * Puts a bubble with its centre over `cx` (`y` on the screen), kept off the edges — the tail still
 * pointing at the face.
 */
function place(layer: HTMLElement, box: HTMLElement, bubble: HTMLElement, cx: number, y: number) {
  const f = frameOf(layer);
  const { width } = bubble.getBoundingClientRect();
  const half = width / 2;
  const x = Math.min(Math.max(cx, f.lo + half), Math.max(f.lo + half, f.hi - half));
  box.style.left = `${x - f.box.left}px`;
  box.style.top = `${y - f.box.top}px`;
  if (width > 0) bubble.style.setProperty("--tail", `${50 + ((cx - x) / width) * 100}%`);
}

/** Played, then gone (also when a page hidden mid-way holds its animations). */
function play(box: HTMLElement, frames: Keyframe[], duration = RISE_MS, easing = "ease-out") {
  box.animate(frames, { duration, easing, fill: "both" }).onfinish = () => box.remove();
  setTimeout(() => box.remove(), duration + 1_000);
}

/** A reaction of one at the table rises in its bubble over their face, and fades. */
function rise(layer: HTMLElement, root: HTMLElement, id: number, what: string) {
  if (document.hidden) return;
  const seat = root.querySelector<HTMLElement>(`[data-pid="${id}"]`);
  if (!seat) return;
  const r = (seat.querySelector(".g-pseat-face") ?? seat).getBoundingClientRect();
  const { box, bubble } = bubbleOf(layer, what, false);
  // one near the top of the page rises from lower down
  const height = bubble.getBoundingClientRect().height;
  const top = layer.getBoundingClientRect().top;
  place(layer, box, bubble, r.left + r.width / 2, Math.max(r.top - 4, top + height + 50));
  const up = (dy: number, s = 1) => `translate(-50%, calc(-100% - ${dy}px)) scale(${s})`;
  play(
    box,
    reduced()
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
      : [
          { transform: up(-6, 0.5), opacity: 0 },
          { transform: up(8, 1.12), opacity: 1, offset: 0.12 },
          { transform: up(10, 1), opacity: 1, offset: 0.22 },
          { transform: up(30, 1), opacity: 1, offset: 0.75 },
          { transform: up(44, 0.96), opacity: 0 },
        ],
  );
}

/**
 * Which way each of those watching who reacted at once goes, `i`-th of `count` by their faces from
 * left to right: one alone, down; two, the left one left and the right one right; more, the outer
 * ones out to their sides and the rest down.
 */
function wayOf(count: number, i: number): Way {
  if (count < 2) return "down";
  if (i === 0) return "left";
  if (i === count - 1) return "right";
  return "down";
}

/**
 * A reaction of one watching leaves their face — down, or out to its side — and fades within a
 * second: an emoji as it is, a phrase on a card whose tail points back at the face. `row` starts it
 * that many rows lower (one going down between others going out to the sides starts under them).
 */
function fall(layer: HTMLElement, face: DOMRect, what: string, way: Way, row: number) {
  const { box, bubble } = bubbleOf(layer, what, true);
  const { width } = bubble.getBoundingClientRect();
  const f = frameOf(layer);
  const cx = face.left + face.width / 2;
  // starting under the face: down, centred on it; left, mostly to its left; right, to its right
  const want = way === "down" ? cx - width / 2 : way === "left" ? cx + 10 - width : cx - 10;
  const left = Math.min(Math.max(want, f.lo), Math.max(f.lo, f.hi - width));
  box.style.left = `${left - f.box.left}px`;
  box.style.top = `${face.bottom + 5 + row * ROW - f.box.top}px`;
  if (width > 0) {
    const tail = Math.min(86, Math.max(14, ((cx - left) / width) * 100));
    bubble.style.setProperty("--tail", `${tail}%`);
  }
  // out to a side as far as the edge lets it, else just down
  const dx =
    way === "left"
      ? -Math.min(28, Math.max(0, left - (f.lo - EDGE) - 2))
      : way === "right"
        ? Math.min(28, Math.max(0, f.hi + EDGE - 2 - left - width))
        : 0;
  // only a little way down: it leaves the face rather than falls far
  const dy = way === "down" ? 10 : 6;
  const at = (k: number) => `translate(${dx * k}px, ${dy * k}px)`;
  play(
    box,
    reduced()
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }]
      : [
          { transform: "translate(0, -4px)", opacity: 0 },
          { transform: at(0.12), opacity: 1, offset: 0.12 },
          { transform: at(0.4), opacity: 1, offset: 0.4 },
          { transform: at(1), opacity: 0 },
        ],
    fallMs(what),
    "linear",
  );
}

/**
 * Shows reactions of those watching said at once, each from its face in the row of those watching
 * (the row itself when the face is not shown), spread out by `wayOf` together with those still on
 * the screen; returns those on the screen now.
 */
function fallAll(
  layer: HTMLElement,
  root: HTMLElement,
  items: { id: number; what: string }[],
  falling: Falling[],
): Falling[] {
  const now = performance.now();
  const still = falling.filter((f) => f.until > now);
  if (document.hidden) return still;
  const fresh = items.flatMap(({ id, what }) => {
    const face =
      root.querySelector<HTMLElement>(`[data-watcher="${id}"]`) ??
      root.querySelector<HTMLElement>(".g-watchers");
    if (!face) return [];
    const r = face.getBoundingClientRect();
    return [{ face: r, what, x: r.left + r.width / 2 }];
  });
  const all = [
    ...still.map((f) => ({ x: f.x, fresh: null })),
    ...fresh.map((f) => ({ x: f.x, fresh: f })),
  ].sort((a, b) => a.x - b.x);
  // those going down between two going out start under them, one row each
  all.forEach((a, i) => {
    const way = wayOf(all.length, i);
    const row = all.length > 2 && way === "down" ? i : 0;
    if (a.fresh) fall(layer, a.fresh.face, a.fresh.what, way, row);
  });
  return [...still, ...fresh.map((f) => ({ x: f.x, until: now + fallMs(f.what) }))];
}

/**
 * The reactions' row under the game — emojis for one at the table (and one watching a game played),
 * phrases for one watching while the table gathers — and their bubbles over the faces.
 */
export function Emotes({
  v,
  api,
  door,
  root,
}: {
  v: EveningTableView;
  api: Api;
  door: number;
  root: RefObject<HTMLElement | null>;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const shown = useRef(new Set<number>());
  // mine, shown as I tapped: the core's copy of each is not shown again
  const mine = useRef<{ emoji: string; t: number }[]>([]);
  // reactions of those watching: still on the screen, and those just come, gathered a moment so
  // that ones said at once are spread out together
  const falling = useRef<Falling[]>([]);
  const gathered = useRef<{ id: number; what: string }[]>([]);
  const gathering = useRef(0);
  const [resting, setResting] = useState(false);
  const me = v.me.id;
  const watching = !v.me.seated && v.watchers.includes(me);
  const bar = v.me.seated || (watching && v.live) ? "emojis" : watching ? "phrases" : null;

  useEffect(() => {
    const host = layer.current;
    const scope = root.current;
    if (!host || !scope) return;
    for (const e of v.emotes) {
      if (shown.current.has(e.n)) continue;
      shown.current.add(e.n);
      if (v.now - e.at > FRESH_MS) continue;
      if (e.id === me) {
        const i = mine.current.findIndex((m) => m.emoji === e.emoji && Date.now() - m.t < 6_000);
        if (i >= 0) {
          mine.current.splice(i, 1);
          continue;
        }
      }
      if (v.watchers.includes(e.id)) gathered.current.push({ id: e.id, what: e.emoji });
      else rise(host, scope, e.id, e.emoji);
    }
    if (gathered.current.length > 0 && !gathering.current)
      gathering.current = window.setTimeout(() => {
        gathering.current = 0;
        const items = gathered.current;
        gathered.current = [];
        falling.current = fallAll(host, scope, items, falling.current);
      }, TOGETHER_MS);
  }, [v.emotes, v.now, v.watchers, me, root]);

  useEffect(() => () => window.clearTimeout(gathering.current), []);

  const send = (what: EveningReaction) => {
    const host = layer.current;
    const scope = root.current;
    if (resting) return;
    if (host && scope) {
      if (watching) falling.current = fallAll(host, scope, [{ id: me, what }], falling.current);
      else rise(host, scope, me, what);
    }
    mine.current.push({ emoji: what, t: Date.now() });
    setResting(true);
    setTimeout(() => setResting(false), REST_MS);
    api.emote(door, what).catch(() => {
      // not sent (too fast, the game began, left): it showed here only
    });
  };

  return (
    <>
      <div ref={layer} className="g-emote-layer" aria-hidden="true" />
      {bar === "emojis" && (
        <section className="card g-emotes" aria-label="Емоції">
          {EMOTES.map((e) => (
            <button
              key={e.emoji}
              type="button"
              className="g-emote-btn"
              aria-label={e.name}
              title={e.name}
              disabled={resting}
              onClick={() => send(e.emoji)}
            >
              {e.emoji}
            </button>
          ))}
        </section>
      )}
      {bar === "phrases" && (
        <section className="card g-phrases" aria-label="Репліки">
          {PHRASES.map((text) => (
            <button
              key={text}
              type="button"
              className="g-phrase-btn"
              disabled={resting}
              onClick={() => send(text)}
            >
              {text}
            </button>
          ))}
        </section>
      )}
    </>
  );
}
