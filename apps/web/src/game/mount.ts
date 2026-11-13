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
  JIGSAW_SIZE,
  type JigsawPuzzle,
  jigsawEdge,
  jigsawGroup,
  jigsawOutline,
  type MemoPuzzle,
  type MinePuzzle,
  type Mirror,
  mineAround,
  mineCount,
  mineLay,
  mineOpen,
  type PackPuzzle,
  type PetsPuzzle,
  type Point,
  rotate,
  type SlidePuzzle,
  SNAKE_CLEAR,
  SNAKE_DIRS,
  type SnakePuzzle,
  type SparkPuzzle,
  STORE_LEVELS,
  STORE_NAMES,
  type StoreItem,
  type StorePuzzle,
  type SudokuPuzzle,
  slideFits,
  slideGrid,
  snakeSpot,
  snakeStart,
  snakeStep,
  sparkDistance,
  sparkPath,
  sparkSnap,
  storeHand,
  storeMerge,
  storeStart,
  storeStuck,
  traceBeam,
  type UntanglePuzzle,
  type VoltBlock,
  type VoltPuzzle,
  voltTrace,
  voltTurns,
} from "./puzzles.ts";
import { rngOf } from "./rng.ts";

export type GameCtx = {
  /** The line above the board; `warn` is shown after it in red. */
  say(text: string, warn?: string): void;
  done(note: string): void;
  /** The board changed its height: fit it to the screen again. */
  fit?(): void;
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
  // won only when every tile is lit, not the bulbs alone: the line says so
  ctx.say("Повертай плитки, щоб струм від батареї засвітив усі дроти й лампочки");
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
  const show = () => {
    ctx.say(
      `Тапни, коли стрілка в помаранчевій зоні: ${need} ${need >= 5 ? "разів" : "рази"} поспіль, без промаху · ${hits} з ${need}${attempt > 1 ? ` · спроба ${attempt}` : ""}`,
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
      foldAway([button], ctx);
      ctx.done(attempt === 1 ? "з першої спроби" : `зі спроби ${attempt}`);
      return;
    }
    show();
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

/** An icon drawn into the board's SVG, centred on (cx, cy), in `ink`. */
function svgIcon(
  parent: Element,
  name: GameIcon,
  cx: number,
  cy: number,
  size: number,
  ink: string = INK,
) {
  const s = svgEl(
    "svg",
    {
      x: cx - size / 2,
      y: cy - size / 2,
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: ink,
      "stroke-width": 1.9,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "pointer-events": "none",
    },
    parent,
  );
  s.innerHTML = iconPaths(name);
}

/**
 * Next to a board every piece has its own square slot, big enough whichever way it is turned, in
 * rows from `top`; the slots, and the height of it all.
 */
function shelfOf(
  shapes: readonly (readonly (readonly [number, number])[])[],
  vw: number,
  top: number,
  ts: number,
) {
  const slots: { x: number; y: number; side: number }[] = [];
  let x = 8;
  let y = top;
  let rowH = 0;
  for (const cells of shapes) {
    const side = (Math.max(...cells.map(([r]) => r), ...cells.map(([, c]) => c)) + 1) * ts;
    if (x + side > vw - 8) {
      x = 8;
      y += rowH + 12;
      rowH = 0;
    }
    slots.push({ x, y, side });
    x += side + 12;
    rowH = Math.max(rowH, side);
  }
  return { slots, vh: y + rowH + 6 };
}

/**
 * Solved: the shelf under the board folds away (the SVG's view from `from` high to `to`), so what
 * comes after is in reach without scrolling past it; the screen then fits the board again. Returns
 * the cancel for the cleanup.
 */
function foldShelf(svg: SVGSVGElement, vw: number, from: number, to: number, ctx: GameCtx) {
  let raf = 0;
  const set = (height: number) => {
    svg.setAttribute("viewBox", `0 0 ${vw} ${height}`);
    svg.setAttribute("height", String(height));
  };
  const still =
    document.hidden || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  if (still) {
    set(to);
    ctx.fit?.();
    return () => {};
  }
  const t0 = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / 420);
    set(from + (to - from) * (1 - (1 - k) ** 3));
    if (k < 1) raf = requestAnimationFrame(step);
    else ctx.fit?.();
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

/**
 * Solved: controls under a board that are no use any more (a pad, a button) fold away, their
 * height down to nothing, so what comes after is in reach without scrolling past them; then the
 * screen fits the board again.
 */
function foldAway(els: HTMLElement[], ctx: GameCtx) {
  const still =
    document.hidden || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  for (const el of els) {
    if (still) {
      el.style.display = "none";
      continue;
    }
    el.style.overflow = "hidden";
    el.style.height = `${el.offsetHeight}px`;
    el.style.transition = "height 0.42s cubic-bezier(0.2, 0.7, 0.3, 1), opacity 0.3s ease";
    void el.offsetHeight;
    el.style.height = "0px";
    el.style.opacity = "0";
    el.addEventListener(
      "transitionend",
      () => {
        el.style.display = "none";
        ctx.fit?.();
      },
      { once: true },
    );
  }
  if (still) ctx.fit?.();
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
  const { slots, vh } = shelfOf(
    items.map((it) => it.cells),
    vw,
    by + h * cs + 20,
    ts,
  );
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
      // all packed: the shelf under the bag folds away
      unfold = foldShelf(svg, vw, vh, by + h * cs + 6, ctx);
      ctx.done("усе влізло");
    }
  };
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", () => {
    drag = null;
    draw();
  });
  let unfold = () => {};

  draw();
  return () => unfold();
}

// ── Точна напруга ───────────────────────────────────────────────────────────────────────────

/** Numbered blocks: fixed ones flat and bolted, those one lays raised; adding warm, taking cool. */
const FIX_PLUS = "#3a2e1f";
const FIX_MINUS = "#1f2938";
const MOVE_PLUS = "#5b4627";
const MOVE_MINUS = "#2d3f5a";
/** A wire the current does not run through. */
const WIRE_OFF = "rgba(242, 239, 234, 0.45)";
/** The sparks of the current running along the wire. */
const SPARK = "#fff3d6";
const PILLAR = "#0f1013";
const SOURCE_CELL = "#4a3218";

/** A minus as on the blocks, not a hyphen. */
const volts = (v: number) => (v < 0 ? `−${-v}` : String(v));
/** A block's number, with its sign. */
const signed = (v: number) => (v > 0 ? `+${v}` : volts(v));

export function mountVolt(root: HTMLElement, p: VoltPuzzle, ctx: GameCtx): Cleanup {
  const { n, cells, target } = p;
  /** The blocks one gets: as turned now, and the cell each lies on (null: next to the board). */
  const blocks = p.blocks.map((b) => ({
    ports: b.ports,
    value: b.value,
    at: null as number | null,
  }));
  let won = false;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  // over the board, two plates: what the current carries now, and what the lamp needs
  const meters = document.createElement("div");
  meters.className = "g-volt-meters";
  const nowPlate = document.createElement("div");
  nowPlate.className = "g-volt-meter";
  nowPlate.setAttribute("aria-live", "polite");
  const needPlate = document.createElement("div");
  needPlate.className = "g-volt-meter";
  needPlate.dataset.need = "";
  needPlate.innerHTML = `<span class="g-volt-label">Потрібно</span><b class="g-volt-value">${volts(target)} В</b>`;
  meters.append(nowPlate, needPlate);
  root.appendChild(meters);

  const vw = 320;
  const cs = Math.min(54, Math.floor((vw - 8) / n));
  const ox = (vw - n * cs) / 2;
  const oy = 4;
  // under the board, each block one gets has its own place
  const ts = 44;
  const gap = 8;
  const perRow = Math.floor((vw - 8 + gap) / (ts + gap));
  const rows = Math.ceil(blocks.length / perRow);
  const trayY = oy + n * cs + 16;
  const slot = (i: number): [number, number] => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, blocks.length - row * perRow);
    const x0 = (vw - (inRow * ts + (inRow - 1) * gap)) / 2;
    return [x0 + (i % perRow) * (ts + gap), trayY + row * (ts + gap)];
  };
  const vh = trayY + rows * (ts + gap) + 4;
  const svg = svgRoot(root, vw, vh, "g-drag");
  const line = Math.max(3, cs * 0.13);
  /** A block carried is drawn above the finger, so the finger does not hide it. */
  const lift = cs * 0.7;

  /** The blocks on the board, but those `skip` leaves out: cell → the block there. */
  const laid = (skip?: (i: number) => boolean) => {
    const out = new Map<number, VoltBlock>();
    blocks.forEach((b, i) => {
      if (b.at !== null && !skip?.(i)) out.set(b.at, { ports: b.ports, value: b.value });
    });
    return out;
  };
  const cellAt = (x: number, y: number) => {
    const c = Math.floor((x - ox) / cs);
    const r = Math.floor((y - oy) / cs);
    return c < 0 || r < 0 || c >= n || r >= n ? -1 : r * n + c;
  };
  const centre = (i: number): [number, number] => [
    ox + ((i % n) + 0.5) * cs,
    oy + (Math.floor(i / n) + 0.5) * cs,
  ];
  const text = (
    parent: Element,
    x: number,
    y: number,
    value: string,
    size: number,
    color: string,
  ) => {
    const t = svgEl(
      "text",
      {
        x,
        y: y + size * 0.36,
        "text-anchor": "middle",
        style: `fill:${color};font:800 ${size}px Manrope Variable, sans-serif`,
      },
      parent,
    );
    t.textContent = value;
  };

  /**
   * A numbered block: its wire comes in from each side it joins to the number in the middle. A
   * fixed one lies flat, bolted down; one laid stands raised.
   */
  const drawBlock = (
    x: number,
    y: number,
    s: number,
    ports: number,
    value: number,
    color: string,
    fixed: boolean,
    extra = "",
    /** How far the wire reaches out: to the edge on the board, short of it off the board. */
    reach = 0.5,
  ) => {
    const g = svgEl("g", { style: extra }, svg);
    const fill = fixed ? (value > 0 ? FIX_PLUS : FIX_MINUS) : value > 0 ? MOVE_PLUS : MOVE_MINUS;
    svgEl(
      "rect",
      {
        x: x + 2,
        y: y + 2,
        width: s - 4,
        height: s - 4,
        rx: s * 0.18,
        style: fixed
          ? `fill:${fill}`
          : `fill:${fill};stroke:rgba(255, 255, 255, 0.2);stroke-width:1.5`,
      },
      g,
    );
    if (fixed)
      for (const [bx, by] of [
        [0.16, 0.16],
        [0.84, 0.16],
        [0.16, 0.84],
        [0.84, 0.84],
      ] as const)
        svgEl(
          "circle",
          {
            cx: x + bx * s,
            cy: y + by * s,
            r: Math.max(1.5, s * 0.035),
            style: "fill:rgba(255,255,255,0.28)",
          },
          g,
        );
    const cx = x + s / 2;
    const cy = y + s / 2;
    for (const [dx, dy, bit] of DIRS)
      if (ports & bit)
        svgEl(
          "line",
          {
            x1: cx + dx * s * 0.27,
            y1: cy + dy * s * 0.27,
            x2: cx + dx * s * reach,
            y2: cy + dy * s * reach,
            style: `stroke:${color};stroke-width:${Math.max(3, s * 0.13)};stroke-linecap:round`,
          },
          g,
        );
    text(g, cx, cy, signed(value), Math.max(13, Math.round(s * 0.36)), TEXT);
    return g;
  };

  let drag: {
    i: number;
    x: number;
    y: number;
    sx: number;
    sy: number;
    moved: boolean;
  } | null = null;
  /** Where a block carried would land: a free cell (another block there goes back), else -1. */
  const landing = (x: number, y: number) => {
    const cell = cellAt(x, y - lift);
    return cell >= 0 && cells[cell]?.kind === "free" ? cell : -1;
  };

  const draw = () => {
    svg.replaceChildren();
    const on = laid();
    const t = voltTrace(p, on);
    const ok = t.lit && t.sum === target;
    const path = new Set(t.path);
    // the plates: under what is needed, over it, even (not yet at the lamp), the lamp alight
    const state = ok ? "ok" : t.sum < target ? "low" : t.sum > target ? "high" : "even";
    nowPlate.dataset.state = state;
    const say = {
      ok: "лампа світить",
      low: "менше, ніж потрібно",
      high: "більше, ніж потрібно",
      even: "рівно, ще до лампи",
    }[state];
    const arrow = { ok: "✓", low: "▼", high: "▲", even: "=" }[state];
    nowPlate.innerHTML = `<span class="g-volt-label">Зараз</span><b class="g-volt-value">${volts(t.sum)} В</b><span class="g-volt-arrow" aria-hidden="true">${arrow}</span><span class="sr-only">${say}</span>`;
    ctx.say(
      "Обери блоки з числами й прокладай дріт від генератора до лампи · тап повертає блок, винеси за поле — прибереш",
      t.lit && !ok ? "до лампи доходить не та напруга" : undefined,
    );

    cells.forEach((cell, i) => {
      const x = ox + (i % n) * cs;
      const y = oy + Math.floor(i / n) * cs;
      const [cx, cy] = centre(i);
      const color = cell.kind === "source" || path.has(i) ? LIGHT : WIRE_OFF;
      if (cell.kind === "block") {
        drawBlock(x, y, cs, cell.ports, cell.value, color, true);
        return;
      }
      const fill = cell.kind === "lock" ? PILLAR : cell.kind === "source" ? SOURCE_CELL : TILE;
      svgEl(
        "rect",
        { x: x + 1.5, y: y + 1.5, width: cs - 3, height: cs - 3, rx: 8, style: `fill:${fill}` },
        svg,
      );
      if (cell.kind === "lock") {
        // locked: nothing goes here
        svgEl("circle", { cx, cy, r: cs * 0.18, style: `fill:${BOX}` }, svg);
        return;
      }
      if (cell.kind === "free") return;
      for (const [dx, dy, bit] of DIRS)
        if (cell.ports & bit)
          svgEl(
            "line",
            {
              x1: cx,
              y1: cy,
              x2: cx + (dx * cs) / 2,
              y2: cy + (dy * cs) / 2,
              style: `stroke:${cell.kind === "lamp" ? (t.lit ? LIGHT : WIRE_OFF) : LIGHT};stroke-width:${line};stroke-linecap:round`,
            },
            svg,
          );
      if (cell.kind === "source") {
        // the generator: a battery, always on
        const bw = cs * 0.34;
        const bh = cs * 0.5;
        svgEl(
          "rect",
          { x: cx - bw / 2, y: cy - bh / 2, width: bw, height: bh, rx: 3, style: `fill:${LIGHT}` },
          svg,
        );
        svgEl(
          "rect",
          {
            x: cx - bw / 4,
            y: cy - bh / 2 - 3,
            width: bw / 2,
            height: 4,
            rx: 1.5,
            style: `fill:${LIGHT}`,
          },
          svg,
        );
        text(svg, cx, cy, "+", 14, INK);
      } else {
        // the lamp with the voltage it needs; alight once it gets exactly that
        svgEl(
          "circle",
          {
            cx,
            cy,
            r: cs * 0.3,
            style: `fill:${ok ? LIGHT : TILE};stroke:${ok ? LIGHT : WIRE_OFF};stroke-width:2`,
          },
          svg,
        );
        text(svg, cx, cy, volts(target), 14, ok ? INK : TEXT);
      }
    });
    // the blocks laid on the board (one carried away leaves its cell empty)
    blocks.forEach((b, i) => {
      if (b.at === null || (drag?.moved && drag.i === i)) return;
      const x = ox + (b.at % n) * cs;
      const y = oy + Math.floor(b.at / n) * cs;
      drawBlock(x, y, cs, b.ports, b.value, path.has(b.at) ? LIGHT : WIRE_OFF, false);
    });

    // the current running along the wire: sparks from the generator's edge on (to the lamp's
    // edge once there), under the numbers of the blocks it runs through
    if (t.path.length > 1) {
      const period = cs * 0.34;
      const points = t.path.map(centre);
      const mid = (a: [number, number], b: [number, number]) =>
        [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number];
      points[0] = mid(points[0] as [number, number], points[1] as [number, number]);
      if (t.lit)
        points[points.length - 1] = mid(
          points[points.length - 1] as [number, number],
          points[points.length - 2] as [number, number],
        );
      const flow = svgEl(
        "polyline",
        {
          points: points.map((pt) => pt.join(",")).join(" "),
          style: `fill:none;stroke:${SPARK};stroke-width:${line * 0.55};stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:0.1 ${period}`,
        },
        svg,
      );
      if (!still)
        flow.animate([{ strokeDashoffset: period }, { strokeDashoffset: 0 }], {
          duration: 420,
          iterations: Number.POSITIVE_INFINITY,
        });
      for (const i of t.path) {
        const cell = cells[i];
        const block = cell?.kind === "block" ? cell : on.get(i);
        if (!block || cell?.kind === "lamp" || cell?.kind === "source") continue;
        const fixed = cell?.kind === "block";
        const [cx, cy] = centre(i);
        svgEl(
          "rect",
          {
            x: cx - cs * 0.26,
            y: cy - cs * 0.22,
            width: cs * 0.52,
            height: cs * 0.44,
            rx: 6,
            style: `fill:${fixed ? (block.value > 0 ? FIX_PLUS : FIX_MINUS) : block.value > 0 ? MOVE_PLUS : MOVE_MINUS}`,
          },
          svg,
        );
        text(svg, cx, cy, signed(block.value), Math.max(13, Math.round(cs * 0.36)), TEXT);
      }
    }

    // next to the board: each block one gets in its place (an empty place: it lies on the board)
    blocks.forEach((b, i) => {
      const [x, y] = slot(i);
      if (b.at !== null || (drag?.moved && drag.i === i)) {
        svgEl(
          "rect",
          {
            x: x + 2,
            y: y + 2,
            width: ts - 4,
            height: ts - 4,
            rx: ts * 0.18,
            style: "fill:none;stroke:rgba(242,239,234,0.12);stroke-width:1.5;stroke-dasharray:4 4",
          },
          svg,
        );
        return;
      }
      drawBlock(x, y, ts, b.ports, b.value, WIRE_OFF, false, "", 0.42);
    });

    // a block carried: where it would land, shown faintly there, and the block itself above the
    // finger; it keeps the turn it has, only a tap turns it
    if (drag?.moved) {
      const b = blocks[drag.i] as (typeof blocks)[number];
      const cell = landing(drag.x, drag.y);
      const ports = b.ports;
      if (cell >= 0) {
        const [x, y] = centre(cell);
        drawBlock(x - cs / 2, y - cs / 2, cs, ports, b.value, WIRE_OFF, false, "opacity:0.4");
        svgEl(
          "rect",
          {
            x: x - cs / 2 + 2,
            y: y - cs / 2 + 2,
            width: cs - 4,
            height: cs - 4,
            rx: 8,
            style: `fill:none;stroke:${LIGHT};stroke-width:2;stroke-dasharray:5 4`,
          },
          svg,
        );
      }
      drawBlock(
        drag.x - cs / 2,
        drag.y - lift - cs / 2,
        cs,
        ports,
        b.value,
        WIRE_OFF,
        false,
        "opacity:0.92;filter:drop-shadow(0 8px 10px rgba(0,0,0,0.5))",
        0.42,
      );
    }
  };

  let unfold = () => {};
  const check = () => {
    const t = voltTrace(p, laid());
    if (!won && t.lit && t.sum === target) {
      won = true;
      // lit: the shelf of blocks folds away, the board stands alone
      unfold = foldShelf(svg, vw, vh, oy + n * cs + 6, ctx);
      ctx.done(`рівно ${target} В`);
    }
  };

  /** The block under the finger: one laid on the board, else one in its place next to it. */
  const blockAt = (x: number, y: number) => {
    const cell = cellAt(x, y);
    if (cell >= 0) return blocks.findIndex((b) => b.at === cell);
    return blocks.findIndex((b, i) => {
      if (b.at !== null) return false;
      const [sx, sy] = slot(i);
      return x >= sx && x <= sx + ts && y >= sy && y <= sy + ts;
    });
  };

  svg.addEventListener("pointerdown", (e) => {
    if (won) return;
    const [x, y] = pointIn(svg, e, vw, vh);
    const i = blockAt(x, y);
    if (i < 0) return;
    drag = { i, x, y, sx: x, sy: y, moved: false };
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
  svg.addEventListener("pointerup", () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    const b = blocks[d.i] as (typeof blocks)[number];
    if (!d.moved) {
      // a tap turns the block, wherever it lies
      const turns = voltTurns(b.ports);
      b.ports = turns[(turns.indexOf(b.ports) + 1) % turns.length] as number;
    } else {
      const cell = landing(d.x, d.y);
      if (cell >= 0) {
        // laid there as it is turned; a block that lay there goes back next to the board
        for (const o of blocks) if (o !== b && o.at === cell) o.at = null;
        b.at = cell;
      } else if (cellAt(d.x, d.y - lift) < 0) b.at = null;
    }
    draw();
    check();
  });
  svg.addEventListener("pointercancel", () => {
    drag = null;
    draw();
  });

  draw();
  return () => unfold();
}

