/**
 * The window games on the page: plain SVG and DOM in the site's colours, driven by touch.
 * Each mount draws one puzzle into `root`, reports through `ctx` and returns its cleanup.
 */
import { type GameIcon, icon, iconPaths } from "./icons.ts";
import {
  BATTERY_KINDS,
  type BatteryPuzzle,
  type BeamPuzzle,
  type Block,
  batteryPour,
  batterySorted,
  type ChainPuzzle,
  type ChargePuzzle,
  chainPowered,
  crossingEdges,
  DIRS,
  degree,
  FUSE_SPEEDUP,
  type FusePuzzle,
  type Mirror,
  type PackPuzzle,
  type PetsPuzzle,
  type Point,
  rotate,
  type SlidePuzzle,
  slideFits,
  slideGrid,
  traceBeam,
  type UntanglePuzzle,
} from "./puzzles.ts";

export type GameCtx = {
  /** The line above the board; `warn` is shown after it in red. */
  say(text: string, warn?: string): void;
  done(note: string): void;
};
export type Cleanup = (() => void) | undefined;

const NS = "http://www.w3.org/2000/svg";
const LIGHT = "var(--light)";
const DIM = "rgba(242, 239, 234, 0.2)";
const TILE = "var(--well)";
const TEXT = "var(--text)";
const BAD = "var(--warn)";
const BOX = "#5a5d66";
const BANK_COLORS = ["#ff9a3d", "#8fa3c8", "#d9b86a"];

function svgEl(tag: string, attrs: Record<string, string | number>, parent?: Element): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function svgRoot(root: HTMLElement, w: number, h: number, extra = ""): SVGSVGElement {
  return svgEl(
    "svg",
    { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: `g-svg ${extra}`.trim() },
    root,
  ) as SVGSVGElement;
}

function pointIn(svg: SVGSVGElement, e: PointerEvent, w: number, h: number): [number, number] {
  const r = svg.getBoundingClientRect();
  return [((e.clientX - r.left) * w) / r.width, ((e.clientY - r.top) * h) / r.height];
}

// ── Ланцюг ──────────────────────────────────────────────────────────────────────────────────

export function mountChain(root: HTMLElement, p: ChainPuzzle, ctx: GameCtx): Cleanup {
  ctx.say("Повертай плитки, щоб струм від батареї дійшов до всіх лампочок");
  const { n, source } = p;
  const tiles = p.tiles.slice();
  const size = 300;
  const cs = size / n;
  const bulbs = p.solution.filter((v, i) => i !== source && degree(v) === 1).length;
  const svg = svgRoot(root, size, size);
  let won = false;
  const draw = () => {
    svg.replaceChildren();
    const on = chainPowered(n, source, tiles);
    tiles.forEach((v, i) => {
      const x = (i % n) * cs;
      const y = Math.floor(i / n) * cs;
      const cx = x + cs / 2;
      const cy = y + cs / 2;
      const col = on[i] ? LIGHT : DIM;
      const g = svgEl("g", { class: "g-tap" }, svg);
      svgEl(
        "rect",
        { x: x + 2, y: y + 2, width: cs - 4, height: cs - 4, rx: 9, style: `fill:${TILE}` },
        g,
      );
      for (const [dx, dy, bit] of DIRS)
        if (v & bit)
          svgEl(
            "line",
            {
              x1: cx,
              y1: cy,
              x2: cx + (dx * cs) / 2,
              y2: cy + (dy * cs) / 2,
              style: `stroke:${col};stroke-width:${cs * 0.15}`,
            },
            g,
          );
      if (i === source)
        svgEl(
          "rect",
          {
            x: cx - cs * 0.2,
            y: cy - cs * 0.2,
            width: cs * 0.4,
            height: cs * 0.4,
            rx: 5,
            style: `fill:${LIGHT}`,
          },
          g,
        );
      else if (degree(v) === 1)
        svgEl(
          "circle",
          {
            cx,
            cy,
            r: cs * 0.18,
            style: `fill:${on[i] ? LIGHT : TILE};stroke:${col};stroke-width:2`,
          },
          g,
        );
      else svgEl("circle", { cx, cy, r: cs * 0.08, style: `fill:${col}` }, g);
      g.addEventListener("click", () => {
        if (won) return;
        tiles[i] = rotate(tiles[i] as number);
        draw();
        if (chainPowered(n, source, tiles).every(Boolean)) {
          won = true;
          ctx.done(`світять усі ${bulbs} лампочок`);
        }
      });
    });
  };
  draw();
  return undefined;
}

// ── Промінь ─────────────────────────────────────────────────────────────────────────────────

