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
  jigsawFits,
  jigsawGroup,
  jigsawOutline,
  type Mirror,
  type PackPuzzle,
  type PetsPuzzle,
  type Point,
  rotate,
  type SlidePuzzle,
  type SudokuPuzzle,
  slideFits,
  slideGrid,
  traceBeam,
  type UntanglePuzzle,
  type VoltBlock,
  type VoltPuzzle,
  voltTrace,
  voltTurns,
} from "./puzzles.ts";

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
  const portsAt = (i: number, on: ReadonlyMap<number, VoltBlock>) => {
    const c = cells[i];
    if (!c || c.kind === "lock") return 0;
    return c.kind === "free" ? (on.get(i)?.ports ?? 0) : c.ports;
  };

  /**
   * The turn of block `i` on `cell` that joins the most of what is around it — the current's end
   * above all — reckoned without it (nor a block it would push off that cell) on the board.
   */
  const bestTurn = (cell: number, i: number) => {
    const ports = (blocks[i] as (typeof blocks)[number]).ports;
    const on = laid((j) => j === i || blocks[j]?.at === cell);
    const t = voltTrace(p, on);
    const end = t.path[t.path.length - 1];
    let best = ports;
    let score = -1;
    for (const turn of voltTurns(ports)) {
      let sc = 0;
      for (const [dx, dy, bit, back] of DIRS) {
        if (!(turn & bit)) continue;
        const x = (cell % n) + dx;
        const y = Math.floor(cell / n) + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const next = y * n + x;
        if (portsAt(next, on) & back) sc += next === end ? 3 : 1;
      }
      if (sc > score) {
        score = sc;
        best = turn;
      }
    }
    return best;
  };

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

    // a block carried: where it would land — shown faintly there, turned as it would lie (turned
    // to join what is around it; put back where it was, as it was) — and the block itself, turned
    // so too, above the finger
    if (drag?.moved) {
      const b = blocks[drag.i] as (typeof blocks)[number];
      const cell = landing(drag.x, drag.y);
      const ports = cell >= 0 && cell !== b.at ? bestTurn(cell, drag.i) : b.ports;
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

  const check = () => {
    const t = voltTrace(p, laid());
    if (!won && t.lit && t.sum === target) {
      won = true;
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
        // laid there, turned to join what is around it (put back where it was, as it was); a
        // block that lay there goes back next to the board
        if (cell !== b.at) b.ports = bestTurn(cell, d.i);
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
  return undefined;
}

// ── Пазл ─────────────────────────────────────────────────────────────────────────────────────

/** Each mount names its picture and pieces apart (two boards on one page never mix them up). */
let jigsawMounts = 0;

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
  /** A piece taken from next to the board is carried above the finger, so it is not hidden. */
  const lift = s * 0.35;
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

  // the picture, drawn once; each piece shows it through its own outline
  const defs = svgEl("defs", {}, svg);
  const sky = svgEl("linearGradient", { id: `${uid}-sky`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  svgEl("stop", { offset: 0, "stop-color": p.sky[0] }, sky);
  svgEl("stop", { offset: 1, "stop-color": p.sky[1] }, sky);
  const frame = svgEl("clipPath", { id: `${uid}-frame` }, defs);
  svgEl("rect", { x: 0, y: 0, width: B, height: B }, frame);
  const art = svgEl("g", { id: `${uid}-art`, "clip-path": `url(#${uid}-frame)` }, defs);
  svgEl("rect", { x: 0, y: 0, width: B, height: B, fill: `url(#${uid}-sky)` }, art);
  for (const a of p.art) {
    const opacity = a.opacity ?? 1;
    if (a.kind === "rect")
      svgEl(
        "rect",
        { x: a.x, y: a.y, width: a.w, height: a.h, rx: a.rx ?? 0, fill: a.fill, opacity },
        art,
      );
    else if (a.kind === "circle")
      svgEl("circle", { cx: a.cx, cy: a.cy, r: a.r, fill: a.fill, opacity }, art);
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
        art,
      );
  }
  outlines.forEach((d, i) => {
    const clip = svgEl("clipPath", { id: `${uid}-p${i}` }, defs);
    svgEl("path", { d }, clip);
  });
  const layer = svgEl("g", {}, svg);

  /** The cell each piece lies on (row by row), or null: next to the board. */
  const at = new Array<number | null>(total).fill(null);
  /** A drag: the pieces carried (a group moves whole), the one held, where it is held by. */
  let drag: {
    group: number[];
    i: number;
    x: number;
    y: number;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
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
   * are joined, so a group is one whole.
   */
  const drawSet = (members: readonly number[], x: number, y: number, scale: number, extra = "") => {
    const g = svgEl(
      "g",
      { transform: `translate(${x} ${y}) scale(${scale})`, style: extra },
      layer,
    );
    let clip = `${uid}-p${members[0]}`;
    if (members.length > 1) {
      clip = `${uid}-g${joins++}`;
      const shape = svgEl("clipPath", { id: clip }, g);
      for (const i of members) svgEl("path", { d: outlines[i] as string }, shape);
    }
    const inner = svgEl("g", { "clip-path": `url(#${clip})` }, g);
    svgEl("use", { href: `#${uid}-art` }, inner);
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
  /** Where the picture's top left is while the pieces are carried. */
  const heldAt = (d: NonNullable<typeof drag>): [number, number] => [
    d.x - d.ox - colOf(d.i) * s,
    d.y - d.oy - rowOf(d.i) * s,
  ];
  const status = () =>
    `Збери картинку: шматки зчіпляються, коли краї сходяться · на полі ${at.filter((c) => c !== null).length} з ${total}`;

  const draw = () => {
    layer.replaceChildren();
    joins = 0;
    held = null;
    ctx.say(status());
    // the board: nothing on it to go by
    svgEl(
      "rect",
      { x: bx - 4, y: by - 4, width: B + 8, height: B + 8, rx: 10, style: `fill:${TILE}` },
      layer,
    );
    const carried = new Set(drag?.moved ? drag.group : []);
    // the pieces on the board, each group as one; once all are home, the picture whole
    if (won) svgEl("use", { href: `#${uid}-art`, x: bx, y: by }, layer);
    else {
      const drawn = new Set<number>();
      at.forEach((cell, i) => {
        if (cell === null || drawn.has(i) || carried.has(i)) return;
        const group = jigsawGroup(n, at, i);
        for (const j of group) drawn.add(j);
        drawSet(group, bx + (colOf(cell) - colOf(i)) * s, by + (rowOf(cell) - rowOf(i)) * s, 1);
      });
    }
    // next to the board, each in its place
    p.order.forEach((i, j) => {
      if (at[i] !== null || carried.has(i)) return;
      const [x, y] = slot(j);
      drawSet([i], x - small * colOf(i) * s, y - small * rowOf(i) * s, small);
    });
    // what is carried, full size, over everything
    if (drag?.moved)
      held = drawSet(
        drag.group,
        ...heldAt(drag),
        1,
        "filter:drop-shadow(0 8px 10px rgba(0,0,0,0.5))",
      );
  };

  svg.addEventListener("pointerdown", (e) => {
    if (won) return;
    const [x, y] = pointIn(svg, e, vw, vh);
    // a piece on the board under the finger: it, and everything joined to it
    const R = Math.floor((y - by) / s);
    const C = Math.floor((x - bx) / s);
    const i = R >= 0 && R < n && C >= 0 && C < n ? at.indexOf(R * n + C) : -1;
    if (i >= 0) {
      drag = {
        group: jigsawGroup(n, at, i),
        i,
        x,
        y,
        sx: x,
        sy: y,
        ox: x - (bx + C * s),
        oy: y - (by + R * s),
        moved: false,
      };
    } else {
      // or one next to the board (the box round it, knobs and all)
      const pad = box * 0.2;
      const j = p.order.findIndex((k, idx) => {
        if (at[k] !== null) return false;
        const [sx, sy] = slot(idx);
        return x >= sx - pad && x <= sx + box + pad && y >= sy - pad && y <= sy + box + pad;
      });
      if (j < 0) return;
      const k = p.order[j] as number;
      drag = { group: [k], i: k, x, y, sx: x, sy: y, ox: s / 2, oy: s / 2 + lift, moved: false };
    }
    svg.setPointerCapture(e.pointerId);
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
    const [hx, hy] = heldAt(drag);
    held?.setAttribute("transform", `translate(${hx} ${hy}) scale(1)`);
  });
  svg.addEventListener("pointerup", () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    let misfit = false;
    if (d.moved) {
      // the piece held: over the board it clicks onto the nearest cells (the group kept on the
      // board), if every edge meets its own there; below it, the pieces go back next to the board
      const left = d.x - d.ox;
      const top = d.y - d.oy;
      const over = top + s / 2 <= by + B + s * 0.25;
      if (!over) for (const j of d.group) at[j] = null;
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
        if (jigsawFits(n, at, d.group, dr, dc)) {
          for (const j of d.group) at[j] = (rowOf(j) + dr) * n + colOf(j) + dc;
          navigator.vibrate?.(jigsawGroup(n, at, d.i).length > d.group.length ? 25 : 10);
        } else misfit = true;
      }
    }
    if (!won && at.every((cell, j) => cell === j)) {
      won = true;
      // whole: the shelf folds away, the picture stands alone
      unfold = foldShelf(svg, vw, vh, by + B + 8, ctx);
      ctx.done(`усі ${total} шматків на місці`);
    }
    draw();
    if (misfit && !won) ctx.say(status(), "краї не сходяться");
  });
  svg.addEventListener("pointercancel", () => {
    drag = null;
    draw();
  });

  draw();
  return () => unfold();
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
  let pick = -1;
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
      cell.addEventListener("click", () => {
        if (won) return;
        pick = r * n + c;
        paint();
      });
      group.appendChild(cell);
      cells[r * n + c] = cell;
    }
  }
  root.appendChild(board);

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
  tools.append(pencilKey, eraser);
  root.appendChild(tools);

  /** Digit `d` into the cell picked (0: clear it), or with the pencil, its mark there or not. */
  function put(d: number) {
    if (won || pick < 0 || given[pick]) return;
    if (d === 0) {
      now[pick] = 0;
      marks[pick] = 0;
    } else if (pencil) {
      if (now[pick]) return;
      marks[pick] = (marks[pick] as number) ^ (1 << (d - 1));
    } else if (now[pick] === d) now[pick] = 0;
    else {
      now[pick] = d;
      marks[pick] = 0;
      // the digit is taken here: out of the marks round it
      for (let j = 0; j < n * n; j++)
        if (near(pick, j)) marks[j] = (marks[j] as number) & ~(1 << (d - 1));
    }
    const bad = clashes();
    if (now.every(Boolean) && bad.size === 0) {
      won = true;
      pick = -1;
      paint();
      ctx.done(`сітка ${n}×${n} заповнена`);
      return;
    }
    paint();
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
        `Цифри від 1 до ${n}: кожна раз у рядку, стовпці й ${area} · лишилось ${empty}`,
        bad.size ? "є повтори" : undefined,
      );
    const mine = pick >= 0 ? (now[pick] as number) : 0;
    cells.forEach((cell, i) => {
      const d = now[i] as number;
      cell.toggleAttribute("data-given", given[i] as boolean);
      cell.toggleAttribute("data-pick", i === pick);
      cell.toggleAttribute("data-near", pick >= 0 && i !== pick && near(pick, i));
      cell.toggleAttribute("data-same", mine > 0 && d === mine && i !== pick);
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
  }

  // with a keyboard: digits, the eraser, the arrows to move
  const onKey = (e: KeyboardEvent) => {
    if (won || e.ctrlKey || e.metaKey || e.altKey) return;
    const d = Number(e.key);
    if (Number.isInteger(d) && d >= 1 && d <= n) put(d);
    else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") put(0);
    else {
      const step = ARROWS[e.key];
      if (!step) return;
      e.preventDefault();
      const at = Math.max(pick, 0);
      pick = ((rowOf(at) + step[0] + n) % n) * n + ((colOf(at) + step[1] + n) % n);
      paint();
    }
  };
  document.addEventListener("keydown", onKey);

  paint();
  return () => document.removeEventListener("keydown", onKey);
}