// ── Пазл ─────────────────────────────────────────────────────────────────────────────────────

/** Each mount names its picture and pieces apart (two boards on one page never mix them up). */
let jigsawMounts = 0;
/** Under the pieces: a neutral grey, lighter than the page, for pictures dark and light alike. */
const JIGSAW_GROUND = "#6a6d76";

/** The picture as an SVG document of its own, `k` times its size: one image for every piece. */
function jigsawPicture(p: JigsawPuzzle, k: number): string {
  const B = JIGSAW_SIZE;
  const doc = document.createElementNS(NS, "svg");
  doc.setAttribute("width", String(B * k));
  doc.setAttribute("height", String(B * k));
  doc.setAttribute("viewBox", `0 0 ${B} ${B}`);
  const defs = svgEl("defs", {}, doc);
  const sky = svgEl("linearGradient", { id: "sky", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  svgEl("stop", { offset: 0, "stop-color": p.sky[0] }, sky);
  svgEl("stop", { offset: 1, "stop-color": p.sky[1] }, sky);
  svgEl("rect", { x: 0, y: 0, width: B, height: B, fill: "url(#sky)" }, doc);
  for (const a of p.art) {
    const opacity = a.opacity ?? 1;
    if (a.kind === "rect")
      svgEl(
        "rect",
        { x: a.x, y: a.y, width: a.w, height: a.h, rx: a.rx ?? 0, fill: a.fill, opacity },
        doc,
      );
    else if (a.kind === "circle")
      svgEl("circle", { cx: a.cx, cy: a.cy, r: a.r, fill: a.fill, opacity }, doc);
    else
      svgEl(
        "path",
        {
          d: a.d,
          fill: a.fill,
          stroke: a.stroke ?? "none",
          "stroke-width": a.width ?? 1,
          "stroke-linecap": "round",
          opacity,
        },
        doc,
      );
  }
  return new XMLSerializer().serializeToString(doc);
}

export function mountJigsaw(root: HTMLElement, p: JigsawPuzzle, ctx: GameCtx): Cleanup {
  const { n } = p;
  const total = n * n;
  const B = JIGSAW_SIZE;
  const s = B / n;
  const uid = `jig${++jigsawMounts}`;
  const vw = 320;
  const bx = (vw - B) / 2;
  const by = 8;
  // next to the board, every piece small in its own place (its knobs reach a quarter round it)
  const box = ([36, 32, 28] as const)[Math.min(2, Math.max(0, n - 4))] ?? 28;
  const small = box / s;
  const pitch = Math.round(box * 1.4);
  const perRow = Math.floor((vw - 8) / pitch);
  const trayY = by + B + 14 + box * 0.25;
  const slot = (j: number): [number, number] => {
    const row = Math.floor(j / perRow);
    const inRow = Math.min(perRow, total - row * perRow);
    const x0 = (vw - inRow * pitch) / 2 + (pitch - box) / 2;
    return [x0 + (j % perRow) * pitch, trayY + row * pitch];
  };
  const vh = trayY + Math.ceil(total / perRow) * pitch + 2;
  const svg = svgRoot(root, vw, vh, "g-drag");
  /** A piece carried hangs this far above the finger, its bottom edge clear of it. */
  const lift = s / 2 + 18;
  const rowOf = (i: number) => Math.floor(i / n);
  const colOf = (i: number) => i % n;
  const outlines = Array.from({ length: total }, (_, i) => jigsawOutline(p, i));
  // every edge on its own, to draw round a group where nothing is joined to it
  const curve = (points: [number, number][]) => {
    const f = (k: number) => {
      const [x, y] = points[k] as [number, number];
      return `${+x.toFixed(2)} ${+y.toFixed(2)}`;
    };
    let d = `M${f(0)}`;
    for (let k = 1; k + 2 < points.length; k += 3) d += `C${f(k)} ${f(k + 1)} ${f(k + 2)}`;
    return d;
  };
  const across = Array.from({ length: n + 1 }, (_, r) =>
    Array.from({ length: n }, (_, c) => curve(jigsawEdge(p, "across", r, c))),
  );
  const down = Array.from({ length: n }, (_, r) =>
    Array.from({ length: n + 1 }, (_, c) => curve(jigsawEdge(p, "down", r, c))),
  );

  // the picture, an image every piece shows through its own outline: drawn by the browser once,
  // not shape by shape for each piece (that made a drag stall); a bitmap of it as soon as it is
  // ready, cheaper still. Both as data: addresses — the site lets images come from nowhere else
  // (a blob: one was blocked, and the pieces went blank)
  const defs = svgEl("defs", {}, svg);
  const k = Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));
  const vector = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(jigsawPicture(p, k))}`;
  const picture = svgEl(
    "image",
    { id: `${uid}-art`, href: vector, width: B, height: B, preserveAspectRatio: "none" },
    defs,
  );
  let alive = true;
  const raster = new Image();
  raster.onload = () => {
    if (!alive) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = B * k;
      canvas.height = B * k;
      const g = canvas.getContext("2d");
      if (!g) return;
      g.drawImage(raster, 0, 0, B * k, B * k);
      const bitmap = canvas.toDataURL("image/jpeg", 0.92);
      // should the bitmap not show after all, the vector picture comes back
      picture.addEventListener("error", () => picture.setAttribute("href", vector), { once: true });
      picture.setAttribute("href", bitmap);
    } catch {
      // a canvas the browser will not read back: the vector picture stays
    }
  };
  raster.src = vector;
  outlines.forEach((d, i) => {
    const clip = svgEl("clipPath", { id: `${uid}-p${i}` }, defs);
    svgEl("path", { d }, clip);
  });
  const layer = svgEl("g", {}, svg);

  /** The cell each piece lies on (row by row), or null: next to the board. */
  const at = new Array<number | null>(total).fill(null);
  /** The element each piece is drawn in (the pieces of a group share one). */
  const shown: (SVGElement | undefined)[] = [];
  /** A drag: the pieces carried (a group moves whole), the one held by the finger. */
  let drag: {
    group: number[];
    i: number;
    x: number;
    y: number;
    sx: number;
    sy: number;
    moved: boolean;
  } | null = null;
  /** The pieces carried, drawn over the rest: moved as the finger moves, not drawn again. */
  let held: SVGElement | null = null;
  let won = false;
  let unfold = () => {};
  let joins = 0;

  /**
   * Pieces `members` (one, or a group) with the picture's top left at (x, y), `scale` times their
   * size: the picture through their outlines together, their edge round them all but where they
   * are joined, so a group is one whole; carried, a shadow under them.
   */
  const drawSet = (
    members: readonly number[],
    x: number,
    y: number,
    scale: number,
    carried = false,
  ) => {
    const g = svgEl("g", { transform: `translate(${x} ${y}) scale(${scale})` }, layer);
    let clip = `${uid}-p${members[0]}`;
    if (members.length > 1) {
      clip = `${uid}-g${joins++}`;
      const shape = svgEl("clipPath", { id: clip }, g);
      for (const i of members) svgEl("path", { d: outlines[i] as string }, shape);
    }
    const mine = new Set(members);
    let d = "";
    for (const i of members) {
      const r = rowOf(i);
      const c = colOf(i);
      if (r === 0 || !mine.has(i - n)) d += across[r]?.[c] as string;
      if (r === n - 1 || !mine.has(i + n)) d += across[r + 1]?.[c] as string;
      if (c === 0 || !mine.has(i - 1)) d += down[r]?.[c] as string;
      if (c === n - 1 || !mine.has(i + 1)) d += down[r]?.[c + 1] as string;
    }
    if (carried)
      for (const i of members)
        svgEl(
          "path",
          { d: outlines[i] as string, transform: "translate(3 8)", style: "fill:rgba(0,0,0,0.35)" },
          g,
        );
    const inner = svgEl("g", { "clip-path": `url(#${clip})` }, g);
    svgEl("use", { href: `#${uid}-art` }, inner);
    svgEl(
      "path",
      {
        d,
        style: `fill:none;stroke:rgba(0,0,0,0.5);stroke-width:${1.2 / scale};stroke-linejoin:round`,
      },
      g,
    );
    return g;
  };
  /** Where the picture's top left is while the pieces are carried: the one held above the finger. */
  const heldAt = (d: NonNullable<typeof drag>): [number, number] => [
    d.x - s / 2 - colOf(d.i) * s,
    d.y - lift - s / 2 - rowOf(d.i) * s,
  ];
  const status = () =>
    `Збери картинку: клади шматки на поле, ті, що зійшлися, зчіпляються · на полі ${at.filter((c) => c !== null).length} з ${total}`;

  const draw = () => {
    layer.replaceChildren();
    joins = 0;
    held = null;
    ctx.say(status());
    // the board, nothing on it to go by, and the shelf of pieces under it: a lighter grey, the same
    // for every picture, so dark pieces (a night sky) stand out from it as well as light ones
    svgEl(
      "rect",
      { x: bx - 4, y: by - 4, width: B + 8, height: B + 8, rx: 10, style: `fill:${JIGSAW_GROUND}` },
      layer,
    );
    svgEl(
      "rect",
      {
        x: 4,
        y: trayY - box * 0.25 - 8,
        width: vw - 8,
        height: Math.ceil(total / perRow) * pitch + 6,
        rx: 12,
        style: `fill:${JIGSAW_GROUND}`,
      },
      layer,
    );
    // the pieces on the board, each group as one; once all are home, the picture whole
    if (won) svgEl("use", { href: `#${uid}-art`, x: bx, y: by }, layer);
    else {
      const drawn = new Set<number>();
      at.forEach((cell, i) => {
        if (cell === null || drawn.has(i)) return;
        const group = jigsawGroup(n, at, i);
        const el = drawSet(
          group,
          bx + (colOf(cell) - colOf(i)) * s,
          by + (rowOf(cell) - rowOf(i)) * s,
          1,
        );
        for (const j of group) {
          drawn.add(j);
          shown[j] = el;
        }
      });
    }
    // next to the board, each in its place
    p.order.forEach((i, j) => {
      if (at[i] !== null) return;
      const [x, y] = slot(j);
      shown[i] = drawSet([i], x - small * colOf(i) * s, y - small * rowOf(i) * s, small);
    });
  };

  svg.addEventListener("pointerdown", (e) => {
    if (won || drag) return;
    const [x, y] = pointIn(svg, e, vw, vh);
    // a piece on the board under the finger: it, and everything joined to it
    const R = Math.floor((y - by) / s);
    const C = Math.floor((x - bx) / s);
    let i = R >= 0 && R < n && C >= 0 && C < n ? at.indexOf(R * n + C) : -1;
    if (i < 0) {
      // or one next to the board (the box round it, knobs and all)
      const pad = box * 0.2;
      const j = p.order.findIndex((k, idx) => {
        if (at[k] !== null) return false;
        const [sx, sy] = slot(idx);
        return x >= sx - pad && x <= sx + box + pad && y >= sy - pad && y <= sy + box + pad;
      });
      if (j < 0) return;
      i = p.order[j] as number;
    }
    drag = { group: jigsawGroup(n, at, i), i, x, y, sx: x, sy: y, moved: false };
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      // a pointer gone already: the moves still come to the board
    }
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [x, y] = pointIn(svg, e, vw, vh);
    drag.x = x;
    drag.y = y;
    if (!drag.moved) {
      if (Math.hypot(x - drag.sx, y - drag.sy) <= 6) return;
      drag.moved = true;
      // lifted: hidden where it lay, drawn over everything above the finger
      for (const j of drag.group) shown[j]?.setAttribute("display", "none");
      held = drawSet(drag.group, ...heldAt(drag), 1, true);
      return;
    }
    const [hx, hy] = heldAt(drag);
    held?.setAttribute("transform", `translate(${hx} ${hy}) scale(1)`);
  });
  const drop = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) {
      // the piece held: over the board it clicks onto the nearest cells (the group kept on the
      // board), whatever lies round it; a piece that lay there swaps places with it (or, under a
      // group, goes back next to the board). Below the board, the pieces go back next to it.
      const [hx, hy] = heldAt(d);
      const left = hx + colOf(d.i) * s;
      const top = hy + rowOf(d.i) * s;
      if (top + s / 2 > by + B + s * 0.25) for (const j of d.group) at[j] = null;
      else {
        const rows = d.group.map(rowOf);
        const cols = d.group.map(colOf);
        const dr = Math.max(
          -Math.min(...rows),
          Math.min(n - 1 - Math.max(...rows), Math.round((top - by) / s) - rowOf(d.i)),
        );
        const dc = Math.max(
          -Math.min(...cols),
          Math.min(n - 1 - Math.max(...cols), Math.round((left - bx) / s) - colOf(d.i)),
        );
        const mine = new Set(d.group);
        const to = d.group.map((j) => (rowOf(j) + dr) * n + colOf(j) + dc);
        const there = to.map((cell) => at.indexOf(cell)).filter((o) => o >= 0 && !mine.has(o));
        const before = at[d.i] ?? null;
        if (d.group.length === 1 && there.length === 1) at[there[0] as number] = before;
        else for (const o of there) at[o] = null;
        d.group.forEach((j, k) => {
          at[j] = to[k] as number;
        });
        navigator.vibrate?.(jigsawGroup(n, at, d.i).length > d.group.length ? 25 : 10);
      }
    }
    if (!won && at.every((cell, j) => cell === j)) {
      won = true;
      // whole: the shelf folds away, the picture stands alone
      unfold = foldShelf(svg, vw, vh, by + B + 8, ctx);
      ctx.done(`усі ${total} шматків на місці`);
    }
    if (d.moved || won) draw();
  };
  svg.addEventListener("pointerup", drop);
  svg.addEventListener("pointercancel", () => {
    drag = null;
    draw();
  });

  draw();
  return () => {
    alive = false;
    unfold();
  };
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

