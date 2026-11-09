/**
 * The 3D clay figure of sections I–II (one mass 76 × 19 m, 27 floors, from OSM) with the two-storey
 * annex around the yard. Windows glow when there is light; without it only the open hall galleries
 * stay lit (the generator). Low voltage: dim, flickering windows.
 *
 * Renders on demand only: while something moves, the finger turns it, or it slowly turns by itself
 * after a pause. Nothing is drawn while the page is hidden or the figure is off screen.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GAME_FLOORS, GAME_WINDOWS, isGameWindow } from "../../../packages/domain/src/game.ts";

export type BuildingMode = "on" | "off" | "low";

export type BuildingScene = {
  setMode(mode: BuildingMode): void;
  dispose(): void;
};

const PALETTE = {
  clay: "#80838d",
  clayDark: "#686b75",
  tree: "#5f6e60",
  court: "#76625c",
  glass: "#202228",
  lamp: "#ffb347",
  lampCool: "#ffd58a",
  lampLow: "#ff8f3a",
  gen: "#ffd58a",
  sky: "#9a9ca3",
  shadow: "#08090a",
};

const STATES = {
  on: {
    lamp: 1,
    hemi: 1.55,
    sun: 0.85,
    bars: 0.75,
    bar: PALETTE.lampCool,
    flicker: false,
    sign: 0.9,
  },
  low: {
    lamp: 0.55,
    hemi: 1.4,
    sun: 0.75,
    bars: 0.55,
    bar: PALETTE.lampLow,
    flicker: true,
    sign: 0.5,
  },
  off: { lamp: 0, hemi: 0.95, sun: 0.35, bars: 1, bar: PALETTE.gen, flicker: false, sign: 0 },
} as const;

const FLOOR = 2.95;
const GROUND = 6;
const FLOORS = 26; // ground floor + 26 residential = 27
const H = GROUND + FLOORS * FLOOR;
/** Half the tower's length (x) and depth (z); windows stand a little out of the walls. */
const TOWER_X = 38;
const TOWER_Z = 9.5;
const WIN_OUT = 0.12;
/** The open galleries of the halls (the vertical strips of lights): on the yard side only. */
const GALLERY_X = [-19, 19];

/** The tower's shops on the yard side, on the ground floor: «Вечорниці» in the game. */
const DOOR_X = [-28, -14, 0, 14, 28] as const;
const DOOR_W = 5.5;
const DOOR_H = 4;
const DOOR_Y = 3;
/** A door is looked at nearer than windows (a share of the close distance), to see who plays. */
const DOOR_ZOOM = 0.45;
/**
 * The faces of who plays behind a door (DOOR_W × DOOR_H), by how many: radius and centres. The
 * fewer, the bigger; neighbours overlap a little.
 */
const FACE_LAYOUTS: Record<number, { r: number; at: [number, number][] }> = {
  1: { r: 1.6, at: [[0, 0]] },
  2: {
    r: 1.4,
    at: [
      [-1.15, 0],
      [1.15, 0],
    ],
  },
  3: {
    r: 1.17,
    at: [
      [-1.58, -0.3],
      [0, 0.3],
      [1.58, -0.3],
    ],
  },
  4: {
    r: 1.12,
    at: [
      [-1.15, 0.88],
      [1.15, 0.88],
      [-1.15, -0.88],
      [1.15, -0.88],
    ],
  },
  5: {
    r: 1,
    at: [
      [-1.75, 0.95],
      [0, 0.95],
      [1.75, 0.95],
      [-0.88, -0.95],
      [0.88, -0.95],
    ],
  },
  6: {
    r: 1,
    at: [
      [-1.75, 0.95],
      [0, 0.95],
      [1.75, 0.95],
      [-1.75, -0.95],
      [0, -0.95],
      [1.75, -0.95],
    ],
  },
};

/** A window on the ground plan: its centre and the way it looks (a unit vector). */
type Spot = { x: number; z: number; nx: number; nz: number };

/**
 * The windows of a storey, in the order the game numbers them (see GAME_COLS): going right along
 * each wall as seen from outside — the street side (−z) from its left end, the −x end, the yard
 * side (+z, galleries instead of two windows), the +x end. Nothing on the seam of the sections.
 */
const SPOTS: Spot[] = (() => {
  const xs: number[] = [];
  for (let x = -34; x <= 34.01; x += 6.8) if (Math.abs(x) >= 1.5) xs.push(x);
  const yard = xs.filter((x) => !GALLERY_X.some((g) => Math.abs(x - g) < 3));
  const back = -TOWER_Z - WIN_OUT;
  const front = TOWER_Z + WIN_OUT;
  const end = TOWER_X + WIN_OUT;
  return [
    ...[...xs].reverse().map((x) => ({ x, z: back, nx: 0, nz: -1 })),
    { x: -end, z: -5, nx: -1, nz: 0 },
    { x: -end, z: 5, nx: -1, nz: 0 },
    ...yard.map((x) => ({ x, z: front, nx: 0, nz: 1 })),
    { x: end, z: 5, nx: 1, nz: 0 },
    { x: end, z: -5, nx: 1, nz: 0 },
  ];
})();

/** One window: floor −1 = shops on the ground; col = its place in SPOTS on the tower, else −1. */
type Light = { floor: number; col: number; lit: boolean; cool: boolean };

const FADE = 380;
const IDLE_MS = 3500;
const PLATE_R = 58;