export function mountBeam(root: HTMLElement, p: BeamPuzzle, ctx: GameCtx): Cleanup {
  const { n } = p;
  const mirrors = new Map<number, Mirror>(p.mirrors);
  const size = 300;
  const cs = size / n;
  const ox = 26;
  const svg = svgRoot(root, size + ox, size);
  let won = false;
  const draw = () => {
    svg.replaceChildren();
    const { points, lit } = traceBeam(p, mirrors);
    ctx.say(
      `Повертай дзеркала, щоб промінь ліхтарика пройшов через усі сонячні панелі · заряджено ${lit.size} з ${p.panels.length}`,
    );
    for (let i = 0; i < n * n; i++)
      svgEl(
        "rect",
        {
          x: ox + (i % n) * cs + 2,
          y: Math.floor(i / n) * cs + 2,
          width: cs - 4,
          height: cs - 4,
          rx: 8,
          style: `fill:${TILE}`,
        },
        svg,
      );
    svgEl(
      "rect",
      { x: 2, y: (p.row + 0.5) * cs - 9, width: 20, height: 18, rx: 5, style: `fill:${TEXT}` },
      svg,
    );
    // the panels: a framed square with a cross of cells, lit while the beam runs through
    for (const cell of p.panels) {
      const x = ox + (cell % n) * cs + cs * 0.18;
      const y = Math.floor(cell / n) * cs + cs * 0.18;
      const s = cs * 0.64;
      const on = lit.has(cell);
      svgEl(
        "rect",
        {
          x,
          y,
          width: s,
          height: s,
          rx: 4,
          style: `fill:${on ? LIGHT : TILE};stroke:${on ? LIGHT : TEXT};stroke-width:2`,
        },
        svg,
      );
      svgEl(
        "path",
        {
          d: `M${x + s / 2} ${y + 2}V${y + s - 2}M${x + 2} ${y + s / 2}H${x + s - 2}`,
          style: `stroke:${on ? "#1a1208" : DIM};stroke-width:1.5`,
        },
        svg,
      );
    }
    svgEl(
      "polyline",
      {
        points: points.map(([a, b]) => `${ox + a * cs},${b * cs}`).join(" "),
        style: `fill:none;stroke:${LIGHT};stroke-width:4;stroke-linejoin:round;stroke-linecap:round;opacity:0.9`,
      },
      svg,
    );
    for (const [cell, m] of mirrors) {
      const x = ox + (cell % n) * cs;
      const y = Math.floor(cell / n) * cs;
      const a = cs * 0.22;
      const b = cs * 0.78;
      const g = svgEl("g", { class: "g-tap" }, svg);
      svgEl("rect", { x, y, width: cs, height: cs, style: "fill:transparent" }, g);
      const line =
        m === "/"
          ? { x1: x + a, y1: y + b, x2: x + b, y2: y + a }
          : { x1: x + a, y1: y + a, x2: x + b, y2: y + b };
      svgEl("line", { ...line, style: `stroke:${TEXT};stroke-width:5;stroke-linecap:round` }, g);
      g.addEventListener("click", () => {
        if (won) return;
        mirrors.set(cell, m === "/" ? "\\" : "/");
        draw();
        if (traceBeam(p, mirrors).hit) {
          won = true;
          ctx.done("усі панелі заряджаються");
        }
      });
    }
  };
  draw();
  return undefined;
}

// ── Розплутай дроти ─────────────────────────────────────────────────────────────────────────