// ── Судоку ──────────────────────────────────────────────────────────────────────────────────

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

export function mountSudoku(root: HTMLElement, p: SudokuPuzzle, ctx: GameCtx): Cleanup {
  const { n } = p;
  const [bh, bw] = p.box;
  const digits = Array.from({ length: n }, (_, d) => d + 1);
  /** The digits in the cells now (row by row, 0: empty), the pencil marks in each (bit per digit). */
  const now = p.givens.slice();
  const marks = new Array<number>(n * n).fill(0);
  const given = p.givens.map((d) => d > 0);
  const rowOf = (i: number) => Math.floor(i / n);
  const colOf = (i: number) => i % n;
  const boxOf = (i: number) => Math.floor(rowOf(i) / bh) * (n / bw) + Math.floor(colOf(i) / bw);
  const near = (i: number, j: number) =>
    rowOf(i) === rowOf(j) || colOf(i) === colOf(j) || boxOf(i) === boxOf(j);
  const area = n === 6 ? "прямокутнику" : "квадраті";
  /** The cells picked (a swipe picks several), and the last one picked. */
  let picked = new Set<number>();
  let pick = -1;
  const pickOnly = (i: number) => {
    picked = new Set(i < 0 ? [] : [i]);
    pick = i;
  };
  let pencil = false;
  let won = false;

  // the board: its boxes, and the cells in each
  const board = document.createElement("div");
  board.className = "g-sdk";
  board.dataset.n = String(n);
  board.style.setProperty("--across", String(n / bw));
  board.style.setProperty("--bw", String(bw));
  const cells: HTMLButtonElement[] = [];
  for (let b = 0; b < n; b++) {
    const group = document.createElement("div");
    group.className = "g-sdk-box";
    board.appendChild(group);
    for (let k = 0; k < n; k++) {
      const r = Math.floor(b / (n / bw)) * bh + Math.floor(k / bw);
      const c = (b % (n / bw)) * bw + (k % bw);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "g-sdk-cell";
      cell.setAttribute("aria-label", `Рядок ${r + 1}, стовпець ${c + 1}`);
      cell.dataset.i = String(r * n + c);
      // a finger or a mouse picks on press (below); this is Enter or Space on a cell in focus
      cell.addEventListener("click", (e) => {
        if (won || e.detail !== 0) return;
        pickOnly(r * n + c);
        paint();
      });
      group.appendChild(cell);
      cells[r * n + c] = cell;
    }
  }
  root.appendChild(board);

  // a press picks the cell under it; a swipe on from there picks every cell it passes over too
  let swipe: { id: number; x: number; y: number } | null = null;
  const cellUnder = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".g-sdk-cell");
    return el && board.contains(el) ? Number(el.dataset.i) : -1;
  };
  board.addEventListener("pointerdown", (e) => {
    if (won || e.button !== 0) return;
    const i = cellUnder(e.clientX, e.clientY);
    if (i < 0) return;
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      board.setPointerCapture(e.pointerId);
    } catch {}
    pickOnly(i);
    paint();
  });
  board.addEventListener("pointermove", (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    // every few pixels along the way, so a quick swipe does not skip a cell
    const steps = Math.max(1, Math.ceil(Math.hypot(e.clientX - swipe.x, e.clientY - swipe.y) / 6));
    let grew = false;
    for (let s = 1; s <= steps; s++) {
      const i = cellUnder(
        swipe.x + ((e.clientX - swipe.x) * s) / steps,
        swipe.y + ((e.clientY - swipe.y) * s) / steps,
      );
      if (i < 0 || picked.has(i)) continue;
      picked.add(i);
      pick = i;
      grew = true;
    }
    swipe.x = e.clientX;
    swipe.y = e.clientY;
    if (grew) paint();
  });
  const endSwipe = (e: PointerEvent) => {
    if (swipe && e.pointerId === swipe.id) swipe = null;
  };
  board.addEventListener("pointerup", endSwipe);
  board.addEventListener("pointercancel", endSwipe);

  // the digits to put in, the pencil, the eraser
  const pad = document.createElement("div");
  pad.className = "g-sdk-pad";
  pad.dataset.n = String(n);
  const keys = digits.map((d) => {
    const key = document.createElement("button");
    key.type = "button";
    key.className = "g-sdk-key";
    key.textContent = String(d);
    key.addEventListener("click", () => put(d));
    pad.appendChild(key);
    return key;
  });
  root.appendChild(pad);
  const tools = document.createElement("div");
  tools.className = "g-sdk-tools";
  const pencilKey = document.createElement("button");
  pencilKey.type = "button";
  pencilKey.className = "g-btn g-sdk-tool";
  pencilKey.textContent = "Олівець";
  pencilKey.setAttribute("aria-pressed", "false");
  pencilKey.addEventListener("click", () => {
    pencil = !pencil;
    paint();
  });
  const eraser = document.createElement("button");
  eraser.type = "button";
  eraser.className = "g-btn g-sdk-tool";
  eraser.textContent = "Стерти";
  eraser.addEventListener("click", () => put(0));
  // a step back: an icon, first in the row
  const back = document.createElement("button");
  back.type = "button";
  back.className = "g-btn g-sdk-tool g-sdk-undo";
  back.innerHTML = icon("undo", 22);
  back.setAttribute("aria-label", "Відмінити");
  back.title = "Відмінити";
  back.addEventListener("click", () => undo());
  tools.append(back, pencilKey, eraser);
  root.appendChild(tools);

  /** How the grid was before each change, and which cells were picked: undone one by one. */
  const history: { now: number[]; marks: number[]; picked: number[]; pick: number }[] = [];
  function undo() {
    const last = history.pop();
    if (won || !last) return;
    now.splice(0, now.length, ...last.now);
    marks.splice(0, marks.length, ...last.marks);
    picked = new Set(last.picked);
    pick = last.pick;
    paint();
  }

  /**
   * Digit `d` into the cells picked (0: clear them), or with the pencil, its mark in them or not.
   * The given ones among them stay as they are.
   */
  function put(d: number) {
    const at = [...picked].filter((i) => !given[i]);
    if (won || at.length === 0) return;
    const was = { now: now.slice(), marks: marks.slice(), picked: [...picked], pick };
    change(d, at);
    if (now.some((v, i) => v !== was.now[i]) || marks.some((v, i) => v !== was.marks[i]))
      history.push(was);
    const bad = clashes();
    if (now.every(Boolean) && bad.size === 0) {
      won = true;
      pickOnly(-1);
      paint();
      foldAway([pad, tools], ctx);
      ctx.done(`сітка ${n}×${n} заповнена`);
      return;
    }
    paint();
  }
  /** Into several cells at once as into one: a digit (or mark) all of them have comes out of all. */
  function change(d: number, at: number[]) {
    const bit = 1 << (d - 1);
    if (d === 0)
      for (const i of at) {
        now[i] = 0;
        marks[i] = 0;
      }
    else if (pencil) {
      const open = at.filter((i) => !now[i]);
      const all = open.every((i) => (marks[i] as number) & bit);
      for (const i of open)
        marks[i] = all ? (marks[i] as number) & ~bit : (marks[i] as number) | bit;
    } else if (at.every((i) => now[i] === d)) for (const i of at) now[i] = 0;
    else
      for (const i of at) {
        now[i] = d;
        marks[i] = 0;
        // the digit is taken here: out of the marks round it
        for (let j = 0; j < n * n; j++) if (near(i, j)) marks[j] = (marks[j] as number) & ~bit;
      }
  }

  /** The cells whose digit is also in their row, column or box. */
  function clashes() {
    const bad = new Set<number>();
    for (let i = 0; i < n * n; i++)
      for (let j = i + 1; j < n * n; j++)
        if (now[i] && now[i] === now[j] && near(i, j)) {
          bad.add(i);
          bad.add(j);
        }
    return bad;
  }

  function paint() {
    const bad = clashes();
    const empty = now.filter((d) => !d).length;
    if (!won)
      ctx.say(
        `Цифри від 1 до ${n}: кожна раз у рядку, стовпці й ${area} · проведи пальцем, щоб вибрати кілька клітинок · лишилось ${empty}`,
        bad.size ? "є повтори" : undefined,
      );
    // its row, column and box, and the same digit elsewhere: shown for a cell picked alone
    const one = picked.size === 1 ? pick : -1;
    const mine = one >= 0 ? (now[one] as number) : 0;
    cells.forEach((cell, i) => {
      const d = now[i] as number;
      cell.toggleAttribute("data-given", given[i] as boolean);
      cell.toggleAttribute("data-pick", picked.has(i));
      cell.toggleAttribute("data-near", one >= 0 && i !== one && near(one, i));
      cell.toggleAttribute("data-same", mine > 0 && d === mine && i !== one);
      cell.toggleAttribute("data-bad", bad.has(i));
      cell.toggleAttribute("data-won", won);
      if (d) cell.textContent = String(d);
      else if (marks[i])
        cell.innerHTML = `<span class="g-sdk-marks">${digits
          .map((m) => `<i>${(marks[i] as number) & (1 << (m - 1)) ? m : ""}</i>`)
          .join("")}</span>`;
      else cell.textContent = "";
    });
    // a digit all placed is spent
    keys.forEach((key, k) => {
      key.toggleAttribute("data-spent", now.filter((d) => d === k + 1).length >= n);
      key.disabled = won;
    });
    pencilKey.toggleAttribute("data-on", pencil);
    pencilKey.setAttribute("aria-pressed", String(pencil));
    pencilKey.disabled = won;
    eraser.disabled = won;
    back.disabled = won || history.length === 0;
  }

  // with a keyboard: digits, the eraser, the arrows to move (with Shift, picking on), Ctrl+Z to undo
  const onKey = (e: KeyboardEvent) => {
    if (!won && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if (won || e.ctrlKey || e.metaKey || e.altKey) return;
    const d = Number(e.key);
    if (Number.isInteger(d) && d >= 1 && d <= n) put(d);
    else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") put(0);
    else {
      const step = ARROWS[e.key];
      if (!step) return;
      e.preventDefault();
      const at = Math.max(pick, 0);
      const next = ((rowOf(at) + step[0] + n) % n) * n + ((colOf(at) + step[1] + n) % n);
      if (e.shiftKey && pick >= 0) {
        picked.add(next);
        pick = next;
      } else pickOnly(next);
      paint();
    }
  };
  document.addEventListener("keydown", onKey);

  paint();
  return () => document.removeEventListener("keydown", onKey);
}