export function createBuilding(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  plateEl: HTMLElement,
  initial: BuildingMode,
): BuildingScene {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 10, 1200);
  const target = new THREE.Vector3(0, 28, 0);
  const pitch = 0.36; // fixed tilt: the figure only turns around its vertical axis
  const DIST = 340;
  camera.position.set(0, target.y + Math.sin(pitch) * DIST, Math.cos(pitch) * DIST);
  camera.lookAt(target);

  const hemi = new THREE.HemisphereLight(PALETTE.sky, PALETTE.clay, 1.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1e0, 0.85);
  sun.position.set(-90, 160, 110);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {
    left: -95,
    right: 95,
    top: 95,
    bottom: -95,
    near: 20,
    far: 420,
  });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun);

  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const { model, winMesh, lights, bars, barMat, signMat } = buildFigure(keep);
  const spin = new THREE.Group();
  spin.add(model);
  scene.add(spin);
  let seed = 11;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  // ── states ────────────────────────────────────────────────────────────────────────────────
  const glass = new THREE.Color(PALETTE.glass);
  const lamp = new THREE.Color(PALETTE.lamp);
  const lampCool = new THREE.Color(PALETTE.lampCool);
  const lampLow = new THREE.Color(PALETTE.lampLow);
  let mode: BuildingMode = initial;
  const cur = new Float32Array(lights.length);
  const from = new Float32Array(lights.length);
  const to = new Float32Array(lights.length);
  const startAt = new Float64Array(lights.length);
  type Look = { hemi: number; sun: number; bars: number; sign: number };
  const look: Look = {
    hemi: STATES[initial].hemi,
    sun: STATES[initial].sun,
    bars: 0,
    sign: STATES[initial].sign,
  };
  let lookFrom: Look = { ...look };
  let lookTo: Look = { ...look };
  let lookStart = 0;
  let animating = false;
  const tmp = new THREE.Color();

  const paintWindows = (t: number) => {
    const flick =
      STATES[mode].flicker && !reducedMotion
        ? 0.86 + 0.14 * Math.sin(t / 90) * Math.sin(t / 37)
        : 1;
    for (let i = 0; i < lights.length; i++) {
      const color = mode === "low" ? lampLow : (lights[i] as Light).cool ? lampCool : lamp;
      tmp.copy(glass).lerp(color, Math.min(1, (cur[i] as number) * flick));
      winMesh.setColorAt(i, tmp);
    }
    if (winMesh.instanceColor) winMesh.instanceColor.needsUpdate = true;
  };

  const setMode = (next: BuildingMode, instant = false) => {
    mode = next;
    const s = STATES[next];
    const now = performance.now();
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i] as Light;
      from[i] = cur[i] as number;
      to[i] = light.lit ? s.lamp : 0;
      const delay =
        next === "off"
          ? (FLOORS - Math.max(light.floor, 0)) * 34 + rand() * 120 // gone floor by floor
          : rand() * 1100; // lights come on one by one
      startAt[i] = instant || reducedMotion ? now - FADE : now + delay;
    }
    lookFrom = { ...look };
    lookTo = { hemi: s.hemi, sun: s.sun, bars: s.bars, sign: s.sign };
    lookStart = instant || reducedMotion ? now - 2000 : now;
    animating = true;
    wake();
  };

  const stepAnimations = (now: number) => {
    let busy = false;
    for (let i = 0; i < lights.length; i++) {
      const k = (now - (startAt[i] as number)) / FADE;
      if (k < 0) {
        busy = true;
        continue;
      }
      const e = Math.min(1, k);
      const f = from[i] as number;
      cur[i] = f + ((to[i] as number) - f) * (e * e * (3 - 2 * e));
      if (k < 1) busy = true;
    }
    const ks = Math.min(1, (now - lookStart) / 900);
    look.hemi = lookFrom.hemi + (lookTo.hemi - lookFrom.hemi) * ks;
    look.sun = lookFrom.sun + (lookTo.sun - lookFrom.sun) * ks;
    look.bars = lookFrom.bars + (lookTo.bars - lookFrom.bars) * ks;
    look.sign = lookFrom.sign + (lookTo.sign - lookFrom.sign) * ks;
    signMat.emissiveIntensity = look.sign;
    if (ks < 1) busy = true;
    hemi.intensity = look.hemi;
    sun.intensity = look.sun;
    bars.visible = look.bars > 0.01;
    barMat.color.set(STATES[mode].bar).multiplyScalar(0.25 + 0.75 * look.bars);
    paintWindows(now);
    return busy;
  };

  // ── interaction: horizontal drag turns, vertical scroll stays with the page ────────────────
  let dragging = false;
  let lastX = 0;
  let vel = 0;
  let lastTouch = performance.now();
  const onDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    vel = 0;
    lastTouch = performance.now();
    canvas.setPointerCapture(e.pointerId);
    wake();
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    vel = dx * 0.0085;
    spin.rotation.y += vel;
    lastTouch = performance.now();
    wake();
  };
  const onUp = () => {
    dragging = false;
    lastTouch = performance.now();
    wake();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    spin.rotation.y += e.key === "ArrowLeft" ? -0.18 : 0.18;
    lastTouch = performance.now();
    wake();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("keydown", onKey);

  // ── render only when something moves; nothing while hidden (battery during outages) ────────
  let visible = !document.hidden;
  let onScreen = true;
  let raf = 0;
  let lastFrame = performance.now();
  let idleTimer = 0;
  let disposed = false;

  function wake() {
    if (!raf && !disposed) raf = requestAnimationFrame(frame);
  }
  /** The loop sleeps when nothing moves; wake it when the idle pause is over, so it turns. */
  const wakeWhenIdle = (now: number) => {
    window.clearTimeout(idleTimer);
    if (reducedMotion || dragging) return;
    idleTimer = window.setTimeout(wake, Math.max(0, lastTouch + IDLE_MS - now) + 16);
  };
  function frame(now: number) {
    raf = 0;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    let busy = false;
    if (!dragging && Math.abs(vel) > 0.0004) {
      spin.rotation.y += vel;
      vel *= 0.93;
      busy = true;
    }
    const idle = !dragging && now - lastTouch > IDLE_MS;
    if (idle && !reducedMotion && visible && onScreen) {
      spin.rotation.y += dt * 0.16;
      busy = true;
    }
    if (animating) {
      animating = stepAnimations(now);
      busy = busy || animating;
    } else if (STATES[mode].flicker && !reducedMotion) {
      paintWindows(now);
      busy = true;
    }
    renderer.render(scene, camera);
    if (busy && visible && onScreen) wake();
    else if (!idle && visible && onScreen) wakeWhenIdle(now);
  }

  const onVisibility = () => {
    visible = !document.hidden;
    if (visible) wake();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const io = new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? true;
    if (onScreen) wake();
  });
  io.observe(host);

  const probe = new THREE.Vector3();
  /** Project the ground circle (centred on the turning axis, so turning never changes it). */
  const layoutPlate = (width: number, height: number) => {
    camera.updateMatrixWorld();
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      probe.set(Math.cos(a) * PLATE_R, 0, Math.sin(a) * PLATE_R).project(camera);
      const x = ((probe.x + 1) / 2) * width;
      const y = ((1 - probe.y) / 2) * height;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    Object.assign(plateEl.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
    });
  };
  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.fov = width / height < 0.95 ? 31 : 22;
    camera.updateProjectionMatrix();
    layoutPlate(width, height);
    wake();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  spin.rotation.y = -0.55;
  resize();
  setMode(initial, true);

  return {
    setMode: (next) => {
      if (next !== mode) setMode(next);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(idleTimer);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("keydown", onKey);
      for (const d of disposables) d.dispose();
      winMesh.dispose();
      bars.dispose();
      renderer.dispose();
    },
  };
}

// ── the game's facade: the same figure, every wall's windows to tap ──────────────────────────

/** A window of the tower: storey 2–27 (the ground floor is shops), col 1–22 round the tower. */
export type FacadeWindow = { floor: number; col: number };
/**
 * A lit window: how many solved it — twice, a cat or a dog sits in it; three times, a garland
 * glows under it too — and where the pet sits (0–1, also which way it looks).
 */