export function mountUntangle(root: HTMLElement, p: UntanglePuzzle, ctx: GameCtx): Cleanup {
  const { size, edges } = p;
  const pos: Point[] = p.start.map((q) => ({ ...q }));
  const svg = svgRoot(root, size, size, "g-board-well g-drag");
  let drag = -1;
  let won = false;
  const draw = (): boolean => {
    svg.replaceChildren();
    const bad = crossingEdges(edges, pos);
    const solved = bad.size === 0;
    ctx.say(
      solved
        ? "Жодного перетину"
        : `Перетягуй коробки, доки дроти не перестануть перетинатися · перетинів: ${Math.ceil(bad.size / 2)}`,
    );
    edges.forEach(([a, b], i) => {
      const A = pos[a] as Point;
      const B = pos[b] as Point;
      svgEl(
        "line",
        {
          x1: A.x,
          y1: A.y,
          x2: B.x,
          y2: B.y,
          style: `stroke:${solved ? LIGHT : bad.has(i) ? BAD : DIM};stroke-width:3;stroke-linecap:round`,
        },
        svg,
      );
    });
    for (const q of pos)
      svgEl(
        "circle",
        {
          cx: q.x,
          cy: q.y,
          r: 12,
          style: `fill:var(--surface-2);stroke:${solved ? LIGHT : TEXT};stroke-width:2.5`,
        },
        svg,
      );
    return solved;
  };
  svg.addEventListener("pointerdown", (e) => {
    if (won) return;
    const [x, y] = pointIn(svg, e, size, size);
    let best = -1;
    let bestD = 26;
    pos.forEach((q, i) => {
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) return;
    drag = best;
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (drag < 0) return;
    const [x, y] = pointIn(svg, e, size, size);
    pos[drag] = {
      x: Math.min(size - 13, Math.max(13, x)),
      y: Math.min(size - 13, Math.max(13, y)),
    };
    draw();
  });
  const up = () => {
    if (drag < 0) return;
    drag = -1;
    if (draw() && !won) {
      won = true;
      ctx.done("дроти розплутано");
    }
  };
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
  draw();
  return undefined;
}

// ── Запобіжник ──────────────────────────────────────────────────────────────────────────────

/** A hit just off the zone's edge still counts: about the needle's own width on each side. */
const FUSE_EDGE = 0.015;
/**
 * The screen shows the needle a little late, so a tap counts where the needle was a moment ago
 * too — where the eye saw it when the finger went down.
 */
const FUSE_SEEN_MS = 70;

export function mountFuse(root: HTMLElement, p: FusePuzzle, ctx: GameCtx): Cleanup {
  const need = p.zones.length;
  const W = 300;
  const H = 180;
  const cx = 150;
  const cy = 165;
  const R = 128;
  const pt = (v: number, r: number): [number, number] => {
    const a = Math.PI - v * Math.PI;
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  };
  const arc = (v1: number, v2: number, r: number) => {
    const [x1, y1] = pt(v1, r);
    const [x2, y2] = pt(v2, r);
    return `M${x1},${y1} A${r},${r} 0 0 1 ${x2},${y2}`;
  };
  const svg = svgRoot(root, W, H, "g-tap g-fuse");
  const track = svgEl(
    "path",
    { d: arc(0, 1, R), style: `fill:none;stroke:${TILE};stroke-width:18;stroke-linecap:round` },
    svg,
  );
  const zone = svgEl("path", { d: "", style: `fill:none;stroke:${LIGHT};stroke-width:18` }, svg);
  const sparks = svgEl("g", {}, svg);
  const needle = svgEl(
    "line",
    {
      x1: cx,
      y1: cy,
      x2: cx,
      y2: cy - R,
      style: `stroke:${TEXT};stroke-width:4;stroke-linecap:round`,
    },
    svg,
  );
  svgEl("circle", { cx, cy, r: 8, style: `fill:${TEXT}` }, svg);
  // the run so far: one light per hit, all out (red) when the fuse burns
  const pips = document.createElement("div");
  pips.className = "g-pips";
  pips.setAttribute("aria-hidden", "true");
  for (let i = 0; i < need; i++) pips.appendChild(document.createElement("span"));
  root.appendChild(pips);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "g-btn g-btn-main";
  button.textContent = "Вставити запобіжник";
  root.appendChild(button);

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let hits = 0;
  let attempt = 1;
  let phase = p.phase;
  let last = performance.now();
  let v = 0;
  let alive = true;
  /** The fuse has just burnt: the needle stands still until the run starts over. */
  let burnt = false;
  let restart = 0;
  const show = (note?: string) => {
    ctx.say(
      `Тапни, коли стрілка в помаранчевій зоні: ${need} ${need >= 5 ? "разів" : "рази"} поспіль, без промаху · ${hits} з ${need}${attempt > 1 ? ` · спроба ${attempt}` : ""}${note ? ` · ${note}` : ""}`,
    );
    const z = p.zones[hits];
    zone.setAttribute("d", z ? arc(z[0], z[1], R) : "");
    pips.childNodes.forEach((pip, i) => {
      (pip as HTMLElement).toggleAttribute("data-on", i < hits);
    });
  };
  /** A miss: the fuse burns — red, a shake, sparks where the needle stood, a buzz — and over. */
  const blow = () => {
    burnt = true;
    button.disabled = true;
    navigator.vibrate?.([70, 40, 160]);
    track.setAttribute("style", `fill:none;stroke:${BAD};stroke-width:18;stroke-linecap:round`);
    zone.setAttribute("style", `fill:none;stroke:${BAD};stroke-width:18;opacity:0.5`);
    needle.setAttribute("style", `stroke:${BAD};stroke-width:4;stroke-linecap:round`);
    const [sx, sy] = pt(v, R);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.3;
      const r0 = 6 + (i % 3) * 2;
      const r1 = 16 + (i % 2) * 8;
      svgEl(
        "line",
        {
          x1: sx + Math.cos(a) * r0,
          y1: sy + Math.sin(a) * r0,
          x2: sx + Math.cos(a) * r1,
          y2: sy + Math.sin(a) * r1,
          class: "g-spark",
          style: `stroke:${i % 2 ? LIGHT : BAD};stroke-width:2.5;stroke-linecap:round`,
        },
        sparks,
      );
    }
    pips.setAttribute("data-blown", "");
    if (!reducedMotion) svg.classList.add("g-blown");
    ctx.say(
      "",
      `Запобіжник згорів! ${hits ? `Було ${hits} з ${need} поспіль — усе` : "Усе"} з початку`,
    );
    restart = window.setTimeout(() => {
      burnt = false;
      button.disabled = false;
      hits = 0;
      attempt++;
      seen.length = 0;
      track.setAttribute("style", `fill:none;stroke:${TILE};stroke-width:18;stroke-linecap:round`);
      zone.setAttribute("style", `fill:none;stroke:${LIGHT};stroke-width:18`);
      needle.setAttribute("style", `stroke:${TEXT};stroke-width:4;stroke-linecap:round`);
      sparks.replaceChildren();
      pips.removeAttribute("data-blown");
      svg.classList.remove("g-blown");
      last = performance.now();
      show();
    }, 1300);
  };
  /** Where the needle stood lately (time, place): a tap is judged by what was on screen. */
  const seen: { t: number; v: number }[] = [];
  const tap = () => {
    if (!alive || burnt) return;
    const [a, b] = p.zones[hits] as [number, number];
    const inside = (x: number) => x >= a - FUSE_EDGE && x <= b + FUSE_EDGE;
    const now = performance.now();
    if (!inside(v) && !seen.some((s) => now - s.t <= FUSE_SEEN_MS && inside(s.v))) {
      blow();
      return;
    }
    seen.length = 0; // the next zone is judged afresh
    hits++;
    navigator.vibrate?.(15);
    if (hits >= need) {
      alive = false;
      show();
      ctx.done(attempt === 1 ? "з першої спроби" : `зі спроби ${attempt}`);
      return;
    }
    show("є!");
  };
  // the finger coming down anywhere on the board inserts it — at once, not when it lifts, and
  // no need to reach for the button; the button still works from the keyboard
  const press = (e: PointerEvent) => {
    if (e.button === 0) tap();
  };
  const key = (e: MouseEvent) => {
    if (e.detail === 0) tap();
  };
  root.addEventListener("pointerdown", press);
  button.addEventListener("click", key);
  const tick = (now: number) => {
    if (!alive) return;
    const dt = (now - last) / 1000;
    last = now;
    if (!burnt) {
      phase += dt * p.speed * (1 + hits * FUSE_SPEEDUP);
      v = (1 - Math.cos(phase)) / 2;
      seen.push({ t: now, v });
      if (seen.length > 12) seen.shift();
      const [x, y] = pt(v, R - 14);
      needle.setAttribute("x2", String(x));
      needle.setAttribute("y2", String(y));
    }
    requestAnimationFrame(tick);
  };
  show();
  requestAnimationFrame(tick);
  return () => {
    alive = false;
    window.clearTimeout(restart);
    root.removeEventListener("pointerdown", press);
  };
}

// ── Кіт чи пес ──────────────────────────────────────────────────────────────────────────────

