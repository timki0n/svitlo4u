import { type RefObject, useEffect, useRef } from "react";
import { SNOW_AMOUNT, towardAmount } from "../weather.ts";

/**
 * Fine snow round the game's facade while anything falls from Kyiv's sky: two flat canvases, one
 * behind the tower's (transparent) canvas and one in front, so the 3D scene itself stays idle — it
 * draws only when something moves. Nothing for those who asked their system for less motion.
 */

type Layer = {
  /** Flakes per square px of the canvas, with the heaviest snow. */
  density: number;
  radius: [number, number];
  /** Fall, px/s. */
  speed: [number, number];
  alpha: [number, number];
  /** Sway to the sides, px. */
  sway: [number, number];
};

/** Behind the tower: smaller, slower, dimmer — the depth. In front: a few larger ones. */
const BACK: Layer = {
  density: 1 / 1800,
  radius: [0.5, 1.1],
  speed: [10, 20],
  alpha: [0.3, 0.6],
  sway: [4, 9],
};
const FRONT: Layer = {
  density: 1 / 3600,
  radius: [0.9, 1.7],
  speed: [18, 34],
  alpha: [0.5, 0.9],
  sway: [6, 14],
};

/** A light breeze, px/s. */
const WIND = 4;
/** Snow needs no more than this, and the phone's battery thanks it. */
const FRAME_MS = 1000 / 30;

type Flake = {
  x: number;
  y: number;
  r: number;
  speed: number;
  sway: number;
  phase: number;
  /** Sway cycles per second × 2π. */
  rate: number;
  alpha: number;
  /** 0..1: the flake falls while the weather's amount is above it. */
  rank: number;
};

type Sheet = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  layer: Layer;
  flakes: Flake[];
  w: number;
  h: number;
};

const between = ([a, b]: [number, number]) => a + Math.random() * (b - a);

function flake(layer: Layer, w: number, y: number, rank: number): Flake {
  return {
    x: Math.random() * w,
    y,
    r: between(layer.radius),
    speed: between(layer.speed),
    sway: between(layer.sway),
    phase: Math.random() * Math.PI * 2,
    rate: between([0.4, 1.1]),
    alpha: between(layer.alpha),
    rank,
  };
}

/** The sheet fits its canvas (and the screen's density); flakes are added or dropped to match. */
function fit(sheet: Sheet): void {
  const { canvas, ctx, layer } = sheet;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  sheet.w = w;
  sheet.h = h;
  const count = Math.round(w * h * layer.density);
  while (sheet.flakes.length < count) {
    sheet.flakes.push(flake(layer, w, Math.random() * h, Math.random()));
  }
  sheet.flakes.length = count;
}

function draw(sheet: Sheet, dt: number, amount: number): void {
  const { ctx, w, h } = sheet;
  ctx.clearRect(0, 0, w, h);
  for (const f of sheet.flakes) {
    f.y += f.speed * dt;
    f.x += WIND * dt;
    f.phase += f.rate * dt;
    if (f.y - f.r > h) Object.assign(f, flake(sheet.layer, w, -f.r - Math.random() * 24, f.rank));
    if (f.x > w + 16) f.x -= w + 32;
    // the weather's share of the flakes, the edge one melting; in at the top, away near the bottom
    const shown = Math.min(1, (amount - f.rank) / 0.04);
    const fade = Math.min(shown, (f.y + f.r) / 24, (h - f.y) / (h * 0.18));
    if (fade <= 0) continue;
    ctx.globalAlpha = f.alpha * fade;
    ctx.beginPath();
    ctx.arc(f.x + Math.sin(f.phase) * f.sway, f.y, f.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

type Snowfall = { setTarget(amount: number): void; stop(): void };

/**
 * Snow on these canvases, as much as `setTarget` says; drawn only while on screen and seen. While
 * nothing falls they are hidden and empty: no memory, nothing for the compositor to lay over the
 * tower at its every frame.
 */
function snowfall(canvases: readonly [HTMLCanvasElement, Layer][]): Snowfall {
  const sheets: Sheet[] = [];
  for (const [canvas, layer] of canvases) {
    const ctx = canvas.getContext("2d");
    if (ctx) sheets.push({ canvas, ctx, layer, flakes: [], w: 0, h: 0 });
  }
  const first = sheets[0];
  if (!first) return { setTarget: () => {}, stop: () => {} };
  // the canvases' place (they fill it): hidden canvases are never seen, their place is
  const place = first.canvas.parentElement ?? first.canvas;

  let raf = 0;
  let running = false;
  let shown = false;
  let seen = true;
  let last = 0;
  let amount = 0;
  let target = 0;
  const show = (on: boolean) => {
    shown = on;
    for (const sheet of sheets) {
      sheet.canvas.hidden = !on;
      if (on) fit(sheet);
      else {
        sheet.canvas.width = 0;
        sheet.canvas.height = 0;
        sheet.flakes.length = 0;
      }
    }
  };
  const frame = (t: number) => {
    raf = requestAnimationFrame(frame);
    if (t - last < FRAME_MS - 2) return;
    const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
    last = t;
    amount = towardAmount(amount, target, dt);
    for (const sheet of sheets) draw(sheet, dt, amount);
    // all melted and nothing falls: rest until the weather changes
    if (amount === 0 && target === 0) {
      stop();
      show(false);
    }
  };
  const start = () => {
    if (running || !seen || document.hidden || (amount === 0 && target === 0)) return;
    if (!shown) show(true);
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }
  const onVisibility = () => (document.hidden ? stop() : start());

  const resize = new ResizeObserver(() => {
    if (shown) for (const sheet of sheets) fit(sheet);
  });
  resize.observe(place);
  const view = new IntersectionObserver(([entry]) => {
    seen = entry?.isIntersecting ?? true;
    if (seen) start();
    else stop();
  });
  view.observe(place);
  document.addEventListener("visibilitychange", onVisibility);
  show(false);

  return {
    setTarget(next) {
      target = next;
      start();
    },
    stop() {
      stop();
      resize.disconnect();
      view.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const sheet of sheets) sheet.ctx.clearRect(0, 0, sheet.w, sheet.h);
    },
  };
}

/**
 * Two canvases for the snow round the facade: `back` goes before the 3D canvas (flakes pass behind
 * the tower, drawn on a transparent background), `front` after it. `precipitation`: 0–3, the
 * weather's (/api/v1/weather).
 */
export function useSnow(precipitation: number): {
  back: RefObject<HTMLCanvasElement | null>;
  front: RefObject<HTMLCanvasElement | null>;
} {
  const back = useRef<HTMLCanvasElement>(null);
  const front = useRef<HTMLCanvasElement>(null);
  const fall = useRef<Snowfall | null>(null);
  useEffect(() => {
    if (!back.current || !front.current) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      back.current.hidden = true;
      front.current.hidden = true;
      return;
    }
    const s = snowfall([
      [back.current, BACK],
      [front.current, FRONT],
    ]);
    fall.current = s;
    return () => {
      s.stop();
      fall.current = null;
    };
  }, []);
  useEffect(() => {
    fall.current?.setTarget(SNOW_AMOUNT[precipitation as 0 | 1 | 2 | 3] ?? 0);
  }, [precipitation]);
  return { back, front };
}