export type FacadeLit = { solves: number; pet: "cat" | "dog"; place: number };
export type FacadeScene = {
  /** Lit windows by "floor-col". */
  setLit(lit: ReadonlyMap<string, FacadeLit>): void;
  /** Windows someone is playing right now: they blink. */
  setPlaying(playing: ReadonlySet<string>): void;
  /** Mark a window and come close to it; null goes back to the whole tower. */
  select(win: FacadeWindow | null): void;
  /** Room (px) kept free on the right of the whole tower: the building moves left, same size. */
  setInset(px: number): void;
  /** The doors of «Вечорниці»: which parts are open, who sits at each table. */
  setDoors(doors: readonly FacadeDoor[]): void;
  /** Mark a door and come close to it; null leaves it. */
  selectDoor(door: number | null): void;
  dispose(): void;
};
/** A door of «Вечорниці» (1–5, left to right seen from the yard) as the facade shows it. */
export type FacadeDoor = {
  door: number;
  /** Its three parts: open or not. */
  parts: boolean[];
  open: boolean;
  /** Who sits at its table: a photo link, or a letter on a colour. */
  players: { id: number; avatar: string | null; letter: string; shade: string }[];
};
const FIRST_FLOOR = GAME_FLOORS.first;
const floorY = (floor: number) => GROUND + (floor - FIRST_FLOOR) * FLOOR + FLOOR / 2;

/** Afar the view holds the tower from the ground to the crowns on its roof. */
const FAR_TOP = H + 3.4;
/** Close up: about 12 storeys, 40 m across. */
const CLOSE_W = 40;
const CLOSE_H = 12 * FLOOR;
/**
 * Close up the camera walks round the tower along its walls; at a corner it swings round it
 * (looking at the corner) over this much of the walk, so the next wall comes into view. Let go
 * near a corner, it settles half way round: 45°, both walls in view (see settleWalk).
 */
const CORNER = 18;
/** Let go this close to a corner on a long wall, the view settles on the corner. */
const NEAR_CORNER = 7;
/** The walls in walking order (right as seen from outside): start, direction, length, outward. */
const WALLS = [
  { x: TOWER_X, z: -TOWER_Z, dx: -1, dz: 0, len: 2 * TOWER_X, nx: 0, nz: -1 },
  { x: -TOWER_X, z: -TOWER_Z, dx: 0, dz: 1, len: 2 * TOWER_Z, nx: -1, nz: 0 },
  { x: -TOWER_X, z: TOWER_Z, dx: 1, dz: 0, len: 2 * TOWER_X, nx: 0, nz: 1 },
  { x: TOWER_X, z: TOWER_Z, dx: 0, dz: -1, len: 2 * TOWER_Z, nx: 1, nz: 0 },
] as const;
const ROUND = WALLS.reduce((sum, w) => sum + w.len + CORNER, 0);

/** Where the walk `u` looks: a point on the walls and the way out of them, to the camera. */
function wallAt(u: number): { x: number; z: number; nx: number; nz: number } {
  let rest = ((u % ROUND) + ROUND) % ROUND;
  for (const wall of WALLS) {
    if (rest <= wall.len)
      return { x: wall.x + wall.dx * rest, z: wall.z + wall.dz * rest, nx: wall.nx, nz: wall.nz };
    rest -= wall.len;
    if (rest <= CORNER) {
      // round the corner at the wall's end: the way out turns a quarter, to the next wall's,
      // gently at both ends
      const t = rest / CORNER;
      const a = Math.atan2(wall.nx, wall.nz) + t * t * (3 - 2 * t) * (Math.PI / 2);
      const x = wall.x + wall.dx * wall.len;
      const z = wall.z + wall.dz * wall.len;
      return { x, z, nx: Math.sin(a), nz: Math.cos(a) };
    }
    rest -= CORNER;
  }
  return { x: TOWER_X, z: -TOWER_Z, nx: 0, nz: -1 };
}

/**
 * Where the view settles when let go at walk `u`: half way round the nearest corner (45°, both
 * walls in view) when near one or on an end wall, which is too narrow to look at face on;
 * otherwise where it is.
 */
function settleWalk(u: number): number {
  const loops = Math.floor(u / ROUND) * ROUND;
  let rest = u - loops;
  let at = 0;
  for (const wall of WALLS) {
    const before = at - CORNER / 2; // the corner before this wall, half way round
    const after = at + wall.len + CORNER / 2; // the one after it
    if (rest <= wall.len) {
      if (wall.len < CORNER * 2) return loops + (rest < wall.len / 2 ? before : after);
      if (rest < NEAR_CORNER) return loops + before;
      if (rest > wall.len - NEAR_CORNER) return loops + after;
      return u;
    }
    rest -= wall.len;
    if (rest <= CORNER) return loops + after;
    rest -= CORNER;
    at += wall.len + CORNER;
  }
  return u;
}

/** The walk that stands right in front of a window. */
function spotWalk(s: Spot): number {
  let at = 0;
  for (const wall of WALLS) {
    if (wall.nx === s.nx && wall.nz === s.nz)
      return at + (s.x - wall.x) * wall.dx + (s.z - wall.z) * wall.dz;
    at += wall.len + CORNER;
  }
  return 0;
}

type Pose = { pos: THREE.Vector3; target: THREE.Vector3 };
const newPose = (): Pose => ({ pos: new THREE.Vector3(), target: new THREE.Vector3() });