export function mountPets(root: HTMLElement, p: PetsPuzzle, ctx: GameCtx): Cleanup {
  const names = p.target === "cat" ? ["котів", "Собак і людей"] : ["собак", "Котів і людей"];
  const task = document.createElement("div");
  task.className = "g-task";
  task.innerHTML = `${icon(p.target, 26)}<span>Тапай лише ${names[0]}</span>`;
  root.appendChild(task);
  const grid = document.createElement("div");
  grid.className = "g-windows";
  root.appendChild(grid);
  const cells = [...Array(16).keys()].map((i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "g-window";
    b.setAttribute("aria-label", `Вікно ${i + 1}`);
    grid.appendChild(b);
    return b;
  });
  let index = -1;
  let active: { window: number; kind: PetsPuzzle["waves"][number][number]["kind"] }[] = [];
  let caught = 0;
  let lives = 3;
  let alive = true;
  let timer = 0;
  const status = (warn?: string) =>
    ctx.say(`${names[1]} не чіпай · ${caught} з ${p.need} · життя ${lives}/3`, warn);
  const paint = () => {
    cells.forEach((b, i) => {
      const s = active.find((x) => x.window === i);
      b.toggleAttribute("data-on", Boolean(s));
      b.innerHTML = s ? icon(s.kind, 30) : "";
    });
  };
  const finish = (ok: boolean, message: string) => {
    alive = false;
    window.clearTimeout(timer);
    active = [];
    paint();
    if (ok) ctx.done(message);
    else ctx.say(`${caught} з ${p.need}`, `${message} Почни спочатку`);
  };
  const next = () => {
    if (!alive) return;
    index++;
    const wave = p.waves[index];
    if (!wave) {
      finish(false, p.target === "cat" ? "Коти розбіглися." : "Собаки розбіглися.");
      return;
    }
    active = wave.map((s) => ({ ...s }));
    paint();
    timer = window.setTimeout(() => {
      active = [];
      paint();
      timer = window.setTimeout(next, p.gapMs);
    }, p.showMs);
  };
  cells.forEach((b, i) => {
    b.addEventListener("pointerdown", () => {
      if (!alive) return;
      const s = active.find((x) => x.window === i);
      if (!s) return;
      active = active.filter((x) => x !== s);
      paint();
      if (s.kind !== p.target) {
        lives--;
        status("не та тварина");
        if (lives <= 0) finish(false, "Забагато промахів.");
        return;
      }
      caught++;
      status();
      if (caught >= p.need) finish(true, lives === 3 ? "жодного промаху" : `життя ${lives}/3`);
    });
  });
  status();
  timer = window.setTimeout(next, 1100);
  return () => {
    alive = false;
    window.clearTimeout(timer);
  };
}

// ── Винеси генератор ────────────────────────────────────────────────────────────────────────

export function mountSlide(root: HTMLElement, p: SlidePuzzle, ctx: GameCtx): Cleanup {
  const { n, row } = p;
  const blocks: Block[] = p.blocks.map((b) => ({ ...b }));
  const size = 300;
  const cs = size / n;
  const vw = size + 14;
  const svg = svgRoot(root, vw, size, "g-drag");
  let moves = 0;
  let won = false;
  let drag: { bi: number; lo: number; hi: number; start: number; r0: number; c0: number } | null =
    null;
  const draw = () => {
    svg.replaceChildren();
    svgEl("rect", { x: 0, y: 0, width: size, height: size, rx: 14, style: `fill:${TILE}` }, svg);
    svgEl(
      "rect",
      { x: size + 2, y: row * cs + 6, width: 10, height: cs - 12, rx: 3, style: `fill:${LIGHT}` },
      svg,
    );
    for (const b of blocks)
      svgEl(
        "rect",
        {
          x: b.c * cs + 4,
          y: b.r * cs + 4,
          width: (b.h ? b.len : 1) * cs - 8,
          height: (b.h ? 1 : b.len) * cs - 8,
          rx: 9,
          style: `fill:${b.gen ? LIGHT : BOX}`,
        },
        svg,
      );
    ctx.say(
      `Посувай ящики й виштовхни помаранчевий генератор до виходу праворуч · ходів: ${moves}`,
    );
  };
  svg.addEventListener("pointerdown", (e) => {
    if (won) return;
    const [x, y] = pointIn(svg, e, vw, size);
    const c = Math.floor(x / cs);
    const r = Math.floor(y / cs);
    if (c < 0 || c >= n || r < 0 || r >= n) return;
    const bi = slideGrid(n, blocks)[r * n + c] as number;
    if (bi < 0) return;
    const b = blocks[bi] as Block;
    const g = slideGrid(n, blocks, bi);
    let lo = 0;
    let hi = 0;
    while (slideFits(n, g, b, b.r + (b.h ? 0 : lo - 1), b.c + (b.h ? lo - 1 : 0))) lo--;
    while (slideFits(n, g, b, b.r + (b.h ? 0 : hi + 1), b.c + (b.h ? hi + 1 : 0))) hi++;
    drag = { bi, lo, hi, start: b.h ? x : y, r0: b.r, c0: b.c };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [x, y] = pointIn(svg, e, vw, size);
    const b = blocks[drag.bi] as Block;
    const d = Math.max(drag.lo, Math.min(drag.hi, Math.round(((b.h ? x : y) - drag.start) / cs)));
    b.r = drag.r0 + (b.h ? 0 : d);
    b.c = drag.c0 + (b.h ? d : 0);
    draw();
  });
  const up = () => {
    if (!drag) return;
    const b = blocks[drag.bi] as Block;
    if (b.r !== drag.r0 || b.c !== drag.c0) moves++;
    drag = null;
    draw();
    if (!won && (blocks[0] as Block).c === n - 2) {
      won = true;
      ctx.done(`ходів: ${moves}`);
    }
  };
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
  draw();
  return undefined;
}

// ── Розклади заряд ──────────────────────────────────────────────────────────────────────────