// ── Іскра ───────────────────────────────────────────────────────────────────────────────────

/** A bit of fire or smoke flying off the spark: where (in steps), how fast, how old. */
type SparkBit = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  smoke: boolean;
};

export function mountSpark(root: HTMLElement, p: SparkPuzzle, ctx: GameCtx): Cleanup {
  const canvas = document.createElement("canvas");
  canvas.className = "g-spark-board";
  canvas.setAttribute("aria-label", "Дріт зигзагом до лампи; тап повертає іскру");
  root.appendChild(canvas);
  const g = canvas.getContext("2d");
  if (!g) return undefined;
  const path = sparkPath(p);
  const end = path.at(-1) as [number, number];
  const corners = path.length - 2;
  const half = p.width / 2;
  // the wire's length to each corner, for the light running back along it
  const along = [0];
  for (let k = 1; k < path.length; k++) {
    const [ax, ay] = path[k - 1] as [number, number];
    const [bx, by] = path[k] as [number, number];
    along.push((along[k - 1] as number) + Math.hypot(bx - ax, by - ay));
  }
  const length = along.at(-1) as number;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  /** The lamp's bulb: its middle and radius above the end of the wire, in steps. */
  const BASE = 0.8;
  const BULB = 0.95;
  const bulbY = end[1] + BASE + BULB * 0.8;

  type Mode = "ready" | "run" | "out" | "won";
  let mode: Mode = "ready";
  let since = performance.now();
  let attempt = 1;
  let x = 0;
  let y = 0;
  let dir: number = p.first;
  /** The corners the spark has turned at (it lights the wire behind it). */
  let trail: [number, number][] = [[0, 0]];
  let passed = 0;
  /** Where the spark went out, and how it flies on. */
  let lost = { x: 0, y: 0, vx: 0, vy: 0 };
  /** Where it was when it reached the lamp. */
  let reached: [number, number] = [0, 0];
  let lit = false;
  let flashed = false;
  /** The view: the height (steps) at its spark line, and the middle across. */
  let view = 0;
  let across = 0;
  let bits: SparkBit[] = [];
  let arcs: [number, number][][] = [];
  let arcsAt = 0;
  let lastMove = performance.now();
  /** A turn close to its corner: the stretch's corner the spark is pulled onto, until when. */
  let snap: { corner: number; until: number } | null = null;
  let lastFrame = lastMove;
  let raf = 0;
  let said = "";

  const say = (warn?: string) => {
    const tries = attempt > 1 ? ` · спроба ${attempt}` : "";
    const text =
      mode === "ready"
        ? `Тапни, щоб пустити іскру, і тапай на кожному повороті · поворотів ${corners}${tries}`
        : `Доведи іскру до лампи · поворот ${passed} з ${corners}${tries}`;
    if (text + (warn ?? "") === said) return;
    said = text + (warn ?? "");
    ctx.say(text, warn);
  };

  /** `count` bits of fire from (x0, y0): off the way `vx, vy` points, spread round it. */
  const burst = (
    count: number,
    x0: number,
    y0: number,
    vx: number,
    vy: number,
    spread: number,
    speed: [number, number],
  ) => {
    for (let k = 0; k < count && bits.length < 260; k++) {
      const a = Math.atan2(vy, vx) + (Math.random() - 0.5) * spread;
      const v = speed[0] + Math.random() * (speed[1] - speed[0]);
      bits.push({
        x: x0,
        y: y0,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        age: 0,
        life: 0.25 + Math.random() * 0.35,
        size: 1 + Math.random() * 0.9,
        smoke: false,
      });
    }
  };
  const smoke = (x0: number, y0: number) => {
    for (let k = 0; k < 6; k++)
      bits.push({
        x: x0 + (Math.random() - 0.5) * 0.4,
        y: y0 + (Math.random() - 0.5) * 0.4,
        vx: (Math.random() - 0.5) * 0.5,
        vy: 0.3 + Math.random() * 0.5,
        age: 0,
        life: 0.9 + Math.random() * 0.6,
        size: 0.25 + Math.random() * 0.2,
        smoke: true,
      });
  };

  const speedAt = (at: number) => p.speed[0] + (p.speed[1] - p.speed[0]) * Math.min(1, at / end[1]);

  /** The spark moved on to `now`: still on the wire, off it, or at the lamp. */
  const advance = (now: number) => {
    // a tap comes between frames, after the frame's own time: never back
    const dt = Math.max(0, Math.min(0.05, (now - lastMove) / 1000));
    lastMove = now;
    if (mode !== "run") return;
    const v = speedAt(y);
    x += dir * v * dt;
    y += v * dt;
    // turned close enough to the corner: drawn onto the middle of the stretch, smoothly
    if (snap && now < snap.until) {
      const [cx, cy] = path[snap.corner] as [number, number];
      const t = ((x - cx) * dir + (y - cy)) / 2;
      const k = 1 - Math.exp(-dt * 18);
      x += (cx + dir * t - x) * k;
      y += (cy + t - y) * k;
      trail.push([x, y]);
    } else snap = null;
    if (y >= end[1] && sparkDistance(path, x, y) <= half) {
      mode = "won";
      since = now;
      reached = [x, y];
      trail.push([x, y]);
      passed = corners;
      say();
      return;
    }
    if (sparkDistance(path, x, y) > half) {
      mode = "out";
      since = now;
      lost = { x, y, vx: dir * v, vy: v };
      trail.push([x, y]);
      burst(34, x, y, dir * v, v, Math.PI * 2, [1.5, 5]);
      smoke(x, y);
      navigator.vibrate?.([30, 40, 30]);
      say("іскра зірвалася з дроту");
      return;
    }
    let k = 0;
    while (k < corners && (path[k + 1] as [number, number])[1] <= y) k++;
    if (k !== passed) {
      passed = k;
      say();
    }
  };

  const tap = () => {
    const now = performance.now();
    if (mode === "ready") {
      mode = "run";
      since = now;
      lastMove = now;
      burst(14, 0, 0, 0, 1, Math.PI * 2, [1, 3]);
      say();
      return;
    }
    if (mode !== "run") return;
    advance(now);
    if (mode !== "run") return;
    trail.push([x, y]);
    dir = -dir;
    const corner = sparkSnap(p, path, x, y, dir);
    snap = corner === null ? null : { corner, until: now + 300 };
  };

  // ── drawing ──
  let cw = 0;
  let ch = 0;
  let u = 0;
  const sx = (wx: number) => cw / 2 + (wx - across) * u;
  const sy = (wy: number) => ch * 0.72 - (wy - view) * u;
  const line = (points: readonly (readonly [number, number])[]) => {
    g.beginPath();
    points.forEach(([px, py], k) => {
      if (k) g.lineTo(sx(px), sy(py));
      else g.moveTo(sx(px), sy(py));
    });
  };
  const glow = (cx: number, cy: number, r: number, stops: [number, string][]) => {
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [at, color] of stops) grad.addColorStop(at, color);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
  };
  /** The point `s` along the wire from the start. */
  const pointAt = (s: number): [number, number] => {
    let k = 1;
    while (k < path.length - 1 && (along[k] as number) < s) k++;
    const [ax, ay] = path[k - 1] as [number, number];
    const [bx, by] = path[k] as [number, number];
    const t = (s - (along[k - 1] as number)) / ((along[k] as number) - (along[k - 1] as number));
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
  };

  /** The spark itself at (px, py) on the screen, `a` of its strength: a white-hot core, its halo, two rays turning, crackles round it. */
  const drawSpark = (px: number, py: number, a: number, now: number) => {
    if (a <= 0) return;
    g.globalCompositeOperation = "lighter";
    const flicker = 0.85 + Math.random() * 0.3;
    glow(px, py, u * 1.25 * flicker, [
      [0, `rgba(255, 190, 90, ${0.5 * a})`],
      [0.35, `rgba(255, 140, 40, ${0.2 * a})`],
      [1, "rgba(255, 110, 20, 0)"],
    ]);
    for (const turn of [0, Math.PI / 2]) {
      const ang = now / 700 + turn;
      const len = u * (0.42 + Math.random() * 0.2) * a;
      const dx = Math.cos(ang) * len;
      const dy = Math.sin(ang) * len;
      const ray = g.createLinearGradient(px - dx, py - dy, px + dx, py + dy);
      ray.addColorStop(0, "rgba(255, 240, 200, 0)");
      ray.addColorStop(0.5, `rgba(255, 248, 225, ${0.85 * a})`);
      ray.addColorStop(1, "rgba(255, 240, 200, 0)");
      g.strokeStyle = ray;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px - dx, py - dy);
      g.lineTo(px + dx, py + dy);
      g.stroke();
    }
    if (now - arcsAt > 45) {
      arcsAt = now;
      arcs = Array.from({ length: 3 }, () => {
        let ang = Math.random() * Math.PI * 2;
        let [ax, ay] = [0, 0];
        const seg: [number, number][] = [[0, 0]];
        const steps = 3 + Math.floor(Math.random() * 2);
        const len = (0.28 + Math.random() * 0.27) / steps;
        for (let k = 0; k < steps; k++) {
          ang += (Math.random() - 0.5) * 1.2;
          ax += Math.cos(ang) * len;
          ay += Math.sin(ang) * len;
          seg.push([ax, ay]);
        }
        return seg;
      });
    }
    for (const [width, color] of [
      [2, `rgba(255, 170, 60, ${0.25 * a})`],
      [0.8, `rgba(255, 244, 210, ${0.8 * a})`],
    ] as const) {
      g.strokeStyle = color;
      g.lineWidth = width;
      for (const arc of arcs) {
        g.beginPath();
        arc.forEach(([ax, ay], k) => {
          if (k) g.lineTo(px + ax * u * a, py + ay * u * a);
          else g.moveTo(px, py);
        });
        g.stroke();
      }
    }
    glow(px, py, u * 0.32 * (0.9 + Math.random() * 0.2) * Math.max(0.3, a), [
      [0, `rgba(255, 255, 255, ${a})`],
      [0.3, `rgba(255, 248, 215, ${a})`],
      [0.65, `rgba(255, 190, 90, ${0.85 * a})`],
      [1, "rgba(255, 140, 40, 0)"],
    ]);
    g.globalCompositeOperation = "source-over";
  };

  /** The lamp at the end of the wire, `on` of the way lit. */
  const drawLamp = (on: number, now: number) => {
    const ex = sx(end[0]);
    const ey = sy(end[1]);
    const bx = sx(end[0]);
    const by = sy(bulbY);
    const r = BULB * u;
    if (on > 0) {
      g.globalCompositeOperation = "lighter";
      const breathe = 1 + Math.sin(now / 600) * 0.04;
      glow(bx, by, u * 4.2 * breathe, [
        [0, `rgba(255, 200, 110, ${0.45 * on})`],
        [0.4, `rgba(255, 150, 60, ${0.16 * on})`],
        [1, "rgba(255, 120, 30, 0)"],
      ]);
      // rays turning slowly round it
      g.strokeStyle = `rgba(255, 210, 130, ${0.16 * on})`;
      g.lineWidth = 3;
      for (let k = 0; k < 12; k++) {
        const ang = now / 4000 + (k / 12) * Math.PI * 2;
        const reach = r * (2.1 + 0.35 * Math.sin(now / 500 + k * 1.7));
        g.beginPath();
        g.moveTo(bx + Math.cos(ang) * r * 1.25, by + Math.sin(ang) * r * 1.25);
        g.lineTo(bx + Math.cos(ang) * reach, by + Math.sin(ang) * reach);
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
    }
    // the screw base, the wire going into it
    const bw = 0.82 * u;
    const top = ey - BASE * u;
    const metal = g.createLinearGradient(ex - bw / 2, 0, ex + bw / 2, 0);
    metal.addColorStop(0, "#55585f");
    metal.addColorStop(0.45, "#b4b7bf");
    metal.addColorStop(1, "#4a4d54");
    g.fillStyle = metal;
    g.fillRect(ex - bw / 2, top, bw, BASE * u);
    g.strokeStyle = "rgba(0, 0, 0, 0.35)";
    g.lineWidth = 1.2;
    for (let k = 1; k < 4; k++) {
      const ly = top + (BASE * u * k) / 4;
      g.beginPath();
      g.moveTo(ex - bw / 2, ly - 2);
      g.lineTo(ex + bw / 2, ly + 2);
      g.stroke();
    }
    // the glass
    g.beginPath();
    g.moveTo(ex - bw * 0.42, top + 1);
    g.bezierCurveTo(ex - bw * 0.42, top - r * 0.35, bx - r, by + r * 0.55, bx - r, by);
    g.arc(bx, by, r, Math.PI, 0);
    g.bezierCurveTo(bx + r, by + r * 0.55, ex + bw * 0.42, top - r * 0.35, ex + bw * 0.42, top + 1);
    g.closePath();
    if (on > 0) {
      const fill = g.createRadialGradient(bx, by + r * 0.15, 0, bx, by, r * 1.1);
      fill.addColorStop(0, `rgba(255, 250, 225, ${0.95 * on})`);
      fill.addColorStop(0.55, `rgba(255, 200, 110, ${0.8 * on})`);
      fill.addColorStop(1, `rgba(255, 150, 60, ${0.55 * on})`);
      g.fillStyle = fill;
    } else g.fillStyle = "rgba(210, 220, 235, 0.07)";
    g.fill();
    g.strokeStyle = on > 0 ? `rgba(255, 225, 170, ${0.4 + 0.3 * on})` : "rgba(225, 230, 240, 0.35)";
    g.lineWidth = 1.5;
    g.stroke();
    // its shine
    g.strokeStyle = "rgba(255, 255, 255, 0.25)";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(bx, by, r * 0.72, Math.PI * 1.15, Math.PI * 1.45);
    g.stroke();
    // the filament: a zigzag too, on its two wires
    const fy = by + r * 0.12;
    const fw = r * 0.38;
    const filament = () => {
      g.beginPath();
      g.moveTo(ex - bw * 0.2, top);
      g.lineTo(bx - fw, fy);
      for (let k = 0; k <= 6; k++)
        g.lineTo(bx - fw + (2 * fw * k) / 6, fy + (k % 2 ? -1 : 1) * r * 0.1);
      g.lineTo(ex + bw * 0.2, top);
    };
    filament();
    g.strokeStyle = on > 0 ? `rgba(255, 248, 225, ${0.6 + 0.4 * on})` : "#7a6a58";
    g.lineWidth = 1.2;
    g.stroke();
    if (on > 0) {
      g.globalCompositeOperation = "lighter";
      filament();
      g.strokeStyle = `rgba(255, 180, 80, ${0.5 * on})`;
      g.lineWidth = 4;
      g.stroke();
      g.globalCompositeOperation = "source-over";
    }
  };

  const draw = (now: number, dt: number) => {
    const w = Math.round(canvas.clientWidth);
    if (!w) return;
    if (w !== cw) {
      cw = w;
      ch = Math.round(w * 1.38);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // close up: eight steps across, the view following the spark sideways as well
      u = cw / 8;
    }
    // the view follows the spark up; at the lamp it settles on the lamp; after a fall, back down
    const aim =
      mode === "won" ? bulbY - (ch * 0.3) / u : mode === "out" ? lost.y : mode === "run" ? y : 0;
    view += (aim - view) * Math.min(1, dt * (mode === "ready" ? 5 : 7));
    const aside =
      mode === "won" ? end[0] : mode === "out" ? lost.x * 0.65 : mode === "run" ? x * 0.65 : 0;
    across += (aside - across) * Math.min(1, dt * 3);
    g.clearRect(0, 0, cw, ch);
    g.fillStyle = "#16171b";
    g.fillRect(0, 0, cw, ch);
    // a faint grid of dots, moving with the view
    g.fillStyle = "rgba(242, 239, 234, 0.05)";
    const top = Math.ceil(view + (ch * 0.72) / u) + 1;
    for (let j = Math.floor(view - (ch * 0.28) / u) - 1; j <= top; j++)
      for (let i = Math.floor(across - 5); i <= Math.ceil(across + 5); i++) {
        g.beginPath();
        g.arc(sx(i), sy(j), 1, 0, Math.PI * 2);
        g.fill();
      }
    // the wire's bed, its edge, the copper in the middle
    g.lineJoin = "round";
    g.lineCap = "round";
    line(path);
    g.strokeStyle = "#33353c";
    g.lineWidth = p.width * u + 4;
    g.stroke();
    g.strokeStyle = "#202227";
    g.lineWidth = p.width * u;
    g.stroke();
    g.strokeStyle = "#5a4632";
    g.lineWidth = 2;
    g.stroke();
    // the start: a terminal
    g.fillStyle = "#2a2c31";
    g.strokeStyle = "#4a4d55";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(sx(0), sy(0), u * 0.42, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    // the wire lit behind the spark
    const head: [number, number] =
      mode === "out" ? [lost.x, lost.y] : mode === "won" ? reached : [x, y];
    const behind = mode === "ready" ? [] : [...trail, head];
    g.globalCompositeOperation = "lighter";
    if (behind.length > 1) {
      line(behind);
      g.strokeStyle = "rgba(255, 130, 40, 0.16)";
      g.lineWidth = 9;
      g.stroke();
      g.strokeStyle = "rgba(255, 175, 80, 0.85)";
      g.lineWidth = 2.2;
      g.stroke();
    }
    // at the lamp: light runs back down the whole wire
    const t = (now - since) / 1000;
    if (mode === "won") {
      const back = Math.min(1, Math.max(0, (t - 0.25) / 0.9));
      if (back > 0) {
        const s = length * (1 - back);
        line([pointAt(s), ...path.filter((_, k) => (along[k] as number) > s)]);
        g.strokeStyle = "rgba(255, 140, 40, 0.22)";
        g.lineWidth = 12;
        g.stroke();
        g.strokeStyle = "rgba(255, 210, 140, 0.9)";
        g.lineWidth = 2.6;
        g.stroke();
        if (back < 1) {
          const [qx, qy] = pointAt(s);
          glow(sx(qx), sy(qy), u * 0.9, [
            [0, "rgba(255, 250, 230, 0.95)"],
            [0.4, "rgba(255, 190, 90, 0.4)"],
            [1, "rgba(255, 140, 40, 0)"],
          ]);
        }
      }
    }
    g.globalCompositeOperation = "source-over";
    // the lamp: dark, then lit, a flash as it comes on
    const on = mode === "won" ? Math.min(1, Math.max(0, (t - 0.22) / 0.45)) : 0;
    drawLamp(on, now);
    if (mode === "won" && t > 0.22 && t < 0.8) {
      const f = (t - 0.22) / 0.58;
      g.globalCompositeOperation = "lighter";
      glow(sx(end[0]), sy(bulbY), u * (1.5 + 6 * f), [
        [0, `rgba(255, 255, 240, ${0.85 * (1 - f)})`],
        [0.5, `rgba(255, 200, 120, ${0.35 * (1 - f)})`],
        [1, "rgba(255, 160, 60, 0)"],
      ]);
      g.globalCompositeOperation = "source-over";
    }
    // the bits of fire and smoke
    for (const b of bits) {
      const f = b.age / b.life;
      const bx = sx(b.x);
      const by = sy(b.y);
      if (b.smoke) {
        g.fillStyle = `rgba(130, 132, 140, ${0.22 * (1 - f)})`;
        g.beginPath();
        g.arc(bx, by, (b.size + f * 0.9) * u, 0, Math.PI * 2);
        g.fill();
        continue;
      }
      g.globalCompositeOperation = "lighter";
      g.strokeStyle =
        f < 0.25
          ? `rgba(255, 250, 225, ${1 - f})`
          : f < 0.6
            ? `rgba(255, 190, 90, ${1 - f})`
            : `rgba(255, 110, 40, ${1 - f})`;
      g.lineWidth = b.size;
      g.beginPath();
      g.moveTo(bx, by);
      g.lineTo(bx - b.vx * u * 0.035, by + b.vy * u * 0.035);
      g.stroke();
      g.globalCompositeOperation = "source-over";
    }
    // the spark: waiting at the start, running, dying off the wire, flying into the lamp
    if (mode === "ready" || mode === "run") drawSpark(sx(x), sy(y), 1, now);
    else if (mode === "out") {
      const fade = Math.max(0, 1 - t / 0.6);
      drawSpark(sx(lost.x), sy(lost.y), fade * (0.4 + Math.random() * 0.6), now);
    } else if (t < 0.25) {
      const k = t / 0.25;
      drawSpark(
        sx(reached[0] + (end[0] - reached[0]) * k),
        sy(reached[1] + (bulbY - reached[1]) * k),
        1 - k * 0.5,
        now,
      );
    }
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    advance(now);
    const dt = Math.max(0, Math.min(0.05, (now - lastFrame) / 1000));
    lastFrame = now;
    const t = (now - since) / 1000;
    // fire off the spark as it runs, a little as it waits
    const rate = (mode === "run" ? 70 : mode === "ready" ? 22 : 0) * (still ? 0.4 : 1);
    if (rate && Math.random() < rate * dt * 2) {
      const v = mode === "run" ? speedAt(y) : 0;
      if (mode === "run") burst(2, x, y, -dir * v, -v, 1.6, [0.8, 2.6]);
      else burst(1, x, y, 0, 1, Math.PI * 2, [0.4, 1.4]);
    }
    if (mode === "out") {
      lost.x += lost.vx * dt;
      lost.y += lost.vy * dt;
      lost.vx *= Math.exp(-6 * dt);
      lost.vy *= Math.exp(-6 * dt);
      if (t > 0.95) {
        // the spark lit again at the start
        mode = "ready";
        since = now;
        attempt++;
        x = 0;
        y = 0;
        dir = p.first;
        trail = [[0, 0]];
        snap = null;
        passed = 0;
        burst(12, 0, 0, 0, 1, Math.PI * 2, [0.8, 2.4]);
        say();
      }
    }
    if (mode === "won") {
      if (!flashed && t > 0.25) {
        flashed = true;
        burst(60, end[0], bulbY, 0, 1, Math.PI * 2, [2, 6]);
        navigator.vibrate?.(40);
      }
      if (!lit && t > 1.15) {
        lit = true;
        ctx.done(`лампа горить з ${attempt}-ї спроби`);
      }
    }
    for (const b of bits) {
      b.age += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (!b.smoke) {
        b.vx *= Math.exp(-2.5 * dt);
        b.vy *= Math.exp(-2.5 * dt);
      }
    }
    bits = bits.filter((b) => b.age < b.life);
    draw(now, dt);
  };

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    tap();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== " " && e.key !== "Enter" && e.key !== "ArrowUp") return;
    e.preventDefault();
    tap();
  };
  document.addEventListener("keydown", onKey);
  say();
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    document.removeEventListener("keydown", onKey);
  };
}