export function createFacade(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  onPick: (win: FacadeWindow) => void,
  onPickDoor: (door: number) => void = () => {},
): FacadeScene {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 5, 1600);
  scene.add(new THREE.HemisphereLight(PALETTE.sky, PALETTE.clay, STATES.off.hemi));
  // a lamp following the camera (see place): brighter than the main figure's dusk, so the dark
  // windows stand out on every wall
  const sun = new THREE.DirectionalLight(0xfff1e0, 0.7);
  scene.add(sun);

  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const { model, yard, annexWindows, shopWindows, winMesh, lights, bars, barMat, signMat } =
    buildFigure(keep);
  signMat.emissiveIntensity = 0;
  barMat.color.set(STATES.off.bar); // the generator keeps the hall lights on
  model.position.z = 0; // the tower stands on the axis the camera goes round
  // the sections alone: no annex, no yard (nor the annex's shop windows)
  yard.visible = false;
  const gone = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = annexWindows[0]; i < annexWindows[1]; i++) winMesh.setMatrixAt(i, gone);
  // the tower's shops are the doors of «Вечорниці» here (drawn below)
  for (let i = shopWindows[0]; i < shopWindows[1]; i++) winMesh.setMatrixAt(i, gone);
  winMesh.instanceMatrix.needsUpdate = true;
  scene.add(model);
  scene.updateMatrixWorld(true);

  const mark = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(3.5, 2.5)),
    keep(new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false })),
  );
  mark.visible = false;
  model.add(mark);

  // ── «Вечорниці»: five doors, three parts each (dark until opened), faces of who plays ────────
  const doorZ = TOWER_Z + 0.16;
  const partW = DOOR_W / 3;
  const partGeo = keep(new THREE.PlaneGeometry(partW - 0.12, DOOR_H));
  const barGeo = keep(new THREE.BoxGeometry(0.14, DOOR_H + 0.24, 0.1));
  const barMatDoor = keep(new THREE.MeshBasicMaterial({ color: "#0d0e11", toneMapped: false }));
  /** A face of radius 1, scaled to its layout. */
  const faceGeo = keep(new THREE.CircleGeometry(1, 48));
  const shutColor = new THREE.Color("#1c1e24");
  const ajarColor = new THREE.Color(PALETTE.lamp).multiplyScalar(0.62);
  const openColor = new THREE.Color(PALETTE.lamp);
  const doorParts: THREE.MeshBasicMaterial[][] = [];
  const doorFaces: THREE.Group[] = [];
  DOOR_X.forEach((x) => {
    const g = new THREE.Group();
    g.position.set(x, DOOR_Y, doorZ);
    model.add(g);
    const mats = [0, 1, 2].map((k) => {
      const m = keep(new THREE.MeshBasicMaterial({ color: shutColor, toneMapped: false }));
      const part = new THREE.Mesh(partGeo, m);
      part.position.set((k - 1) * partW, 0, 0);
      g.add(part);
      return m;
    });
    // the two lines that split a door into its parts
    for (const k of [-0.5, 0.5]) {
      const bar = new THREE.Mesh(barGeo, barMatDoor);
      bar.position.set(k * partW, 0, 0.04);
      g.add(bar);
    }
    const faces = new THREE.Group();
    // well in front of the bars between the parts: nearer than that, the bars showed through
    faces.position.set(0, 0, 0.6);
    g.add(faces);
    doorParts.push(mats);
    doorFaces.push(faces);
  });
  /** Round faces drawn once per player and photo, reused. */
  const faceTextures = new Map<string, THREE.CanvasTexture>();
  const faceOf = (p: FacadeDoor["players"][number]): THREE.CanvasTexture => {
    const key = `${p.id}:${p.avatar ?? ""}`;
    const known = faceTextures.get(key);
    if (known) return known;
    const art = document.createElement("canvas");
    art.width = 160;
    art.height = 160;
    const g = art.getContext("2d");
    const texture = keep(new THREE.CanvasTexture(art));
    texture.colorSpace = THREE.SRGBColorSpace;
    const round = () => {
      if (!g) return;
      g.beginPath();
      g.arc(80, 80, 76, 0, Math.PI * 2);
      g.closePath();
    };
    if (g) {
      round();
      g.fillStyle = p.shade;
      g.fill();
      g.fillStyle = "#1a1208";
      g.font = "800 76px Manrope Variable, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(p.letter, 80, 86);
    }
    // a dark rim, so a face reads on the lit door and apart from the face it overlaps
    const rim = () => {
      if (!g) return;
      round();
      g.lineWidth = 8;
      g.strokeStyle = "#0d0e11";
      g.stroke();
    };
    rim();
    if (p.avatar && g) {
      const img = new Image();
      img.onload = () => {
        g.save();
        round();
        g.clip();
        g.drawImage(img, 0, 0, 160, 160);
        g.restore();
        rim();
        texture.needsUpdate = true;
        wake();
      };
      img.src = p.avatar;
    }
    faceTextures.set(key, texture);
    return texture;
  };
  let doors: readonly FacadeDoor[] = [];
  const dressDoors = () => {
    doors.forEach((d) => {
      const mats = doorParts[d.door - 1];
      const faces = doorFaces[d.door - 1];
      if (!mats || !faces) return;
      mats.forEach((m, k) => {
        m.color.copy(d.open ? openColor : d.parts[k] ? ajarColor : shutColor);
      });
      for (const child of [...faces.children]) {
        faces.remove(child);
        const mat = (child as THREE.Mesh).material as THREE.Material;
        mat.dispose();
      }
      // up to six faces, as big as the door holds them, a little over one another
      const shown = d.players.slice(0, 6);
      const layout = FACE_LAYOUTS[shown.length];
      if (!layout) return;
      shown.forEach((p, i) => {
        const [x, y] = layout.at[i] ?? [0, 0];
        const face = new THREE.Mesh(
          faceGeo,
          new THREE.MeshBasicMaterial({ map: faceOf(p), transparent: true, toneMapped: false }),
        );
        face.scale.setScalar(layout.r);
        // each next one a hair nearer, so it lies over the one before
        face.position.set(x, y, i * 0.012);
        faces.add(face);
      });
    });
  };

  // ── windows: dark, lit, or blinking while someone plays them ──────────────────────────────
  const glass = new THREE.Color(PALETTE.glass);
  const dark = new THREE.Color("#2c2e35");
  const lamp = new THREE.Color(PALETTE.lamp);
  const blink = new THREE.Color(PALETTE.lampCool);
  const pulse = new THREE.Color();
  const keys = lights.map((l) =>
    l.col >= 0 && isGameWindow(l.floor + FIRST_FLOOR, l.col + 1)
      ? `${l.floor + FIRST_FLOOR}-${l.col + 1}`
      : null,
  );
  let lit: ReadonlyMap<string, FacadeLit> = new Map();
  let playing: ReadonlySet<string> = new Set();
  const paint = (now = performance.now()) => {
    // ~1.2 blinks a second; with reduced motion a steady pale light
    const k = reducedMotion ? 0.8 : 0.5 + 0.5 * Math.sin((now / 1000) * Math.PI * 2.4);
    keys.forEach((key, i) => {
      const on = key !== null && lit.has(key);
      if (key !== null && playing.has(key))
        winMesh.setColorAt(i, pulse.copy(on ? lamp : dark).lerp(blink, k));
      else winMesh.setColorAt(i, on ? lamp : key !== null ? dark : glass);
    });
    if (winMesh.instanceColor) winMesh.instanceColor.needsUpdate = true;
  };

  // ── who lives there: a cat or a dog in a window lit twice, a garland under it lit thrice ─────
  const decal = (draw: (g: CanvasRenderingContext2D) => void, w: number, h: number) => {
    const art = document.createElement("canvas");
    art.width = w;
    art.height = h;
    const g = art.getContext("2d");
    if (g) draw(g);
    const map = keep(new THREE.CanvasTexture(art));
    map.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide, // a pet mirrored to look the other way
    });
    return keep(material);
  };
  const card = keep(new THREE.PlaneGeometry(1, 1));
  const decals = (draw: (g: CanvasRenderingContext2D) => void, w: number, h: number) => {
    const mesh = new THREE.InstancedMesh(card, decal(draw, w, h), GAME_WINDOWS);
    mesh.count = 0;
    mesh.frustumCulled = false; // its bounds are the one card at the origin
    model.add(mesh);
    return mesh;
  };
  const cats = decals(drawCat, 128, 128);
  const dogs = decals(drawDog, 128, 128);
  const garlands = decals(drawGarland, 256, 64);
  const facing = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const spotAt = new THREE.Vector3();
  const spotSize = new THREE.Vector3();
  const spotMatrix = new THREE.Matrix4();
  /** Put the pets and the garlands into the windows solved often enough. */
  const dress = () => {
    let c = 0;
    let d = 0;
    let g = 0;
    for (const [key, look] of lit) {
      if (look.solves < 2) continue;
      const [floor, col] = key.split("-").map(Number) as [number, number];
      const spot = SPOTS[col - 1];
      if (!spot || !isGameWindow(floor, col)) continue;
      const y = floorY(floor);
      facing.setFromAxisAngle(yAxis, Math.atan2(spot.nx, spot.nz));
      // on the sill, to one side or the other, just in front of the glass
      const aside = (look.place - 0.5) * 0.9;
      spotAt.set(
        spot.x + spot.nx * 0.17 + spot.nz * aside,
        y - 0.22,
        spot.z + spot.nz * 0.17 - spot.nx * aside,
      );
      spotSize.set(look.place < 0.5 ? 1.05 : -1.05, 1.05, 1);
      spotMatrix.compose(spotAt, facing, spotSize);
      if (look.pet === "cat") cats.setMatrixAt(c++, spotMatrix);
      else dogs.setMatrixAt(d++, spotMatrix);
      if (look.solves >= 3) {
        // under the window, hung from its sill on the wall, a little wider than the window
        spotAt.set(spot.x + spot.nx * 0.19, y - 1.05, spot.z + spot.nz * 0.19);
        spotSize.set(2.9, 0.72, 1);
        spotMatrix.compose(spotAt, facing, spotSize);
        garlands.setMatrixAt(g++, spotMatrix);
      }
    }
    cats.count = c;
    dogs.count = d;
    garlands.count = g;
    for (const mesh of [cats, dogs, garlands]) mesh.instanceMatrix.needsUpdate = true;
  };

  // ── the camera: round the whole tower from afar, or close along its walls ──────────────────
  let viewWidth = 1;
  let inset = 0;
  /** Afar: where the camera stands round the tower (the yard side with the doors, a little aside). */
  let turn = 0.2;
  /** Afar: how far, the same from every side (fitFar). */
  let farDist = 300;
  /** Close: the walk along the walls (wallAt) and the height looked at. */
  let close = false;
  let walk = 0;
  let height = 0;
  let selected: FacadeWindow | null = null;
  let selectedDoor: number | null = null;
  /** Close: how near — 1 along the windows, DOOR_ZOOM at a door. */
  let zoom = 1;

  const half = () => Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const closeDist = () => Math.max(CLOSE_H / 2 / half(), CLOSE_W / 2 / (half() * camera.aspect));
  /**
   * Close up (at a zoom), the lowest the view may look: its bottom edge a little under the doors,
   * whatever the screen's shape, so the ground floor with «Вечорниці» can always be looked at.
   */
  const lowest = (z: number) => DOOR_Y - DOOR_H / 2 - 1.5 + closeDist() * z * half();
  /** Where the view looks at a door: as low as it goes, the door near its bottom edge. */
  const doorHeight = () => lowest(DOOR_ZOOM);
  /** Close up the view stays on the walls instead of showing the ground or the sky. */
  const clampHeight = (y: number, z = zoom) =>
    Math.min(H + 2 - CLOSE_H / 2, Math.max(lowest(z), y));
  /** The part of the view left of the inset, where the whole tower stands. */
  const share = () => Math.max(0.5, (viewWidth - inset) / viewWidth);
  /**
   * Far enough that the whole tower stays in its part of the view from every side: turned, its
   * nearest corner grows in perspective, so take the worst side, and a little air.
   */
  const fitFar = () => {
    const tall = half();
    const wide = tall * camera.aspect * share();
    let need = 0;
    for (let i = 0; i < 72; i++) {
      const t = (i / 72) * Math.PI * 2;
      for (const x of [-TOWER_X, TOWER_X]) {
        for (const z of [-TOWER_Z, TOWER_Z]) {
          const nearer = x * Math.sin(t) + z * Math.cos(t);
          const aside = Math.abs(x * Math.cos(t) - z * Math.sin(t));
          need = Math.max(need, nearer + aside / wide, nearer + FAR_TOP / 2 / tall);
        }
      }
    }
    farDist = (need * 1.08) / 1.1; // a little air, then 10% closer: the corners may just touch
  };
  const farPose = (pose: Pose) => {
    const shift = (0.5 - share() / 2) * 2 * farDist * half() * camera.aspect;
    const y = FAR_TOP / 2;
    // look a little to the right of the tower (screen right is (cos, −sin)), so it moves left
    pose.target.set(Math.cos(turn) * shift, y, -Math.sin(turn) * shift);
    pose.pos.set(
      pose.target.x + Math.sin(turn) * farDist,
      y,
      pose.target.z + Math.cos(turn) * farDist,
    );
  };
  const closePose = (pose: Pose) => {
    const d = closeDist() * zoom;
    const at = wallAt(walk);
    pose.target.set(at.x, height, at.z);
    pose.pos.set(at.x + at.nx * d, height, at.z + at.nz * d);
  };
  const restPose = (pose: Pose) => (close ? closePose(pose) : farPose(pose));

  // moves: afar ↔ close swing round the tower (never through it); close → close walks the walls
  type Tween = {
    start: number;
    from: Pose;
    walk?: {
      from: number;
      to: number;
      heightFrom: number;
      heightTo: number;
      zoomFrom: number;
      zoomTo: number;
    };
  };
  let tween: Tween | null = null;
  const lookAt = new THREE.Vector3();
  const goal = newPose();
  const blending = newPose();
  const toCamera = new THREE.Vector3();
  const place = (pose: Pose) => {
    camera.position.copy(pose.pos);
    camera.lookAt(pose.target);
    lookAt.copy(pose.target);
    // the light falls on whatever is in view, from behind and above the camera: both walls of a
    // corner get the same, so the windows read on each
    toCamera.subVectors(pose.pos, pose.target).setY(0).normalize();
    sun.target.position.copy(pose.target);
    sun.target.updateMatrixWorld();
    sun.position.copy(pose.target).addScaledVector(toCamera, 80).addScaledVector(camera.up, 70);
  };
  const swing = (from: Pose, to: Pose, e: number, out: Pose) => {
    const a0 = Math.atan2(from.pos.x, from.pos.z);
    let da = Math.atan2(to.pos.x, to.pos.z) - a0;
    da = ((((da + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const r0 = Math.hypot(from.pos.x, from.pos.z);
    const r = r0 + (Math.hypot(to.pos.x, to.pos.z) - r0) * e;
    const a = a0 + da * e;
    out.pos.set(Math.sin(a) * r, from.pos.y + (to.pos.y - from.pos.y) * e, Math.cos(a) * r);
    out.target.lerpVectors(from.target, to.target, e);
  };
  const startTween = (walkTo?: { walk: number; height: number; zoom: number }) => {
    const from = newPose();
    from.pos.copy(camera.position);
    from.target.copy(lookAt);
    tween = { start: performance.now(), from };
    if (walkTo) {
      // the shorter way round
      let to = walkTo.walk;
      while (to - walk > ROUND / 2) to -= ROUND;
      while (walk - to > ROUND / 2) to += ROUND;
      tween.walk = {
        from: walk,
        to,
        heightFrom: height,
        heightTo: walkTo.height,
        zoomFrom: zoom,
        zoomTo: walkTo.zoom,
      };
    }
    wake();
  };
  const finishTween = () => {
    if (tween?.walk) {
      walk = tween.walk.to;
      height = tween.walk.heightTo;
      zoom = tween.walk.zoomTo;
    }
    tween = null;
  };

  // ── the finger: afar it turns the tower, close it walks along the walls ────────────────────
  let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
  const vel = { x: 0, y: 0 };
  /** Close up, once a drag has run out, the view settles (settleWalk). */
  let settle = false;
  const move = (dx: number, dy: number) => {
    if (close) {
      const metres = (2 * closeDist() * zoom * half() * camera.aspect) / viewWidth;
      walk -= dx * metres;
      height = clampHeight(height + dy * metres);
    } else {
      turn -= (dx * Math.PI) / Math.max(240, viewWidth);
    }
  };

  // ── rendering on demand ────────────────────────────────────────────────────────────────────
  let raf = 0;
  let disposed = false;
  function wake() {
    if (!raf && !disposed) raf = requestAnimationFrame(frame);
  }
  function frame(now: number) {
    raf = 0;
    let busy = false;
    if (tween) {
      const k = reducedMotion ? 1 : Math.min(1, (now - tween.start) / 450);
      const e = k * k * (3 - 2 * k);
      if (tween.walk) {
        walk = tween.walk.from + (tween.walk.to - tween.walk.from) * e;
        height = tween.walk.heightFrom + (tween.walk.heightTo - tween.walk.heightFrom) * e;
        zoom = tween.walk.zoomFrom + (tween.walk.zoomTo - tween.walk.zoomFrom) * e;
        restPose(blending);
      } else {
        restPose(goal);
        swing(tween.from, goal, e, blending);
      }
      place(blending);
      if (k < 1) busy = true;
      else finishTween();
    } else {
      if (!drag && (Math.abs(vel.x) > 0.2 || Math.abs(vel.y) > 0.2)) {
        move(vel.x, close ? vel.y : 0);
        vel.x *= 0.92;
        vel.y *= 0.92;
        busy = true;
      } else if (!drag && settle) {
        settle = false;
        const to = close ? settleWalk(walk) : walk;
        if (Math.abs(to - walk) > 0.05) startTween({ walk: to, height, zoom });
      }
      restPose(goal);
      place(goal);
    }
    if (playing.size > 0 && !reducedMotion) {
      paint(now);
      busy = true;
    }
    renderer.render(scene, camera);
    if (busy) wake();
  }

  // ── picking: the tap's ray against the tower's walls ──────────────────────────────────────
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tower = new THREE.Box3(
    new THREE.Vector3(-TOWER_X, 0, -TOWER_Z),
    new THREE.Vector3(TOWER_X, H, TOWER_Z),
  );
  const hit = new THREE.Vector3();
  const pick = (clientX: number, clientY: number): FacadeWindow | { door: number } | null => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const p = ray.ray.intersectBox(tower, hit);
    if (!p) return null;
    // a door of «Вечорниці»: the yard side's ground floor
    if (p.y < GROUND && Math.abs(p.z - TOWER_Z) < 0.3) {
      const i = DOOR_X.findIndex((x) => Math.abs(p.x - x) <= DOOR_W / 2 + 0.3);
      return i >= 0 ? { door: i + 1 } : null;
    }
    const f = Math.floor((p.y - GROUND) / FLOOR);
    if (f < 0 || f >= FLOORS) return null;
    // the nearest window along the wall that was hit
    let best = -1;
    let bestGap = 3.4;
    SPOTS.forEach((s, i) => {
      const long = s.nz !== 0;
      if (Math.abs(long ? p.z - s.z : p.x - s.x) > 0.5) return;
      const gap = Math.abs(long ? p.x - s.x : p.z - s.z);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    const win = { floor: f + FIRST_FLOOR, col: best + 1 };
    return best >= 0 && isGameWindow(win.floor, win.col) ? win : null;
  };

  const onDown = (e: PointerEvent) => {
    if (tween) finishTween();
    settle = false;
    drag = { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, moved: false };
    vel.x = 0;
    vel.y = 0;
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.ox, e.clientY - drag.oy) > 10) {
      drag.moved = true;
      canvas.setPointerCapture(e.pointerId);
    }
    if (!drag.moved) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    move(dx, close ? dy : 0);
    // a flick keeps it going a little, but never spins it round and round
    vel.x = Math.max(-24, Math.min(24, dx));
    vel.y = Math.max(-24, Math.min(24, dy));
    wake();
  };
  const onUp = (e: PointerEvent) => {
    if (!drag) return;
    const tapped = !drag.moved;
    settle = !tapped;
    drag = null;
    if (tapped) {
      const got = pick(e.clientX, e.clientY);
      if (got && "door" in got) onPickDoor(got.door);
      else if (got) onPick(got);
    }
    wake();
  };
  const onCancel = () => {
    settle = drag?.moved ?? false;
    drag = null;
    wake();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);

  const resize = () => {
    const { width, height: tall } = host.getBoundingClientRect();
    if (!width || !tall) return;
    renderer.setSize(width, tall, false);
    viewWidth = width;
    camera.aspect = width / tall;
    camera.updateProjectionMatrix();
    fitFar();
    // close up, a view of another shape: keep its edges where they may be (a door low in it)
    if (close && !tween) height = selectedDoor ? doorHeight() : clampHeight(height);
    wake();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  paint();
  resize();
  restPose(goal);
  place(goal);

  return {
    setLit(next) {
      lit = next;
      paint();
      dress();
      wake();
    },
    setPlaying(next) {
      playing = next;
      paint();
      wake();
    },
    setInset(px) {
      if (px === inset) return;
      inset = px;
      fitFar();
      if (!close) startTween();
    },
    setDoors(next) {
      doors = next;
      dressDoors();
      wake();
    },
    selectDoor(door) {
      if (door === selectedDoor) return;
      selectedDoor = door;
      const x = door ? DOOR_X[door - 1] : undefined;
      if (x === undefined) {
        // no door, no window: back to the whole tower, from the side the camera is on now
        if (!selected) {
          mark.visible = false;
          if (close) {
            close = false;
            turn = Math.atan2(camera.position.x, camera.position.z);
            startTween();
          }
          canvas.style.touchAction = "";
        }
        return;
      }
      selected = null;
      mark.visible = true;
      mark.scale.set((DOOR_W + 0.7) / 3.5, (DOOR_H + 0.7) / 2.5, 1);
      mark.position.set(x, DOOR_Y, doorZ - 0.03);
      mark.rotation.y = 0;
      // nearer than the windows, and low: the door whole, its faces big enough to know
      const to = {
        walk: spotWalk({ x, z: TOWER_Z + WIN_OUT, nx: 0, nz: 1 }),
        height: doorHeight(),
        zoom: DOOR_ZOOM,
      };
      if (close) startTween(to);
      else {
        close = true;
        walk = to.walk;
        height = to.height;
        zoom = to.zoom;
        startTween();
      }
      vel.x = 0;
      vel.y = 0;
      canvas.style.touchAction = "none";
    },
    select(win) {
      if (win?.floor === selected?.floor && win?.col === selected?.col && !selectedDoor) return;
      if (win) selectedDoor = null;
      if (!win && selectedDoor) return; // a door is chosen: leave it as it is
      selected = win;
      const spot = win ? SPOTS[win.col - 1] : undefined;
      mark.visible = spot !== undefined;
      mark.scale.set(1, 1, 1);
      if (win && spot) {
        mark.position.set(spot.x + spot.nx * 0.08, floorY(win.floor), spot.z + spot.nz * 0.08);
        mark.rotation.y = Math.atan2(spot.nx, spot.nz);
        // a window next to a corner, or on a narrow end wall, is seen from the corner at 45°
        const to = {
          walk: settleWalk(spotWalk(spot)),
          height: clampHeight(floorY(win.floor), 1),
          zoom: 1,
        };
        if (close) startTween(to);
        else {
          close = true;
          walk = to.walk;
          height = to.height;
          zoom = to.zoom;
          startTween();
        }
      } else if (close) {
        // back afar, from the side the camera is on now
        close = false;
        turn = Math.atan2(camera.position.x, camera.position.z);
        startTween();
      }
      vel.x = 0;
      vel.y = 0;
      // close up the finger moves the view both ways; afar a vertical swipe scrolls the page
      canvas.style.touchAction = close ? "none" : "";
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      for (const mesh of [cats, dogs, garlands]) mesh.dispose();
      for (const d of disposables) d.dispose();
      winMesh.dispose();
      bars.dispose();
      renderer.dispose();
    },
  };
}

/**
 * The clay figure itself, shared by the main screen and the game's facade. `keep` collects what
 * the caller must dispose.
 */
function buildFigure(keep: <T extends { dispose(): void }>(x: T) => T) {
  const clayMat = keep(new THREE.MeshStandardMaterial({ color: PALETTE.clay, roughness: 0.95 }));
  const clayDarkMat = keep(
    new THREE.MeshStandardMaterial({ color: PALETTE.clayDark, roughness: 1 }),
  );
  const treeMat = keep(new THREE.MeshStandardMaterial({ color: PALETTE.tree, roughness: 1 }));
  const courtMat = keep(new THREE.MeshStandardMaterial({ color: PALETTE.court, roughness: 1 }));

  // ── model: metres, from OSM (76 × 19 m, 27 floors) and the developer's site plan ──────────
  const model = new THREE.Group();
  model.position.z = -22; // turn around the middle of tower + yard

  const shadowed = (mesh: THREE.Mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const rounded = (w: number, h: number, d: number, segments: number, r: number) =>
    keep(new RoundedBoxGeometry(w, h, d, segments, r));

  const tower = shadowed(new THREE.Mesh(rounded(76, H, 19, 5, 2.2), clayMat));
  tower.position.set(0, H / 2, 0);
  model.add(tower);
  const seam = new THREE.Mesh(keep(new THREE.BoxGeometry(0.5, H - 1, 19.3)), clayDarkMat);
  seam.position.set(0, H / 2, 0);
  model.add(seam);
  const crownGeo = rounded(12, 3.4, 9, 3, 1);
  for (const x of [-19, 19]) {
    const crown = shadowed(new THREE.Mesh(crownGeo, clayMat));
    crown.position.set(x, H + 1.6, -1.5);
    model.add(crown);
  }
  // everything round the tower (the annex, its sign, the yard): the game shows the tower alone
  const yard = new THREE.Group();
  model.add(yard);
  const annexH = 8.5;
  const annexFront = shadowed(new THREE.Mesh(rounded(72, annexH, 14, 4, 2), clayMat));
  annexFront.position.set(-2, annexH / 2, 49);
  const annexSide = shadowed(new THREE.Mesh(rounded(14, annexH, 33, 4, 2), clayMat));
  annexSide.position.set(31, annexH / 2, 26);
  yard.add(annexFront, annexSide);

  // «4U» on the roof of the annex next to the tower, like the complex's sign: lit while there is
  // light, dark without it. Bold glyphs drawn as shapes (no font file), extruded like the clay.
  const signMat = keep(
    new THREE.MeshStandardMaterial({
      color: "#e8461c",
      emissive: "#ff5a1f",
      emissiveIntensity: 0,
      roughness: 0.55,
    }),
  );
  const sign = shadowed(
    new THREE.Mesh(
      keep(
        new THREE.ExtrudeGeometry([glyphFour(0), glyphU(5.6)], {
          depth: 0.9,
          bevelEnabled: true,
          bevelThickness: 0.15,
          bevelSize: 0.12,
          bevelSegments: 2,
          curveSegments: 18,
        }),
      ),
      signMat,
    ),
  );
  sign.scale.setScalar(1.15);
  // Along the middle of the annex roof (x 24–38, z 9.5–42.5), facing outwards, away from the
  // tower: turned a quarter round, the text runs towards −z and its face looks to +x.
  const signWidth = 10 * 1.15;
  const signDepth = 0.9 * 1.15;
  sign.rotation.y = Math.PI / 2;
  sign.position.set(31 - signDepth / 2, annexH + 0.1, 26 + signWidth / 2);
  yard.add(sign);
  const court = shadowed(new THREE.Mesh(rounded(17, 0.5, 10, 2, 0.25), courtMat));
  court.position.set(-21, 0.25, 26);
  yard.add(court);
  const treeGeo = keep(new THREE.SphereGeometry(2.6, 20, 14));
  const trunkGeo = keep(new THREE.CylinderGeometry(0.45, 0.6, 2.2, 10));
  const trees: [number, number, number][] = [
    [-34, 18, 1],
    [-30, 36, 1.15],
    [-8, 20, 0.9],
    [2, 34, 1.1],
    [14, 22, 1],
    [-13, 37, 0.85],
    [20, 36, 0.95],
  ];
  for (const [x, z, s] of trees) {
    const trunk = shadowed(new THREE.Mesh(trunkGeo, clayDarkMat));
    trunk.position.set(x, 1.1, z);
    const crownTree = shadowed(new THREE.Mesh(treeGeo, treeMat));
    crownTree.position.set(x, 2.2 + 2.2 * s, z);
    crownTree.scale.setScalar(s);
    yard.add(trunk, crownTree);
  }
  // the plateau itself is CSS; here only its shadow catcher
  const shadowMat = keep(new THREE.ShadowMaterial({ opacity: 0.35, color: PALETTE.shadow }));
  const ground = new THREE.Mesh(keep(new THREE.CircleGeometry(PLATE_R - 1, 72)), shadowMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0.01, 22);
  ground.receiveShadow = true;
  yard.add(ground);

  // ── windows: one instanced mesh, each window fades on its own ─────────────────────────────
  const lights: Light[] = [];
  const matrices: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion();
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const addWindow = (
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    shop: boolean,
    floor: number,
    col = -1,
  ) => {
    matrices.push(
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz)),
    );
    const r = rand();
    lights.push({ floor, col, lit: shop ? r < 0.9 : r < 0.62, cool: rand() < 0.16 });
  };
  for (let f = 0; f < FLOORS; f++) {
    const y = GROUND + f * FLOOR + FLOOR / 2;
    SPOTS.forEach((s, i) => {
      const long = s.nz !== 0; // on a long wall the window is wide along x
      addWindow(s.x, y, s.z, long ? 2.4 : 0.3, 1.5, long ? 0.3 : 2.4, false, f, i);
    });
  }
  // the annex's shop windows (instances [annexFrom, annexTo)), then the tower's own shops
  const annexFrom = lights.length;
  for (let x = -33; x <= 29; x += 8) {
    addWindow(x, 3.2, 56.12, 3.8, 3.6, 0.3, true, -1);
    addWindow(x, 3.2, 41.88, 3.8, 3.6, 0.3, true, -1);
  }
  for (let z = 15; z <= 37; z += 8) addWindow(38.12, 3.2, z, 0.3, 3.6, 3.8, true, -1);
  const annexTo = lights.length;
  for (const x of DOOR_X) addWindow(x, DOOR_Y, 9.62, DOOR_W, DOOR_H, 0.3, true, -1);
  const shopsTo = lights.length;

  const winMesh = new THREE.InstancedMesh(
    keep(new THREE.BoxGeometry(1, 1, 1)),
    keep(new THREE.MeshBasicMaterial({ toneMapped: false })),
    lights.length,
  );
  matrices.forEach((m, i) => {
    winMesh.setMatrixAt(i, m);
  });
  model.add(winMesh);

  // open galleries on the yard side: the vertical strips of hall lights (the generator keeps them
  // on); the street side has flats there
  const recessGeo = keep(new THREE.BoxGeometry(3.6, H - GROUND - 1, 0.25));
  const barMat = keep(new THREE.MeshBasicMaterial({ toneMapped: false }));
  const bars = new THREE.InstancedMesh(
    keep(new THREE.BoxGeometry(3, 0.75, 0.35)),
    barMat,
    GALLERY_X.length * FLOORS,
  );
  let b = 0;
  for (const gx of GALLERY_X) {
    const recess = new THREE.Mesh(recessGeo, clayDarkMat);
    recess.position.set(gx, GROUND + (H - GROUND) / 2, 9.6);
    model.add(recess);
    for (let f = 0; f < FLOORS; f++) {
      bars.setMatrixAt(
        b++,
        new THREE.Matrix4().makeTranslation(gx, GROUND + f * FLOOR + 0.6, 9.75),
      );
    }
  }
  model.add(bars);

  return {
    model,
    yard,
    annexWindows: [annexFrom, annexTo] as const,
    shopWindows: [annexTo, shopsTo] as const,
    winMesh,
    lights,
    bars,
    barMat,
    signMat,
  };
}

// ── the pets and the garland, drawn once into small textures ───────────────────────────────

const SILHOUETTE = "#1b1209";

/** A cat sitting on the sill, side on, looking right (128 × 128). */
function drawCat(g: CanvasRenderingContext2D): void {
  g.fillStyle = SILHOUETTE;
  g.strokeStyle = SILHOUETTE;
  g.lineCap = "round";
  g.beginPath();
  g.ellipse(60, 92, 25, 31, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(76, 50, 17, 0, Math.PI * 2);
  g.fill();
  for (const ear of [
    [63, 42, 65, 20, 77, 35],
    [78, 34, 90, 19, 92, 43],
  ] as const) {
    g.beginPath();
    g.moveTo(ear[0], ear[1]);
    g.lineTo(ear[2], ear[3]);
    g.lineTo(ear[4], ear[5]);
    g.closePath();
    g.fill();
  }
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(42, 116);
  g.quadraticCurveTo(12, 114, 20, 78);
  g.stroke();
  g.fillRect(36, 112, 50, 12);
}

/** A dog sitting on the sill, side on, looking right (128 × 128). */
function drawDog(g: CanvasRenderingContext2D): void {
  g.fillStyle = SILHOUETTE;
  g.strokeStyle = SILHOUETTE;
  g.lineCap = "round";
  g.beginPath();
  g.ellipse(54, 94, 27, 28, 0, 0, Math.PI * 2);
  g.fill();
  g.fillRect(64, 66, 20, 58); // chest and front legs
  g.beginPath();
  g.arc(80, 50, 16, 0, Math.PI * 2);
  g.fill();
  g.fillRect(86, 49, 18, 14); // the muzzle
  g.beginPath();
  g.arc(104, 56, 7, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(70, 38, 7, 13, -0.6, 0, Math.PI * 2); // an ear, up and back
  g.fill();
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(30, 98);
  g.quadraticCurveTo(12, 84, 20, 60);
  g.stroke();
  g.fillRect(28, 112, 58, 12);
}

/**
 * A string of coloured bulbs sagging under a window (256 × 64): few and big, so they
 * still read when a window is a few dozen pixels wide.
 */
function drawGarland(g: CanvasRenderingContext2D): void {
  const at = (t: number): [number, number] => [10 + t * 236, 8 + 18 * 4 * t * (1 - t)];
  g.strokeStyle = "rgba(24, 16, 8, 0.9)";
  g.lineWidth = 3;
  g.beginPath();
  for (let i = 0; i <= 40; i++) {
    const [x, y] = at(i / 40);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  const colours = [
    [255, 77, 77],
    [255, 210, 63],
    [77, 255, 136],
    [77, 184, 255],
    [255, 122, 224],
  ] as const;
  for (let i = 0; i < 6; i++) {
    const [x, wire] = at((i + 0.5) / 6);
    const y = wire + 12;
    const [r, gr, b] = colours[i % colours.length] as readonly [number, number, number];
    const glow = g.createRadialGradient(x, y, 0, x, y, 20);
    glow.addColorStop(0, `rgba(${r}, ${gr}, ${b}, 1)`);
    glow.addColorStop(0.5, `rgba(${r}, ${gr}, ${b}, 0.9)`);
    glow.addColorStop(1, `rgba(${r}, ${gr}, ${b}, 0)`);
    g.fillStyle = glow;
    g.beginPath();
    g.arc(x, y, 20, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(255, 255, 240, 0.95)";
    g.beginPath();
    g.arc(x, y, 4.5, 0, Math.PI * 2);
    g.fill();
  }
}

/** A bold «4», 4.6 × 6 m, from x0 (closed counter, like the complex's sign). */
function glyphFour(x0: number): THREE.Shape {
  const pts: [number, number][] = [
    [2.6, 0],
    [3.9, 0],
    [3.9, 1.4],
    [4.6, 1.4],
    [4.6, 2.7],
    [3.9, 2.7],
    [3.9, 6],
    [2.7, 6],
    [0, 2.7],
    [0, 1.4],
    [2.6, 1.4],
  ];
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x0 + x, y)));
  const counter = new THREE.Path([
    new THREE.Vector2(x0 + 1.5, 2.7),
    new THREE.Vector2(x0 + 2.6, 4.05),
    new THREE.Vector2(x0 + 2.6, 2.7),
  ]);
  shape.holes.push(counter);
  return shape;
}

/** A bold «U», 4.4 × 6 m, from x0. */
function glyphU(x0: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(x0, 6);
  shape.lineTo(x0, 2.2);
  shape.absarc(x0 + 2.2, 2.2, 2.2, Math.PI, 2 * Math.PI, false);
  shape.lineTo(x0 + 4.4, 6);
  shape.lineTo(x0 + 3.1, 6);
  shape.lineTo(x0 + 3.1, 2.2);
  shape.absarc(x0 + 2.2, 2.2, 0.9, 2 * Math.PI, Math.PI, true);
  shape.lineTo(x0 + 1.3, 6);
  shape.closePath();
  return shape;
}