export function mountCharge(root: HTMLElement, p: ChargePuzzle, ctx: GameCtx): Cleanup {
  const { banks } = p;
  const devices = p.devices.map((d) => ({ ...d, bank: -1, port: -1 }));
  const nb = banks.length;
  const W = 320;
  const H = 384;
  const bw = (W - (nb - 1) * 10) / nb;
  const bh = 104;
  const dw = 72;
  const dh = 70;
  const bankBox = banks.map((_, b) => ({ x: b * (bw + 10), y: 0, w: bw, h: bh }));
  const portAt = (b: number, i: number): [number, number] => {
    const r = bankBox[b] as { x: number; y: number };
    return [r.x + 10 + i * 22 + 10, r.y + bh - 8 - 8];
  };
  const devBox = devices.map((_, i) => {
    const inRow = i < 4 ? Math.min(4, devices.length) : devices.length - 4;
    const ix = i < 4 ? i : i - 4;
    const rw = inRow * dw + (inRow - 1) * 8;
    return { x: (W - rw) / 2 + ix * (dw + 8), y: i < 4 ? 206 : 294 };
  });
  const plug = (i: number): [number, number] => {
    const r = devBox[i] as { x: number; y: number };
    return [r.x + dw / 2, r.y];
  };
  // The board is laid out in fixed pixels and scaled down whole to the room there is: on a phone
  // the card is narrower than W, and cutting the layout would push the banks and devices out of it.
  const fit = document.createElement("div");
  fit.className = "g-charge-fit";
  root.appendChild(fit);
  const wrap = document.createElement("div");
  wrap.className = "g-charge";
  wrap.style.width = `${W}px`;
  wrap.style.height = `${H}px`;
  fit.appendChild(wrap);
  const scaleToFit = () => {
    // as wide as the card allows, as tall as the screen does (the room the game screen measured)
    const room = Number.parseFloat(root.style.getPropertyValue("--board-room")) || H;
    const k = Math.min(1, root.clientWidth / W, room / H);
    fit.style.width = `${W * k}px`;
    fit.style.height = `${H * k}px`;
    wrap.style.transform = k < 1 ? `scale(${k})` : "";
  };
  const resize = new ResizeObserver(scaleToFit);
  resize.observe(root);
  scaleToFit();
  const bankLayer = document.createElement("div");
  const devLayer = document.createElement("div");
  wrap.append(bankLayer, devLayer);
  const cables = svgEl("svg", { width: W, height: H, class: "g-cables" }, wrap);

  let drag: { i: number; x: number; y: number; over: number } | null = null;
  let warn = "";
  let won = false;
  const used = (b: number) => devices.reduce((s, d) => s + (d.bank === b ? d.need : 0), 0);
  const freePort = (b: number, usbC: boolean) => {
    const taken = new Set(devices.filter((d) => d.bank === b).map((d) => d.port));
    const ports = (banks[b] as ChargePuzzle["banks"][number]).ports;
    const open = [...ports.keys()].filter((i) => !taken.has(i));
    if (usbC) return open.find((i) => ports[i] === "C") ?? -1;
    return open.find((i) => ports[i] === "A") ?? open[0] ?? -1;
  };
  const reason = (b: number, d: (typeof devices)[number]) => {
    const bank = banks[b] as ChargePuzzle["banks"][number];
    const left = bank.cap - used(b);
    if (left < d.need)
      return `у павербанку ${bank.name} лишилось ${left} Вт·год, а треба ${d.need}`;
    if (freePort(b, d.usbC) < 0)
      return d.usbC
        ? `у павербанку ${bank.name} немає вільного USB-C`
        : `у павербанку ${bank.name} немає вільного порту`;
    return "";
  };
  const bankAt = (x: number, y: number) =>
    bankBox.findIndex((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  const local = (e: PointerEvent): [number, number] => {
    const r = wrap.getBoundingClientRect();
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height];
  };
  const curve = ([x1, y1]: [number, number], [x2, y2]: [number, number]) =>
    `M${x1},${y1} C${x1},${y1 - 70} ${x2},${y2 + 70} ${x2},${y2}`;

  const render = () => {
    const over = drag ? drag.over : -1;
    const held = drag ? devices[drag.i] : undefined;
    const overWhy = over >= 0 && held ? reason(over, held) : "";
    ctx.say(
      "Тягни кабель від пристрою до павербанка. Ноутбук і планшет — лише в USB-C. Тап по пристрою від'єднує",
      warn || undefined,
    );
    bankLayer.innerHTML = banks
      .map((bank, b) => {
        const r = bankBox[b] as { x: number; y: number; w: number; h: number };
        const left = bank.cap - used(b);
        const color = BANK_COLORS[b] as string;
        const taken = new Set(devices.filter((d) => d.bank === b).map((d) => d.port));
        const text =
          over === b && held && !overWhy
            ? `${left} → ${left - held.need} Вт·год`
            : `${left} з ${bank.cap} Вт·год`;
        const ring = over === b ? (overWhy ? "bad" : "ok") : "";
        return `<div class="g-bank" data-ring="${ring}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;--bank:${color}">
          <div class="g-bank-name">${icon("bank", 16)}${nb > 2 ? "" : "Павербанк "}${bank.name}</div>
          <div class="g-bank-left">${text}</div>
          <div class="g-bank-bar"><div style="width:${Math.round((left / bank.cap) * 100)}%"></div></div>
          ${bank.ports.map((port, i) => `<span class="g-port" data-used="${taken.has(i)}" style="left:${10 + i * 22}px">${port}</span>`).join("")}
        </div>`;
      })
      .join("");
    devLayer.innerHTML = devices
      .map((d, i) => {
        const r = devBox[i] as { x: number; y: number };
        const color = d.bank >= 0 ? (BANK_COLORS[d.bank] as string) : "";
        return `<div class="g-device" data-d="${i}" style="left:${r.x}px;top:${r.y}px;width:${dw}px;height:${dh}px;${color ? `--bank:${color}` : ""}" data-on="${d.bank >= 0}">
          ${icon(d.kind as GameIcon, 22)}<span>${d.name}</span><span class="g-muted">${d.need} Вт·год${d.usbC ? " · C" : ""}</span></div>`;
      })
      .join("");
    cables.replaceChildren();
    devices.forEach((d, i) => {
      if (d.bank < 0) return;
      svgEl(
        "path",
        {
          d: curve(plug(i), portAt(d.bank, d.port)),
          style: `fill:none;stroke:${BANK_COLORS[d.bank]};stroke-width:${won ? 5 : 3.5};stroke-linecap:round`,
        },
        cables,
      );
    });
    if (drag) {
      const color = over >= 0 ? (overWhy ? BAD : (BANK_COLORS[over] as string)) : TEXT;
      svgEl(
        "path",
        {
          d: curve(plug(drag.i), [drag.x, drag.y]),
          style: `fill:none;stroke:${color};stroke-width:3.5;stroke-linecap:round;stroke-dasharray:${over >= 0 && !overWhy ? "none" : "6 5"}`,
        },
        cables,
      );
    }
    devices.forEach((d, i) => {
      const [x, y] = plug(i);
      const color = d.bank >= 0 ? (BANK_COLORS[d.bank] as string) : "var(--surface-2)";
      svgEl(
        "circle",
        {
          cx: x,
          cy: y,
          r: 6,
          style: `fill:${color};stroke:${d.bank >= 0 ? color : TEXT};stroke-width:2`,
        },
        cables,
      );
    });
  };

  wrap.addEventListener("pointerdown", (e) => {
    if (won) return;
    const target = (e.target as Element).closest("[data-d]");
    if (!target) return;
    e.preventDefault();
    const i = Number(target.getAttribute("data-d"));
    const d = devices[i];
    if (!d) return;
    d.bank = -1;
    d.port = -1;
    warn = "";
    const [x, y] = local(e);
    drag = { i, x, y, over: -1 };
    wrap.setPointerCapture(e.pointerId);
    render();
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [x, y] = local(e);
    drag.x = x;
    drag.y = y;
    drag.over = bankAt(x, y);
    render();
  });
  const up = () => {
    if (!drag) return;
    const d = devices[drag.i];
    const b = drag.over;
    if (d && b >= 0) {
      const why = reason(b, d);
      if (why) warn = why.charAt(0).toUpperCase() + why.slice(1);
      else {
        d.bank = b;
        d.port = freePort(b, d.usbC);
        warn = "";
      }
    }
    drag = null;
    if (devices.every((x) => x.bank >= 0)) {
      won = true;
      render();
      const rest = banks.reduce((s, bank, k) => s + bank.cap - used(k), 0);
      ctx.done(rest ? `усе заряджається, залишок ${rest} Вт·год` : "усе заряджається, до краплі");
      return;
    }
    render();
  };
  wrap.addEventListener("pointerup", up);
  wrap.addEventListener("pointercancel", () => {
    drag = null;
    render();
  });
  render();
  return () => resize.disconnect();
}

// ── Тривожна валізка ────────────────────────────────────────────────────────────────────────

const ITEM_COLORS = ["#ff9a3d", "#8fa3c8", "#d9b86a", "#7cc6a0", "#e2807a", "#b99ad8", "#6cc0c0"];
const INK = "#1a1208";

/** An icon drawn into the board's SVG, centred on (cx, cy). */
function svgIcon(parent: Element, name: GameIcon, cx: number, cy: number, size: number) {
  const s = svgEl(
    "svg",
    {
      x: cx - size / 2,
      y: cy - size / 2,
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: INK,
      "stroke-width": 1.9,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "pointer-events": "none",
    },
    parent,
  );
  s.innerHTML = iconPaths(name);
}

export function mountPack(root: HTMLElement, p: PackPuzzle, ctx: GameCtx): Cleanup {
  const { w, h } = p;
  const bag = new Set(p.bag);
  const items = p.pieces.map((piece, i) => ({
    kind: piece.kind,
    cells: piece.cells.map(([r, c]) => [r, c] as [number, number]),
    at: null as { r: number; c: number } | null,
    color: ITEM_COLORS[i % ITEM_COLORS.length] as string,
  }));
  type Item = (typeof items)[number];
  const vw = 320;
  const cs = Math.min(48, Math.floor(296 / w));
  const bx = (vw - w * cs) / 2;
  const by = 6;
  // next to the bag every item has its own square slot, big enough whichever way it is turned
  const ts = Math.round(cs * 0.6);
  const { slots, vh } = (() => {
    const out: { x: number; y: number; side: number }[] = [];
    let x = 8;
    let y = by + h * cs + 20;
    let rowH = 0;
    for (const it of items) {
      const side = (Math.max(...it.cells.map(([r]) => r), ...it.cells.map(([, c]) => c)) + 1) * ts;
      if (x + side > vw - 8) {
        x = 8;
        y += rowH + 12;
        rowH = 0;
      }
      out.push({ x, y, side });
      x += side + 12;
      rowH = Math.max(rowH, side);
    }
    return { slots: out, vh: y + rowH + 6 };
  })();
  const svg = svgRoot(root, vw, vh, "g-drag");
  /** Where an item lying next to the bag starts: centred in its slot. */
  const slotOrigin = (i: number): [number, number] => {
    const it = items[i] as Item;
    const slot = slots[i] as { x: number; y: number; side: number };
    const iw = (Math.max(...it.cells.map(([, c]) => c)) + 1) * ts;
    const ih = (Math.max(...it.cells.map(([r]) => r)) + 1) * ts;
    return [slot.x + (slot.side - iw) / 2, slot.y + (slot.side - ih) / 2];
  };
  /** Bag cells an item fills now (none while it lies outside). */
  const filling = (o: Item): number[] => {
    const at = o.at;
    return at ? o.cells.map(([r, c]) => (at.r + r) * w + at.c + c) : [];
  };
  const taken = (cell: number, except: Item) =>
    items.some((o) => o !== except && filling(o).includes(cell));
  const fits = (it: Item, cells: [number, number][], at: { r: number; c: number }) =>
    cells.every(([r, c]) => {
      const rr = at.r + r;
      const cc = at.c + c;
      return (
        rr >= 0 && rr < h && cc >= 0 && cc < w && bag.has(rr * w + cc) && !taken(rr * w + cc, it)
      );
    });
  const packed = () => items.reduce((n, it) => n + (it.at ? it.cells.length : 0), 0) === bag.size;

  let drag: {
    i: number;
    gx: number;
    gy: number;
    x: number;
    y: number;
    sx: number;
    sy: number;
    moved: boolean;
  } | null = null;
  let won = false;

  const drawItem = (it: Item, x: number, y: number, s: number, lifted = false) => {
    const g = svgEl("g", { style: lifted ? "opacity:0.92" : "" }, svg);
    for (const [r, c] of it.cells)
      svgEl(
        "rect",
        {
          x: x + c * s + 1.5,
          y: y + r * s + 1.5,
          width: s - 3,
          height: s - 3,
          rx: s * 0.2,
          style: `fill:${it.color}`,
        },
        g,
      );
    // the cell nearest the middle carries the item's icon
    const mr = it.cells.reduce((a, [r]) => a + r, 0) / it.cells.length;
    const mc = it.cells.reduce((a, [, c]) => a + c, 0) / it.cells.length;
    const [ir, ic] = it.cells.reduce((best, cell) =>
      (cell[0] - mr) ** 2 + (cell[1] - mc) ** 2 < (best[0] - mr) ** 2 + (best[1] - mc) ** 2
        ? cell
        : best,
    );
    svgIcon(g, it.kind as GameIcon, x + (ic + 0.5) * s, y + (ir + 0.5) * s, s * 0.62);
  };

  const draw = () => {
    svg.replaceChildren();
    const inside = items.filter((it) => it.at).length;
    ctx.say(
      `Склади всі речі в рюкзак без щілин: тягни річ, тап повертає її · у рюкзаку ${inside} з ${items.length}`,
    );
    for (const cell of bag)
      svgEl(
        "rect",
        {
          x: bx + (cell % w) * cs + 1.5,
          y: by + Math.floor(cell / w) * cs + 1.5,
          width: cs - 3,
          height: cs - 3,
          rx: 7,
          style: `fill:${TILE}`,
        },
        svg,
      );
    items.forEach((it, i) => {
      if (drag?.i === i && drag.moved) return;
      if (it.at) drawItem(it, bx + it.at.c * cs, by + it.at.r * cs, cs);
      else {
        const [x, y] = slotOrigin(i);
        drawItem(it, x, y, ts);
      }
    });
    if (drag?.moved) {
      const it = items[drag.i] as Item;
      drawItem(it, drag.x - drag.gx * cs, drag.y - drag.gy * cs, cs, true);
    }
  };

  /** The item under the finger and where on it, in its own cells. */
  const itemAt = (x: number, y: number) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i] as Item;
      const [ox, oy, s] = it.at
        ? [bx + it.at.c * cs, by + it.at.r * cs, cs]
        : [...slotOrigin(i), ts];
      const gx = (x - ox) / s;
      const gy = (y - oy) / s;
      if (it.cells.some(([r, c]) => gx >= c && gx < c + 1 && gy >= r && gy < r + 1))
        return { i, gx, gy };
    }
    return null;
  };

  svg.addEventListener("pointerdown", (e) => {
    if (won) return;
    const [x, y] = pointIn(svg, e, vw, vh);
    const hit = itemAt(x, y);
    if (!hit) return;
    drag = { ...hit, x, y, sx: x, sy: y, moved: false };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [x, y] = pointIn(svg, e, vw, vh);
    drag.x = x;
    drag.y = y;
    if (!drag.moved && Math.hypot(x - drag.sx, y - drag.sy) > 6) drag.moved = true;
    if (drag.moved) draw();
  });
  const up = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    const it = items[d.i] as Item;
    if (!d.moved) {
      // a tap turns it; in the bag, round the cell under the finger, else back out of it
      const raw = it.cells.map(([r, c]) => [c, -r] as [number, number]);
      const r0 = Math.min(...raw.map(([r]) => r));
      const c0 = Math.min(...raw.map(([, c]) => c));
      const cells = raw.map(([r, c]) => [r - r0, c - c0] as [number, number]);
      if (it.at) {
        const gr = Math.floor(d.gy);
        const gc = Math.floor(d.gx);
        const at = { r: it.at.r + gr - (gc - r0), c: it.at.c + gc - (-gr - c0) };
        it.at = fits(it, cells, at) ? at : null;
      }
      it.cells = cells;
    } else {
      const at = {
        r: Math.round((d.y - d.gy * cs - by) / cs),
        c: Math.round((d.x - d.gx * cs - bx) / cs),
      };
      it.at = fits(it, it.cells, at) ? at : null;
    }
    draw();
    if (!won && packed()) {
      won = true;
      ctx.done("усе влізло");
    }
  };
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", () => {
    drag = null;
    draw();
  });
  draw();
  return undefined;
}

