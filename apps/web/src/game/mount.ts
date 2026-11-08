/**
 * The window games on the page: plain SVG and DOM in the site's colours, driven by touch.
 * Each mount draws one puzzle into `root`, reports through `ctx` and returns its cleanup.
 */
import { type GameIcon, icon } from "./icons.ts";
import {
  type BeamPuzzle,
  type Block,
  type ChainPuzzle,
  type ChargePuzzle,
  chainPowered,
  crossingEdges,
  DIRS,
  degree,
  type FusePuzzle,
  type Mirror,
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
  ctx.say("Повертай дзеркала, щоб промінь ліхтарика влучив у сонячну панель");
  const { n } = p;
  const mirrors = new Map<number, Mirror>(p.mirrors);
  const size = 300;
  const cs = size / n;
  const ox = 26;
  const svg = svgRoot(root, size + ox, size);
  let won = false;
  const draw = () => {
    svg.replaceChildren();
    const { points, hit } = traceBeam(p, mirrors);
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
    svgEl(
      "polyline",
      {
        points: points.map(([a, b]) => `${ox + a * cs},${b * cs}`).join(" "),
        style: `fill:none;stroke:${LIGHT};stroke-width:4;stroke-linejoin:round;stroke-linecap:round`,
      },
      svg,
    );
    const tx = ox + (p.target % n) * cs;
    const ty = Math.floor(p.target / n) * cs;
    svgEl(
      "rect",
      {
        x: tx + cs * 0.2,
        y: ty + cs * 0.2,
        width: cs * 0.6,
        height: cs * 0.6,
        rx: 4,
        style: `fill:${hit ? LIGHT : TILE};stroke:${hit ? LIGHT : DIM};stroke-width:2`,
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
      svgEl(
        "line",
        m === "/"
          ? {
              x1: x + a,
              y1: y + b,
              x2: x + b,
              y2: y + a,
              style: `stroke:${TEXT};stroke-width:5;stroke-linecap:round`,
            }
          : {
              x1: x + a,
              y1: y + a,
              x2: x + b,
              y2: y + b,
              style: `stroke:${TEXT};stroke-width:5;stroke-linecap:round`,
            },
        g,
      );
      g.addEventListener("click", () => {
        if (won) return;
        mirrors.set(cell, m === "/" ? "\\" : "/");
        draw();
        if (traceBeam(p, mirrors).hit) {
          won = true;
          ctx.done("панель заряджається");
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
  const svg = svgRoot(root, W, H, "g-tap");
  svgEl(
    "path",
    { d: arc(0, 1, R), style: `fill:none;stroke:${TILE};stroke-width:18;stroke-linecap:round` },
    svg,
  );
  const zone = svgEl("path", { d: "", style: `fill:none;stroke:${LIGHT};stroke-width:18` }, svg);
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
  const button = document.createElement("button");
  button.type = "button";
  button.className = "g-btn g-btn-main";
  button.textContent = "Вставити запобіжник";
  root.appendChild(button);
  let hits = 0;
  let misses = 0;
  let phase = p.phase;
  let last = performance.now();
  let v = 0;
  let alive = true;
  const show = (flash?: "ok" | "miss") => {
    ctx.say(
      `Встав, коли стрілка в помаранчевій зоні · ${hits} з ${need} · промахів: ${misses}${flash === "ok" ? " · є!" : ""}`,
      flash === "miss" ? "мимо" : undefined,
    );
    const z = p.zones[hits];
    zone.setAttribute("d", z ? arc(z[0], z[1], R) : "");
  };
  const tap = () => {
    if (!alive) return;
    const [a, b] = p.zones[hits] as [number, number];
    const ok = v >= a && v <= b;
    if (ok) hits++;
    else misses++;
    if (hits >= need) {
      alive = false;
      show();
      ctx.done(misses ? `промахів: ${misses}` : "без жодного промаху");
      return;
    }
    show(ok ? "ok" : "miss");
  };
  button.addEventListener("click", tap);
  svg.addEventListener("click", tap);
  const tick = (now: number) => {
    if (!alive) return;
    const dt = (now - last) / 1000;
    last = now;
    phase += dt * p.speed * (1 + hits * 0.25);
    v = (1 - Math.cos(phase)) / 2;
    const [x, y] = pt(v, R - 14);
    needle.setAttribute("x2", String(x));
    needle.setAttribute("y2", String(y));
    requestAnimationFrame(tick);
  };
  show();
  requestAnimationFrame(tick);
  return () => {
    alive = false;
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
    const k = Math.min(1, root.clientWidth / W);
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