// ── Комора ──────────────────────────────────────────────────────────────────────────────────

/** Each thing's icon: the power, the light, the connection, level by level. */
const STORE_ICONS: readonly (readonly GameIcon[])[] = [
  ["cell", "bank", "accu", "station", "generator"],
  ["match", "candle", "flashlight", "lamp", "garland"],
  ["headphones", "phone", "tablet", "laptop", "tv"],
];
/** The kinds' colours: the power blue, the light orange, the connection green (r, g, b for tints). */
const STORE_INK = ["#b4c6ea", "#ffb36b", "#93dcb6"];
const STORE_TINT = ["143, 163, 200", "255, 154, 61", "124, 198, 160"];

/** «1 хід», «3 ходи», «7 ходів». */
const moveWord = (k: number) =>
  k % 10 === 1 && k % 100 !== 11
    ? "хід"
    : k % 10 >= 2 && k % 10 <= 4 && (k % 100 < 12 || k % 100 > 14)
      ? "ходи"
      : "ходів";

export function mountStore(root: HTMLElement, p: StorePuzzle, ctx: GameCtx): Cleanup {
  const { rows, cols } = p;
  const vw = 320;
  const ts = Math.min(52, Math.floor((vw - 8) / cols));
  const bw = ts * cols;
  const bx = (vw - bw) / 2;
  // the order on top, a card for each thing wanted; the store under it
  const n = p.order.length;
  const ch = 72;
  const oy = 4;
  const cw = Math.min(100, (vw - 8 - (n - 1) * 8) / n);
  const cx0 = (vw - (n * cw + (n - 1) * 8)) / 2;
  const cardAt = (k: number) => cx0 + k * (cw + 8);
  const by = oy + ch + 14;
  const vh = by + ts * rows + 6;
  const svg = svgRoot(root, vw, vh, "g-drag");
  const layer = svgEl("g", {}, svg);
  /** A thing carried sits under the finger, a little above it, so it shows round the fingertip. */
  const lift = ts * 0.25;

  let s = storeStart(p);
  let moves = 0;
  let won = false;
  let drag: { cell: number; x: number; y: number; sx: number; sy: number; moved: boolean } | null =
    null;
  let held: SVGElement | null = null;
  /** The element each cell's thing is drawn in. */
  const shown: (SVGElement | undefined)[] = [];
  /** What has just happened, to be shown: a join, boxes opened, a card filled. */
  let joined = -1;
  let opened = new Set<number>();
  let filled = -1;

  const text = (
    parent: Element,
    x: number,
    y: number,
    size: number,
    value: string,
    fill: string,
  ) => {
    const t = svgEl(
      "text",
      {
        x,
        y,
        "text-anchor": "middle",
        style: `font:700 ${size}px "Manrope Variable",sans-serif;fill:${fill}`,
      },
      parent,
    );
    t.textContent = value;
  };
  /** A thing on a tile `size` across, its top left at (x, y): its icon, a dot for each level. */
  const drawItem = (
    parent: Element,
    x: number,
    y: number,
    size: number,
    item: StoreItem,
    cls = "",
  ) => {
    const g = svgEl("g", cls ? { class: cls } : {}, parent);
    const tint = STORE_TINT[item.kind] as string;
    const ink = STORE_INK[item.kind] as string;
    svgEl(
      "rect",
      {
        x: x + 3,
        y: y + 3,
        width: size - 6,
        height: size - 6,
        rx: 10,
        style: `fill:rgba(${tint},${0.08 + item.level * 0.05});stroke:rgba(${tint},${0.22 + item.level * 0.09});stroke-width:1.3`,
      },
      g,
    );
    svgIcon(
      g,
      (STORE_ICONS[item.kind] as GameIcon[])[item.level - 1] as GameIcon,
      x + size / 2,
      y + size * 0.44,
      size * 0.5,
      ink,
    );
    const r = size * 0.042;
    const gap = r * 2.7;
    const x0 = x + size / 2 - ((item.level - 1) * gap) / 2;
    for (let k = 0; k < item.level; k++)
      svgEl("circle", { cx: x0 + k * gap, cy: y + size * 0.82, r, style: `fill:${ink}` }, g);
    return g;
  };
  /** A box, shut: boards, a brace across, nails. */
  const drawBox = (parent: Element, x: number, y: number, size: number, cls = "") => {
    const g = svgEl("g", cls ? { class: cls } : {}, parent);
    const m = 4;
    svgEl(
      "rect",
      {
        x: x + m,
        y: y + m,
        width: size - 2 * m,
        height: size - 2 * m,
        rx: 6,
        style: "fill:#5e4730;stroke:#7d6142;stroke-width:1.5",
      },
      g,
    );
    const inner = size - 2 * m;
    svgEl(
      "path",
      {
        d: `M${x + m} ${y + m + inner / 3}h${inner}M${x + m} ${y + m + (inner * 2) / 3}h${inner}`,
        style: "stroke:#3e2e1d;stroke-width:1.4",
      },
      g,
    );
    svgEl(
      "path",
      {
        d: `M${x + m + 4} ${y + size - m - 4}L${x + size - m - 4} ${y + m + 4}`,
        style: "stroke:#8a6c4a;stroke-width:3;stroke-linecap:round",
      },
      g,
    );
    for (const [nx, ny] of [
      [x + m + 5, y + m + 5],
      [x + size - m - 5, y + m + 5],
      [x + m + 5, y + size - m - 5],
      [x + size - m - 5, y + size - m - 5],
    ] as const)
      svgEl("circle", { cx: nx, cy: ny, r: 1.3, style: "fill:#2c2014" }, g);
    return g;
  };
  const cellXY = (i: number): [number, number] => [
    bx + (i % cols) * ts,
    by + Math.floor(i / cols) * ts,
  ];
  const left = () => p.moves - moves;
  const status = () =>
    `Тягни річ на таку саму: дві стануть однією, рівнем вище. З'єднай поруч з коробкою і вона відкриється · лишилось ${left()} ${moveWord(left())}`;

  const draw = () => {
    layer.replaceChildren();
    held = null;
    const carried = drag?.moved ? s.cells[drag.cell] : null;
    // the order: each card lights up when the thing carried is the one it wants
    p.order.forEach((o, k) => {
      const x = cardAt(k);
      const done = s.handed[k];
      const wants = !done && carried && carried.kind === o.kind && carried.level === o.level;
      const g = svgEl(
        "g",
        {
          ...(k === filled ? { class: "g-store-pop" } : {}),
          style: done ? "opacity:0.5" : "",
        },
        layer,
      );
      svgEl(
        "rect",
        {
          x,
          y: oy,
          width: cw,
          height: ch,
          rx: 12,
          style: `fill:${wants ? "rgba(255,154,61,0.16)" : "rgba(242,239,234,0.04)"};stroke:${wants ? LIGHT : DIM};stroke-width:${wants ? 2 : 1.2};${done ? "" : "stroke-dasharray:5 4"}`,
        },
        g,
      );
      const ink = STORE_INK[o.kind] as string;
      svgIcon(
        g,
        (STORE_ICONS[o.kind] as GameIcon[])[o.level - 1] as GameIcon,
        x + cw / 2,
        oy + 23,
        28,
        ink,
      );
      text(
        g,
        x + cw / 2,
        oy + 50,
        10.5,
        (STORE_NAMES[o.kind] as readonly string[])[o.level - 1] as string,
        TEXT,
      );
      const r = 2.2;
      const x0 = x + cw / 2 - ((o.level - 1) * r * 2.7) / 2;
      for (let d = 0; d < o.level; d++)
        svgEl("circle", { cx: x0 + d * r * 2.7, cy: oy + 61, r, style: `fill:${ink}` }, g);
      if (done) {
        svgEl("circle", { cx: x + cw - 12, cy: oy + 12, r: 8, style: `fill:${LIGHT}` }, g);
        svgEl(
          "path",
          {
            d: `M${x + cw - 16} ${oy + 12}l3 3 5-6`,
            style: `fill:none;stroke:${INK};stroke-width:2;stroke-linecap:round;stroke-linejoin:round`,
          },
          g,
        );
      }
    });
    // the store: its floor, the cells, the things and the boxes
    svgEl(
      "rect",
      { x: bx - 4, y: by - 4, width: bw + 8, height: ts * rows + 8, rx: 12, style: `fill:${TILE}` },
      layer,
    );
    for (let i = 0; i < rows * cols; i++) {
      const [x, y] = cellXY(i);
      svgEl(
        "rect",
        {
          x: x + 3,
          y: y + 3,
          width: ts - 6,
          height: ts - 6,
          rx: 10,
          style: "fill:rgba(0,0,0,0.18)",
        },
        layer,
      );
    }
    s.cells.forEach((item, i) => {
      if (!item) return;
      const [x, y] = cellXY(i);
      if (s.boxed.has(i)) {
        shown[i] = drawBox(layer, x, y, ts);
        return;
      }
      const cls = i === joined ? "g-store-pop" : opened.has(i) ? "g-store-open" : "";
      shown[i] = drawItem(layer, x, y, ts, item, cls);
      // the same as the one carried: where it may go
      if (
        carried &&
        i !== drag?.cell &&
        item.kind === carried.kind &&
        item.level === carried.level &&
        item.level < STORE_LEVELS
      )
        svgEl(
          "rect",
          {
            x: x + 2,
            y: y + 2,
            width: ts - 4,
            height: ts - 4,
            rx: 11,
            style: `fill:none;stroke:${LIGHT};stroke-width:2`,
          },
          layer,
        );
      if (i === joined)
        svgEl(
          "circle",
          {
            cx: x + ts / 2,
            cy: y + ts / 2,
            r: ts * 0.42,
            class: "g-store-ring",
            style: `fill:none;stroke:${LIGHT};stroke-width:3`,
          },
          layer,
        );
      if (opened.has(i)) drawBox(layer, x, y, ts, "g-store-gone");
    });
    // the thing carried, over everything, above the finger
    if (drag?.moved && carried) {
      shown[drag.cell]?.setAttribute("display", "none");
      const g = svgEl(
        "g",
        { transform: `translate(${drag.x - ts / 2} ${drag.y - lift - ts / 2})` },
        layer,
      );
      svgEl(
        "rect",
        { x: 5, y: 9, width: ts - 6, height: ts - 6, rx: 10, style: "fill:rgba(0,0,0,0.35)" },
        g,
      );
      svgEl(
        "rect",
        { x: 3, y: 3, width: ts - 6, height: ts - 6, rx: 10, style: "fill:#2a2c31" },
        g,
      );
      drawItem(g, 0, 0, ts, carried);
      held = g;
    }
    joined = -1;
    opened = new Set();
    filled = -1;
  };
  /** Something wanted lying out there to hand in. */
  const handable = () =>
    p.order.some(
      (o, k) =>
        !s.handed[k] &&
        s.cells.some((c, i) => !s.boxed.has(i) && c?.kind === o.kind && c.level === o.level),
    );
  const report = () => {
    if (won) return;
    const out = left() <= 0 && !handable();
    ctx.say(
      status(),
      out
        ? "ходи скінчилися, почни спочатку"
        : storeStuck(p, s)
          ? "ходів більше немає, почни спочатку"
          : undefined,
    );
  };

  const cellAt = (x: number, y: number) => {
    const c = Math.floor((x - bx) / ts);
    const r = Math.floor((y - by) / ts);
    return r >= 0 && r < rows && c >= 0 && c < cols ? r * cols + c : -1;
  };
  svg.addEventListener("pointerdown", (e) => {
    if (won || drag) return;
    const [x, y] = pointIn(svg, e, vw, vh);
    const cell = cellAt(x, y);
    if (cell < 0 || !s.cells[cell] || s.boxed.has(cell)) return;
    drag = { cell, x, y, sx: x, sy: y, moved: false };
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      // a pointer gone already: the moves still come to the board
    }
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [x, y] = pointIn(svg, e, vw, vh);
    drag.x = x;
    drag.y = y;
    if (!drag.moved) {
      if (Math.hypot(x - drag.sx, y - drag.sy) <= 6) return;
      drag.moved = true;
      draw();
      return;
    }
    held?.setAttribute("transform", `translate(${x - ts / 2} ${y - lift - ts / 2})`);
  });
  svg.addEventListener("pointerup", () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    // where the thing carried is let go: on a card that wants it, or on a thing just like it
    const cx = d.x;
    const cy = d.y - lift;
    const slot = p.order.findIndex(
      (_, k) => cx >= cardAt(k) && cx <= cardAt(k) + cw && cy >= oy && cy <= oy + ch,
    );
    if (slot >= 0) {
      const next = storeHand(p, s, d.cell, slot);
      if (next) {
        s = next;
        filled = slot;
        navigator.vibrate?.(20);
      }
    } else {
      const to = cellAt(cx, cy);
      const next = to >= 0 && left() > 0 ? storeMerge(p, s, d.cell, to) : null;
      if (next) {
        s = next.state;
        joined = to;
        opened = new Set(next.opened);
        moves++;
        navigator.vibrate?.(next.opened.length ? [12, 40, 20] : 12);
      }
    }
    if (s.handed.every(Boolean)) {
      won = true;
      ctx.done(`замовлення зібрано за ${moves} ${moveWord(moves)} з ${p.moves}`);
    }
    draw();
    report();
  });
  svg.addEventListener("pointercancel", () => {
    drag = null;
    draw();
  });

  draw();
  report();
  return undefined;
}

