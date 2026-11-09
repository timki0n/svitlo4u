/**
 * Points flying across the table when a game or a hand is settled: coins from those who pay to
 * those who get (in poker, from the pot to the winners), a «−N» rising by each who pays and a «+N»
 * by each who gets, who gets bouncing as the coins land. The places are found by `data-pid` — a
 * player's id, or "pot" — inside the screen. Only a result that has just come flies (not one long
 * over when the screen opens), and not at all for those who asked for less motion.
 */
import { type RefObject, useEffect, useRef } from "react";
import type { EveningTableView } from "./api.ts";

type Result = NonNullable<EveningTableView["result"]>;
export type Transfer = { from: string; to: string; amount: number };

/** Who pays whom: each payer's loss shared out over the gainers, the biggest gain first. */
export function transfers(pay: Record<string, number>, from: "players" | "pot"): Transfer[] {
  const gains = Object.entries(pay)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({ id, left: n }));
  if (from === "pot") return gains.map((g) => ({ from: "pot", to: g.id, amount: g.left }));
  const out: Transfer[] = [];
  for (const [payer, n] of Object.entries(pay)) {
    let rest = -n;
    for (const g of gains) {
      if (rest <= 0) break;
      const take = Math.min(rest, g.left);
      if (take <= 0) continue;
      out.push({ from: payer, to: g.id, amount: take });
      g.left -= take;
      rest -= take;
    }
  }
  return out;
}

const FLIGHT_MS = 800;
const COIN_GAP_MS = 70;
const TRANSFER_GAP_MS = 160;
/** A result older than this when the screen gets it is not flown. */
const FRESH_MS = 4000;

type Spot = { el: HTMLElement; x: number; y: number };

export function PayFlight({
  result,
  serverNow,
  root,
  from,
}: {
  result: Result | null | undefined;
  serverNow: number;
  root: RefObject<HTMLElement | null>;
  from: "players" | "pot";
}) {
  const layer = useRef<HTMLDivElement>(null);
  const flown = useRef<number | null>(null);
  useEffect(() => {
    if (!result || flown.current === result.at) return;
    flown.current = result.at;
    if (serverNow - result.at > FRESH_MS) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const host = layer.current;
    const scope = root.current;
    if (!host || !scope) return;
    const spot = (pid: string): Spot | null => {
      const el = scope.querySelector<HTMLElement>(`[data-pid="${pid}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };

    const coin = (a: Spot, b: Spot, delay: number) => {
      const c = document.createElement("span");
      c.className = "g-coin";
      c.style.left = `${a.x}px`;
      c.style.top = `${a.y}px`;
      host.append(c);
      const jx = (Math.random() - 0.5) * 16;
      const jy = (Math.random() - 0.5) * 10;
      const dx = b.x - a.x + jx;
      const dy = b.y - a.y + jy;
      const lift = Math.min(90, Math.hypot(dx, dy) * 0.35);
      const at = (k: number, up: number, scale: number) =>
        `translate(-50%, -50%) translate(${dx * k}px, ${dy * k - up}px) scale(${scale})`;
      c.animate(
        [
          { transform: at(0, 0, 0.4), opacity: 0 },
          { transform: at(0.12, lift * 0.45, 1), opacity: 1, offset: 0.15 },
          { transform: at(0.5, lift, 1.1), opacity: 1, offset: 0.5 },
          { transform: at(1, 0, 0.6), opacity: 0.15 },
        ],
        { duration: FLIGHT_MS, delay, easing: "cubic-bezier(0.45, 0, 0.35, 1)", fill: "both" },
      ).onfinish = () => c.remove();
    };

    const label = (p: Spot, n: number, delay: number) => {
      const l = document.createElement("span");
      l.className = "g-fly-label";
      l.dataset.up = n > 0 ? "1" : "";
      l.textContent = n > 0 ? `+${n}` : `−${-n}`;
      l.style.left = `${p.x}px`;
      l.style.top = `${p.y}px`;
      host.append(l);
      l.animate(
        [
          { transform: "translate(-50%, -50%)", opacity: 0 },
          { transform: "translate(-50%, -110%)", opacity: 1, offset: 0.2 },
          { transform: "translate(-50%, -110%)", opacity: 1, offset: 0.75 },
          { transform: "translate(-50%, -190%)", opacity: 0 },
        ],
        { duration: 1600, delay, easing: "ease-out", fill: "both" },
      ).onfinish = () => l.remove();
    };

    const bounce = (p: Spot, delay: number) => {
      p.el.animate([{ scale: "1" }, { scale: "1.16" }, { scale: "1" }], {
        duration: 380,
        delay,
        easing: "ease-out",
      });
    };

    // those who pay show it at once; the coins go; those who get show it as they land
    for (const [pid, n] of Object.entries(result.pay))
      if (n < 0) {
        const p = spot(pid);
        if (p) label(p, n, 0);
      }
    const landed = new Map<string, number>();
    transfers(result.pay, from).forEach((t, k) => {
      const a = spot(t.from);
      const b = spot(t.to);
      if (!a || !b) return;
      const coins = Math.max(3, Math.min(8, Math.round(t.amount / 5)));
      for (let i = 0; i < coins; i++) coin(a, b, k * TRANSFER_GAP_MS + i * COIN_GAP_MS);
      const end = k * TRANSFER_GAP_MS + (coins - 1) * COIN_GAP_MS + FLIGHT_MS;
      landed.set(t.to, Math.max(landed.get(t.to) ?? 0, end));
    });
    for (const [pid, end] of landed) {
      const p = spot(pid);
      const n = result.pay[pid] ?? 0;
      if (!p) continue;
      label(p, n, end - 200);
      bounce(p, end - 250);
    }
  }, [result, serverNow, root, from]);
  return <div ref={layer} className="g-flight" aria-hidden="true" />;
}