// ── Батарейки по зарядках ───────────────────────────────────────────────────────────────────

const BATTERY_COLORS = ["#ff9a3d", "#8fa3c8", "#7cc6a0", "#e2807a", "#b99ad8"];

export function mountBatteries(root: HTMLElement, p: BatteryPuzzle, ctx: GameCtx): Cleanup {
  const stacks = p.stacks.map((s) => [...s]);
  const k = stacks.length;
  const vw = 320;
  const gap = 8;
  const tw = Math.min(54, (vw - gap * (k + 1)) / k);
  const left = (vw - (k * tw + (k - 1) * gap)) / 2;
  const slot = 30;
  const lift = 36;
  const th = p.cap * slot + 16;
  const vh = lift + th + 4;
  // touch-action none: a drag moves batteries instead of scrolling the page
  const svg = svgRoot(root, vw, vh, "g-drag");
  /** The charger whose top batteries are lifted (by a tap, or held while dragging). */
  let pick: number | null = null;
  /** A drag under way: the finger, and whether it has moved enough to be one. */
  let drag: { x: number; y: number; sx: number; sy: number; moved: boolean; held: boolean } | null =
    null;
  let moves = 0;
  let won = false;
  const tubeAt = (x: number): number => {
    const i = Math.floor((x - left + gap / 2) / (tw + gap));
    return i >= 0 && i < k ? i : -1;
  };
  /** Pour the lifted batteries onto charger `to`; false when they cannot go there. */
  const pour = (from: number, to: number): boolean => {
    const n = batteryPour(stacks, from, to);
    if (n === 0) return false;
    const source = stacks[from] as number[];
    (stacks[to] as number[]).push(...source.splice(source.length - n, n));
    moves++;
    return true;
  };
  /** How many of the same kind lie on top. */
  const topRun = (s: readonly number[]) => {
    let run = s.length ? 1 : 0;
    while (run < s.length && s[s.length - 1 - run] === s[s.length - 1]) run++;
    return run;
  };
  const battery = (x: number, y: number, bw: number, bh: number, kind: number) => {
    const color = BATTERY_COLORS[kind] as string;
    svgEl("rect", { x, y, width: bw - 4, height: bh, rx: 6, style: `fill:${color}` }, svg);
    svgEl(
      "rect",
      {
        x: x + bw - 5,
        y: y + bh * 0.3,
        width: 5,
        height: bh * 0.4,
        rx: 1.5,
        style: `fill:${color}`,
      },
      svg,
    );
    const label = svgEl(
      "text",
      {
        x: x + (bw - 4) / 2,
        y: y + bh / 2 + 4,
        "text-anchor": "middle",
        style: `fill:${INK};font:700 11px Manrope Variable, sans-serif`,
      },
      svg,
    );
    label.textContent = BATTERY_KINDS[kind] ?? "";
  };
  const draw = () => {
    svg.replaceChildren();
    ctx.say(
      `Розклади батарейки так, щоб у кожній зарядці був один тип: перетягни або тапни звідки й куди · ходів: ${moves}`,
    );
    const flying = drag?.moved && pick !== null;
    // while dragging, the charger under the finger says whether they can go there
    const over = flying && drag ? tubeAt(drag.x) : -1;
    const fits = over >= 0 && pick !== null && over !== pick && batteryPour(stacks, pick, over) > 0;
    stacks.forEach((s, i) => {
      const x = left + i * (tw + gap);
      const ring =
        i === over && i !== pick
          ? fits
            ? LIGHT
            : BAD
          : pick === i && !flying
            ? LIGHT
            : "transparent";
      svgEl(
        "rect",
        {
          x,
          y: lift,
          width: tw,
          height: th,
          rx: 12,
          style: `fill:${TILE};stroke:${ring};stroke-width:2`,
        },
        svg,
      );
      svgEl(
        "rect",
        {
          x: x + tw * 0.3,
          y: lift + th - 7,
          width: tw * 0.4,
          height: 3,
          rx: 1.5,
          style: `fill:${DIM}`,
        },
        svg,
      );
      const run = pick === i ? topRun(s) : 0;
      s.forEach((kind, j) => {
        const lifted = j >= s.length - run;
        if (lifted && flying) return; // they are under the finger
        const up = lifted ? lift - 4 : 0; // the picked ones rise out of the charger
        battery(x + 5, lift + th - 12 - (j + 1) * slot + 3 - up, tw - 10, slot - 5, kind);
      });
    });
    if (flying && drag && pick !== null) {
      // the lifted batteries ride under the finger, a little above it so it does not hide them
      const s = stacks[pick] as number[];
      const run = topRun(s);
      for (let j = 0; j < run; j++)
        battery(
          drag.x - (tw - 10) / 2,
          drag.y - 22 - (j + 1) * slot + 3,
          tw - 10,
          slot - 5,
          s[s.length - 1] as number,
        );
    }
  };
  const settle = () => {
    draw();
    if (!won && batterySorted(stacks)) {
      won = true;
      ctx.done(`ходів: ${moves}`);
    }
  };
  svg.addEventListener("pointerdown", (e) => {
    if (won) return;
    const [x, y] = pointIn(svg, e, vw, vh);
    const i = tubeAt(x);
    if (i < 0) return;
    // batteries already lifted by a tap go to the charger tapped next; when they cannot, that
    // charger's own batteries are taken instead (and can be dragged at once)
    if (pick !== null && pick !== i) {
      const poured = pour(pick, i);
      pick = null;
      if (poured || (stacks[i] as number[]).length === 0) {
        settle();
        return;
      }
    }
    if ((stacks[i] as number[]).length === 0) return;
    drag = { x, y, sx: x, sy: y, moved: false, held: pick === i };
    pick = i;
    svg.setPointerCapture(e.pointerId);
    draw();
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [x, y] = pointIn(svg, e, vw, vh);
    drag.x = x;
    drag.y = y;
    if (!drag.moved && Math.hypot(x - drag.sx, y - drag.sy) > 8) drag.moved = true;
    if (drag.moved) draw();
  });
  svg.addEventListener("pointerup", (e) => {
    if (!drag || pick === null) return;
    const d = drag;
    drag = null;
    if (d.moved) {
      // let go over another charger: they go there if they can; anywhere else they drop back
      const to = tubeAt(pointIn(svg, e, vw, vh)[0]);
      if (to >= 0 && to !== pick) pour(pick, to);
      pick = null;
    } else if (d.held) pick = null; // a second tap puts them back
    settle();
  });
  svg.addEventListener("pointercancel", () => {
    drag = null;
    pick = null;
    draw();
  });
  draw();
  return undefined;
}