// ── Запам'яталка ────────────────────────────────────────────────────────────────────────────

export function mountMemo(root: HTMLElement, p: MemoPuzzle, ctx: GameCtx): Cleanup {
  const total = p.cards.length / 2;
  const grid = document.createElement("div");
  grid.className = "g-memo";
  grid.style.setProperty("--cols", String(p.cols));
  root.appendChild(grid);
  const cards = p.cards.map((thing, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "g-memo-card";
    b.setAttribute("aria-label", `Вікно ${i + 1}`);
    b.innerHTML = `<span class="g-memo-inner"><span class="g-memo-back"></span><span class="g-memo-face">${icon(thing, 30)}</span></span>`;
    b.addEventListener("click", () => open(i));
    grid.appendChild(b);
    return b;
  });
  /** The windows lit that are not a pair yet (one, or two not alike, about to go dark). */
  let shown: number[] = [];
  const found = new Set<number>();
  let misses = 0;
  let over = false;
  let won = false;
  let dark = 0;

  const status = () => {
    const left = Math.max(0, p.misses - misses);
    ctx.say(
      `Знайди пари: тапни два вікна · пар ${found.size / 2} з ${total} · можна помилитися ще ${left}`,
      over ? "помилок забагато, почни спочатку" : undefined,
    );
  };
  const paint = () => {
    cards.forEach((b, i) => {
      b.toggleAttribute("data-open", found.has(i) || shown.includes(i) || over);
      b.toggleAttribute("data-done", found.has(i));
      b.disabled = won || over;
    });
  };
  /** The two lit that were not alike go dark again. */
  const close = () => {
    window.clearTimeout(dark);
    for (const i of shown) cards[i]?.removeAttribute("data-miss");
    shown = [];
    paint();
  };

  function open(i: number) {
    if (won || over || found.has(i) || shown.includes(i)) return;
    if (shown.length === 2) close();
    shown.push(i);
    if (shown.length === 2) {
      const [a, b] = shown as [number, number];
      if (p.cards[a] === p.cards[b]) {
        found.add(a);
        found.add(b);
        shown = [];
        for (const k of [a, b]) {
          const card = cards[k];
          card?.removeAttribute("data-hit");
          void card?.offsetWidth;
          card?.setAttribute("data-hit", "");
        }
        navigator.vibrate?.(15);
        if (found.size === p.cards.length) {
          won = true;
          ctx.done(`усі ${total} пар · помилок ${misses}`);
        }
      } else {
        misses++;
        for (const k of shown) cards[k]?.setAttribute("data-miss", "");
        if (misses > p.misses) {
          over = true;
          navigator.vibrate?.([30, 40, 30]);
        } else dark = window.setTimeout(close, 900);
      }
    }
    paint();
    status();
  }

  paint();
  status();
  return () => window.clearTimeout(dark);
}

