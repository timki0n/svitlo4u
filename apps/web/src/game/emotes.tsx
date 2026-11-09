/**
 * Emojis round a table: one at it taps an emoji in the row under the game, and on every screen it
 * rises over their face like a tooltip, then fades. The faces are found by `data-pid` inside the
 * screen (a seat's avatar, my plate, a field's head in «Графік»). Mine shows at once, as I tap; the
 * core's copy of it is then not shown again. Each one shows once, only while fresh, and without the
 * rise for those who asked for less motion.
 */
import { type RefObject, useEffect, useRef, useState } from "react";
import type { EveningEmote, EveningTableView, gameApi } from "./api.ts";

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
/** The core takes one a second from a player: the row rests as long after a tap. */
const REST_MS = 1_000;
/** One that reached the screen later than this after it was sent is not shown. */
const FRESH_MS = 2_500;
const RISE_MS = 2_400;

/** The top centre of a player's face on the screen (a seat's avatar, else the place itself). */
function faceOf(root: HTMLElement, id: number): { x: number; y: number } | null {
  const place = root.querySelector<HTMLElement>(`[data-pid="${id}"]`);
  if (!place) return null;
  const r = (place.querySelector(".g-pseat-face") ?? place).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top };
}

/** An emoji in its bubble rises over a face and fades. */
function rise(layer: HTMLElement, root: HTMLElement, id: number, emoji: string) {
  if (document.hidden) return;
  const at = faceOf(root, id);
  if (!at) return;
  const box = document.createElement("span");
  box.className = "g-emote";
  box.style.left = `${at.x}px`;
  box.style.top = `${at.y - 4}px`;
  const bubble = document.createElement("span");
  bubble.className = "g-emote-bubble";
  bubble.textContent = emoji;
  box.append(bubble);
  layer.append(box);
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const up = (y: number, s = 1) => `translate(-50%, calc(-100% - ${y}px)) scale(${s})`;
  box.animate(
    still
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
      : [
          { transform: up(-6, 0.5), opacity: 0 },
          { transform: up(8, 1.12), opacity: 1, offset: 0.12 },
          { transform: up(10, 1), opacity: 1, offset: 0.22 },
          { transform: up(30, 1), opacity: 1, offset: 0.75 },
          { transform: up(44, 0.96), opacity: 0 },
        ],
    { duration: RISE_MS, easing: "ease-out", fill: "both" },
  ).onfinish = () => box.remove();
  // a page hidden mid-way holds its animations: the bubble goes all the same
  setTimeout(() => box.remove(), RISE_MS + 1_000);
}

/** The emojis' row under the game (for one at the table) and their bubbles over the faces. */
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
  const [resting, setResting] = useState(false);
  const me = v.me.id;

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
      rise(host, scope, e.id, e.emoji);
    }
  }, [v.emotes, v.now, me, root]);

  const send = (emoji: EveningEmote) => {
    const host = layer.current;
    const scope = root.current;
    if (resting) return;
    if (host && scope) rise(host, scope, me, emoji);
    mine.current.push({ emoji, t: Date.now() });
    setResting(true);
    setTimeout(() => setResting(false), REST_MS);
    api.emote(door, emoji).catch(() => {
      // not sent (too fast, stood up): it showed here only
    });
  };

  return (
    <>
      <div ref={layer} className="g-emote-layer" aria-hidden="true" />
      {v.me.seated && (
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
    </>
  );
}