// ── Змійка ──────────────────────────────────────────────────────────────────────────────────

/** A bolt's outline, on a cell from -0.5 to 0.5 both ways. */
const BOLT = [
  [0.14, -0.46],
  [-0.22, 0.06],
  [0.02, 0.06],
  [-0.12, 0.46],
  [0.26, -0.1],
  [0.02, -0.1],
  [0.2, -0.46],
] as const;

export function mountSnake(root: HTMLElement, p: SnakePuzzle, ctx: GameCtx): Cleanup {
  const canvas = document.createElement("canvas");
  canvas.className = "g-snake-board";
  canvas.setAttribute("aria-label", "Дріт повзе полем; свайп або стрілки повертають його");
  root.appendChild(canvas);
  const g = canvas.getContext("2d");
  if (!g) return undefined;
  const { cols, rows } = p;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  type Mode = "ready" | "run" | "out" | "won";
  let mode: Mode = "ready";
  let since = performance.now();
  let attempt = 1;
  let rng = rngOf(p.seed);
  let s = snakeStart(p, rng);
  /** Where the wire lay before its last step: it is drawn sliding from there. */
  let before = s.body.slice();
  /** Turns asked for, taken one a step. */
  let turns: number[] = [];
  let lastStep = since;
  let lastPuddle = since;
  /** When the bolt came into sight; its time running from when, until when (none at the start). */
  let boltShown = since;
  let boltFrom = since;
  let boltUntil = Number.POSITIVE_INFINITY;
  let died: "self" | "puddle" | null = null;
  let reported = false;
  let raf = 0;
  let lastFrame = since;
  let said = "";
  type Bit = {
    x: number;
    y: number;
    vx: number;
    vy: number;
    age: number;
    life: number;
    color: string;
  };
  let bits: Bit[] = [];

  const stepMs = () => 1000 / (p.speed + p.speedup * s.score);
  const say = (warn?: string) => {
    const tries = attempt > 1 ? ` · спроба ${attempt}` : "";
    // the count and the tries on a line of their own
    const text = `Свайпай і дріт поповзе в напрямок свайпу. Збирай блискавки, калюжі оминай\n${s.score} з ${p.goal}${tries}`;
    if (text + (warn ?? "") === said) return;
    said = text + (warn ?? "");
    ctx.say(text, warn);
  };
  const burst = (cell: number, count: number, colors: string[], speed: number) => {
    const x = (cell % cols) + 0.5;
    const y = Math.floor(cell / cols) + 0.5;
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.8);
      bits.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        age: 0,
        life: 0.35 + Math.random() * 0.4,
        color: colors[k % colors.length] as string,
      });
    }
  };

  const turn = (d: number) => {
    if (mode === "ready") {
      if ((d + 2) % 4 === s.dir) return;
      mode = "run";
      const now = performance.now();
      since = now;
      // the first step at once, sliding on from where it lies (not a cell back, then forwards)
      lastStep = now - stepMs();
      lastPuddle = now;
      // the bolt's time starts; it stays in sight as it was
      boltFrom = now;
      boltUntil = now + p.boltLife * 1000;
      turns = [d];
      say();
      return;
    }
    if (mode !== "run") return;
    const last = turns.at(-1) ?? s.dir;
    if (d === last || (d + 2) % 4 === last || turns.length >= 2) return;
    turns.push(d);
  };

  const step = (now: number) => {
    const d = turns.shift() ?? s.dir;
    const next = snakeStep(p, s, d, rng);
    if (next.died) {
      died = next.died;
      mode = "out";
      since = now;
      s = next.state;
      before = s.body.slice();
      burst(s.body[0] as number, 30, ["#fff3c0", "#ffb347", "#ff6b57"], 6);
      if (died === "puddle") burst(s.body[0] as number, 16, ["#9fd0ff", "#4da3ff"], 4);
      navigator.vibrate?.([30, 40, 30]);
      say(died === "self" ? "дріт заплутався сам у собі" : "вода й струм: коротке замикання");
      return;
    }
    before = s.body.slice();
    if (next.ate) {
      before.push(before.at(-1) as number);
      burst(s.bolt, 14, ["#fff3c0", "#ffd27a"], 4);
      navigator.vibrate?.(12);
    }
    s = next.state;
    if (next.ate) {
      boltShown = now;
      boltFrom = now;
      boltUntil = now + p.boltLife * 1000;
      say();
    }
    if (s.score >= p.goal) {
      mode = "won";
      since = now;
      burst(s.body[0] as number, 50, ["#fff3c0", "#ffd27a", "#ff9a3d"], 7);
    }
  };

  // ── drawing ──
  let cw = 0;
  let u = 0;
  const cx = (cell: number) => ((cell % cols) + 0.5) * u;
  const cy = (cell: number) => (Math.floor(cell / cols) + 0.5) * u;
  const glow = (x: number, y: number, r: number, stops: [number, string][]) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    for (const [at, color] of stops) grad.addColorStop(at, color);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };

  const draw = (now: number) => {
    const w = Math.round(canvas.clientWidth);
    if (!w) return;
    if (w !== cw) {
      cw = w;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(((cw * rows) / cols) * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      u = cw / cols;
    }
    const ch = u * rows;
    g.fillStyle = "#16171b";
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = "rgba(242, 239, 234, 0.06)";
    for (let c = 0; c < cols * rows; c++) {
      g.beginPath();
      g.arc(cx(c), cy(c), 1.1, 0, Math.PI * 2);
      g.fill();
    }
    // the bolt, its glow breathing; like a puddle it grows in, a ring round it runs out, it
    // blinks before it goes (waiting at the start, it stays, its ring full)
    if (s.bolt >= 0) {
      const bx = cx(s.bolt);
      const by = cy(s.bolt);
      const born = Math.min(1, (now - boltShown) / 250);
      const left = Number.isFinite(boltUntil)
        ? Math.max(0, (boltUntil - now) / (boltUntil - boltFrom))
        : 1;
      const blink =
        boltUntil - now < 900 && !still ? 0.45 + 0.55 * Math.abs(Math.sin(now / 90)) : 1;
      g.globalAlpha = blink;
      g.globalCompositeOperation = "lighter";
      glow(bx, by, u * (0.8 + 0.1 * Math.sin(now / 250)) * born, [
        [0, "rgba(255, 210, 122, 0.45)"],
        [1, "rgba(255, 160, 60, 0)"],
      ]);
      g.globalCompositeOperation = "source-over";
      g.fillStyle = "#ffd27a";
      g.beginPath();
      BOLT.forEach(([x, y], k) => {
        if (k) g.lineTo(bx + x * u * 0.9 * born, by + y * u * 0.9 * born);
        else g.moveTo(bx + x * u * 0.9 * born, by + y * u * 0.9 * born);
      });
      g.closePath();
      g.fill();
      g.strokeStyle = "rgba(255, 210, 122, 0.6)";
      g.lineWidth = 2;
      g.beginPath();
      g.arc(bx, by, u * 0.47, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
    }
    // the puddles: a drop of water each, a ring round it running out, blinking at the end
    for (const w of s.puddles) {
      const born = Math.min(1, (now - w.from) / 250);
      const left = Math.max(0, (w.until - now) / (w.until - w.from));
      const blink = w.until - now < 900 ? 0.45 + 0.55 * Math.abs(Math.sin(now / 90)) : 1;
      const x = cx(w.cell);
      const y = cy(w.cell);
      const k = u * 0.82 * born;
      g.globalAlpha = blink;
      g.fillStyle = "rgba(77, 163, 255, 0.18)";
      g.beginPath();
      g.ellipse(x, y + u * 0.22, u * 0.42 * born, u * 0.14 * born, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#4da3ff";
      g.beginPath();
      g.moveTo(x, y - 0.44 * k);
      g.bezierCurveTo(
        x + 0.18 * k,
        y - 0.18 * k,
        x + 0.32 * k,
        y + 0.02 * k,
        x + 0.32 * k,
        y + 0.14 * k,
      );
      g.arc(x, y + 0.14 * k, 0.32 * k, 0, Math.PI);
      g.bezierCurveTo(x - 0.32 * k, y + 0.02 * k, x - 0.18 * k, y - 0.18 * k, x, y - 0.44 * k);
      g.fill();
      g.fillStyle = "rgba(255, 255, 255, 0.55)";
      g.beginPath();
      g.arc(x - 0.11 * k, y + 0.08 * k, 0.07 * k, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(77, 163, 255, 0.55)";
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, u * 0.47, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
    }
    // the cable: a round white cord, its shadow on the board, shaded and lit like a tube, a bare
    // copper end at its tail. It slides along a track that stays put — through the middle of each
    // cell it lies on (and the one its tail is leaving), each corner a quarter circle — so its bends
    // hold their shape as it goes (moving each cell's point on its own made them shake)
    const t = mode === "run" ? Math.min(1, (now - lastStep) / stepMs()) : 1;
    // through an edge the track goes on past it (as if the board were laid side by side), and the
    // cable is drawn over again a board across, so what is past one edge comes in at the other
    const across = cols * u;
    const down = rows * u;
    const track: (readonly [number, number])[] = [];
    for (const c of [...s.body, before.at(-1) ?? (s.body.at(-1) as number)]) {
      let x = cx(c);
      let y = cy(c);
      const last = track.at(-1);
      if (last) {
        if (x - last[0] > across / 2) x -= across;
        else if (last[0] - x > across / 2) x += across;
        if (y - last[1] > down / 2) y -= down;
        else if (last[1] - y > down / 2) y += down;
      }
      track.push([x, y]);
    }
    const n = track.length - 1;
    const mid = (k: number) => {
      const [ax, ay] = track[k] as readonly [number, number];
      const [bx, by] = track[k + 1] as readonly [number, number];
      return [(ax + bx) / 2, (ay + by) / 2] as const;
    };
    const line = (a: readonly [number, number], b: readonly [number, number], f: number) =>
      [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] as const;
    /** The point `q` cells along the track from its head end. */
    const along = (q: number): readonly [number, number] => {
      if (q <= 0.5) return line(track[0] as readonly [number, number], mid(0), q / 0.5);
      if (q >= n - 0.5)
        return line(mid(n - 1), track[n] as readonly [number, number], (q - (n - 0.5)) / 0.5);
      // round cell k: from the middle of its edge on one side to the middle of the other
      const k = Math.round(q);
      const f = q - (k - 0.5);
      const a = mid(k - 1);
      const b = mid(k);
      const [px, py] = track[k] as readonly [number, number];
      if (Math.abs((a[0] - px) * (b[1] - py) - (a[1] - py) * (b[0] - px)) < 1e-6)
        return line(a, b, f);
      // a corner: a quarter circle about the cell's corner between the two
      const qx = a[0] + b[0] - px;
      const qy = a[1] + b[1] - py;
      const a0 = Math.atan2(a[1] - qy, a[0] - qx);
      let turn = Math.atan2(b[1] - qy, b[0] - qx) - a0;
      if (turn > Math.PI) turn -= Math.PI * 2;
      if (turn < -Math.PI) turn += Math.PI * 2;
      const r = Math.hypot(a[0] - qx, a[1] - qy);
      return [qx + Math.cos(a0 + turn * f) * r, qy + Math.sin(a0 + turn * f) * r] as const;
    };
    // the head is `1 - t` cells down the track, the tail `n - t`: the length never changes
    const q0 = 1 - t;
    const q1 = n - t;
    const points: (readonly [number, number])[] = [];
    for (let q = q0; q < q1; q += 0.125) points.push(along(q));
    points.push(along(q1));
    const fade = mode === "out" ? Math.max(0.25, 1 - (now - since) / 700) : 1;
    g.globalAlpha = fade;
    g.lineJoin = "round";
    g.lineCap = "round";
    const cord = (ox = 0, oy = 0) => {
      g.beginPath();
      points.forEach(([x, y], k) => {
        if (k) g.lineTo(x + ox, y + oy);
        else g.moveTo(x + ox, y + oy);
      });
    };
    const thick = u * 0.46;
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const shifts: [number, number][] = [];
    for (const ox of [0, -across, across])
      for (const oy of [0, -down, down])
        if (
          Math.min(...xs) + ox < across + u &&
          Math.max(...xs) + ox > -u &&
          Math.min(...ys) + oy < down + u &&
          Math.max(...ys) + oy > -u
        )
          shifts.push([ox, oy]);
    for (const [ox, oy] of shifts) {
      g.save();
      g.translate(ox, oy);
      cord(1.5, 2.5);
      g.strokeStyle = "rgba(0, 0, 0, 0.45)";
      g.lineWidth = thick + 2;
      g.stroke();
      const [tx, ty] = along(q1);
      const [px, py] = along(Math.max(q0, q1 - 0.1));
      const tl = Math.hypot(tx - px, ty - py) || 1;
      g.strokeStyle = "#c98a4b";
      g.lineWidth = thick * 0.4;
      g.beginPath();
      g.moveTo(tx, ty);
      g.lineTo(tx + ((tx - px) / tl) * u * 0.34, ty + ((ty - py) / tl) * u * 0.34);
      g.stroke();
      cord();
      g.strokeStyle = mode === "won" ? "#c9762c" : "#8b8f99";
      g.lineWidth = thick;
      g.stroke();
      g.strokeStyle = mode === "won" ? "#ffb35c" : "#d3d6dd";
      g.lineWidth = thick * 0.74;
      g.stroke();
      cord(-thick * 0.14, -thick * 0.14);
      g.strokeStyle = "rgba(255, 255, 255, 0.7)";
      g.lineWidth = thick * 0.18;
      g.stroke();
      if (mode === "won") {
        g.globalCompositeOperation = "lighter";
        cord();
        g.strokeStyle = `rgba(255, 170, 70, ${0.25 + 0.15 * Math.sin(now / 200)})`;
        g.lineWidth = u * 1.1;
        g.stroke();
        g.globalCompositeOperation = "source-over";
      }
      // the head: a white plug turned the way it goes, two pins ahead, a light on it
      const [hx, hy] = along(q0);
      const [nx, ny] = along(Math.min(q1, q0 + 0.1));
      const [dx, dy] = SNAKE_DIRS[s.dir] as readonly [number, number];
      const ang = hx === nx && hy === ny ? Math.atan2(dy, dx) : Math.atan2(hy - ny, hx - nx);
      const rounded = (x: number, y: number, w2: number, h2: number, r: number) => {
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w2, y, x + w2, y + h2, r);
        g.arcTo(x + w2, y + h2, x, y + h2, r);
        g.arcTo(x, y + h2, x, y, r);
        g.arcTo(x, y, x + w2, y, r);
        g.closePath();
      };
      const plug = (ox: number, oy: number, shadow: boolean) => {
        g.save();
        g.translate(hx + ox, hy + oy);
        g.rotate(ang);
        if (shadow) {
          g.fillStyle = "rgba(0, 0, 0, 0.45)";
          rounded(-0.52 * u, -0.3 * u, 0.82 * u, 0.6 * u, 0.13 * u);
          g.fill();
          g.restore();
          return;
        }
        // the pins
        for (const side of [-1, 1]) {
          const pin = g.createLinearGradient(
            0,
            side * 0.13 * u - 0.05 * u,
            0,
            side * 0.13 * u + 0.05 * u,
          );
          pin.addColorStop(0, "#f4f5f8");
          pin.addColorStop(1, "#8d929c");
          g.fillStyle = pin;
          rounded(0.2 * u, side * 0.13 * u - 0.045 * u, 0.32 * u, 0.09 * u, 0.04 * u);
          g.fill();
        }
        // where the cord goes in, narrowing
        g.fillStyle = "#a3a7b0";
        g.beginPath();
        g.moveTo(-0.32 * u, -0.19 * u);
        g.lineTo(-0.52 * u, -0.14 * u);
        g.lineTo(-0.52 * u, 0.14 * u);
        g.lineTo(-0.32 * u, 0.19 * u);
        g.closePath();
        g.fill();
        // the body
        const shell = g.createLinearGradient(0, -0.3 * u, 0, 0.3 * u);
        shell.addColorStop(0, "#f6f7f9");
        shell.addColorStop(1, "#b4b8c2");
        g.fillStyle = mode === "won" ? "#ffcf8a" : shell;
        rounded(-0.34 * u, -0.3 * u, 0.56 * u, 0.6 * u, 0.13 * u);
        g.fill();
        g.strokeStyle = "#7d818b";
        g.lineWidth = 1;
        g.stroke();
        g.restore();
      };
      plug(1.5, 2.5, true);
      plug(0, 0, false);
      // its light: orange waiting and running, red when it is over, bright at the end
      const lx = hx + Math.cos(ang) * -0.08 * u;
      const ly = hy + Math.sin(ang) * -0.08 * u;
      const lit =
        mode === "out" ? "255, 107, 87" : mode === "won" ? "255, 236, 170" : "255, 154, 61";
      const pulse = mode === "ready" && !still ? 0.55 + 0.45 * Math.abs(Math.sin(now / 400)) : 1;
      g.globalCompositeOperation = "lighter";
      glow(lx, ly, u * 0.45, [
        [0, `rgba(${lit}, ${0.6 * pulse})`],
        [1, `rgba(${lit}, 0)`],
      ]);
      g.globalCompositeOperation = "source-over";
      g.fillStyle = `rgba(${lit}, ${pulse})`;
      g.beginPath();
      g.arc(lx, ly, u * 0.07, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    g.globalAlpha = 1;
    // sparks
    g.globalCompositeOperation = "lighter";
    for (const b of bits) {
      const f = b.age / b.life;
      g.strokeStyle = b.color;
      g.globalAlpha = 1 - f;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(b.x * u, b.y * u);
      g.lineTo((b.x - b.vx * 0.03) * u, (b.y - b.vy * 0.03) * u);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (mode === "run") {
      // a bolt not eaten in time goes, and another comes elsewhere
      if (s.bolt >= 0 && now >= boltUntil) {
        s = { ...s, bolt: snakeSpot(p, s, rng, 3) ?? s.bolt };
        boltShown = now;
        boltFrom = now;
        boltUntil = now + p.boltLife * 1000;
      }
      // puddles dry up; new ones come, never by the head
      s.puddles = s.puddles.filter((w) => w.until > now);
      if (now - lastPuddle >= p.every * 1000) {
        lastPuddle = now;
        if (s.puddles.length < p.puddles) {
          const cell = snakeSpot(p, s, rng, SNAKE_CLEAR);
          if (cell !== null) s.puddles.push({ cell, from: now, until: now + p.life * 1000 });
        }
      }
      // a long pause (the screen away): carry on from now, not all the steps missed at once
      if (now - lastStep > 500) lastStep = now - stepMs();
      while (mode === "run" && now - lastStep >= stepMs()) {
        lastStep += stepMs();
        step(lastStep);
      }
    } else if (mode === "out" && now - since > 1200) {
      // all over again, the same bolts and puddles
      attempt++;
      rng = rngOf(p.seed);
      s = snakeStart(p, rng);
      before = s.body.slice();
      boltShown = now;
      boltFrom = now;
      boltUntil = Number.POSITIVE_INFINITY;
      turns = [];
      died = null;
      mode = "ready";
      since = now;
      say();
    } else if (mode === "won" && !reported && now - since > 900) {
      reported = true;
      ctx.done(`${p.goal} блискавок з ${attempt}-ї спроби`);
    }
    const dt = Math.max(0, Math.min(0.05, (now - lastFrame) / 1000));
    lastFrame = now;
    for (const b of bits) {
      b.age += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vx *= Math.exp(-3 * dt);
      b.vy *= Math.exp(-3 * dt);
    }
    bits = bits.filter((b) => b.age < b.life);
    draw(now);
  };

  // a swipe on the board turns it (several in one stroke, too); a tap starts it as it lies
  let swipe: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    swipe = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0);
    swipe = { x: e.clientX, y: e.clientY };
  });
  const lift = (e: PointerEvent) => {
    if (swipe && mode === "ready" && Math.hypot(e.clientX - swipe.x, e.clientY - swipe.y) < 18)
      turn(s.dir);
    swipe = null;
  };
  canvas.addEventListener("pointerup", lift);
  canvas.addEventListener("pointercancel", () => {
    swipe = null;
  });
  const KEYS: Record<string, number> = {
    ArrowUp: 0,
    ArrowRight: 1,
    ArrowDown: 2,
    ArrowLeft: 3,
    w: 0,
    d: 1,
    s: 2,
    a: 3,
  };
  const onKey = (e: KeyboardEvent) => {
    const d = KEYS[e.key] ?? KEYS[e.key.toLowerCase()];
    if (d === undefined) {
      if (e.key === " " && mode === "ready") {
        e.preventDefault();
        turn(s.dir);
      }
      return;
    }
    e.preventDefault();
    turn(d);
  };
  document.addEventListener("keydown", onKey);

  say();
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    document.removeEventListener("keydown", onKey);
  };
}

// ── Замикання ───────────────────────────────────────────────────────────────────────────────

/** The numbers' colours, 1 to 8. */
const MINE_INK = [
  "",
  "#8fb4ff",
  "#7cd6a0",
  "#ffb36b",
  "#c39bff",
  "#ff7a6b",
  "#6fd6d6",
  "#f2efea",
  "#a3a5ad",
];

export function mountMine(root: HTMLElement, p: MinePuzzle, ctx: GameCtx): Cleanup {
  const size = p.cols * p.rows;
  const grid = document.createElement("div");
  grid.className = "g-mine";
  grid.style.setProperty("--cols", String(p.cols));
  root.appendChild(grid);
  const cells = Array.from({ length: size }, (_, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "g-mine-cell";
    b.setAttribute(
      "aria-label",
      `Рядок ${Math.floor(i / p.cols) + 1}, стовпець ${(i % p.cols) + 1}`,
    );
    grid.appendChild(b);
    return b;
  });
  const tools = document.createElement("div");
  tools.className = "g-mine-tools";
  const mode = document.createElement("button");
  mode.type = "button";
  mode.className = "g-btn g-mine-mode";
  mode.innerHTML = `${icon("flag", 18)}<span>Позначати</span>`;
  mode.setAttribute("aria-pressed", "false");
  tools.appendChild(mode);
  root.appendChild(tools);

  /** The faults, laid at the first cell opened. */
  let faults: Set<number> | null = null;
  const open = new Set<number>();
  const marked = new Set<number>();
  let marking = false;
  let over = false;
  let won = false;
  let boom = -1;

  const status = (warn?: string) =>
    ctx.say(
      `Відкривай клітинки: цифра — скільки замикань поруч. Утримуй клітинку, щоб позначити\nпозначено ${marked.size} з ${p.faults}`,
      warn,
    );
  const paint = () => {
    cells.forEach((b, i) => {
      const isOpen = open.has(i);
      const fault = faults?.has(i) ?? false;
      const shown = (over || won) && fault;
      b.toggleAttribute("data-open", isOpen);
      b.toggleAttribute("data-mark", marked.has(i) && !isOpen);
      b.toggleAttribute("data-fault", shown);
      b.toggleAttribute("data-boom", i === boom);
      b.toggleAttribute("data-wrong", over && marked.has(i) && !fault);
      b.disabled = over || won;
      if (isOpen && faults) {
        const k = mineCount(p, faults, i);
        b.textContent = k ? String(k) : "";
        b.style.color = MINE_INK[k] ?? "";
      } else if (shown && !marked.has(i)) {
        b.innerHTML = icon("zap", 16);
        b.style.color = "";
      } else if (marked.has(i)) {
        b.innerHTML = icon("flag", 16);
        b.style.color = "";
      } else {
        b.textContent = "";
        b.style.color = "";
      }
    });
    mode.toggleAttribute("data-on", marking);
    mode.setAttribute("aria-pressed", String(marking));
    mode.disabled = over || won;
  };

  const mark = (i: number) => {
    if (over || won || open.has(i)) return;
    if (marked.has(i)) marked.delete(i);
    else marked.add(i);
    navigator.vibrate?.(10);
    paint();
    status();
  };
  const openCell = (i: number) => {
    if (!faults) faults = mineLay(p, i);
    if (faults.has(i)) {
      over = true;
      boom = i;
      navigator.vibrate?.([40, 50, 40]);
      return;
    }
    for (const c of mineOpen(p, faults, open, i)) {
      open.add(c);
      marked.delete(c);
    }
  };
  /** A tap: a shut cell opens; a number with its faults all marked round it opens the rest round it. */
  const act = (i: number) => {
    if (over || won) return;
    if (marking) {
      mark(i);
      return;
    }
    if (marked.has(i)) return;
    if (open.has(i)) {
      if (!faults) return;
      const k = mineCount(p, faults, i);
      const round = mineAround(p, i);
      if (!k || round.filter((j) => marked.has(j)).length !== k) return;
      for (const j of round) if (!open.has(j) && !marked.has(j) && !over) openCell(j);
    } else openCell(i);
    if (!over && open.size === size - p.faults) {
      won = true;
      for (const f of faults ?? []) marked.add(f);
      paint();
      status();
      foldAway([tools], ctx);
      ctx.done(`усі ${p.faults} замикань знайдено`);
      return;
    }
    paint();
    status(over ? "замикання! Почни спочатку" : undefined);
  };

  // a tap opens, a hold (or a right click) marks
  let hold = 0;
  let held = -1;
  let pressed = -1;
  cells.forEach((b, i) => {
    b.addEventListener("pointerdown", (e) => {
      if (e.button === 2) return;
      pressed = i;
      held = -1;
      window.clearTimeout(hold);
      hold = window.setTimeout(() => {
        held = i;
        mark(i);
      }, 380);
    });
    b.addEventListener("pointerup", () => {
      window.clearTimeout(hold);
      if (pressed === i && held !== i) act(i);
      pressed = -1;
    });
    b.addEventListener("pointerleave", () => {
      window.clearTimeout(hold);
      pressed = -1;
    });
    b.addEventListener("pointercancel", () => {
      window.clearTimeout(hold);
      pressed = -1;
    });
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (held !== i) mark(i);
    });
  });
  mode.addEventListener("click", () => {
    marking = !marking;
    paint();
  });

  paint();
  status();
  return () => window.clearTimeout(hold);
}
