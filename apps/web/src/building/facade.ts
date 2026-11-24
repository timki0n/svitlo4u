/**
 * The game's facade: the same clay figure as the main screen (the tower alone), every wall's
 * windows to tap, the doors of «Вечорниці» on the ground floor, the camera round the tower from
 * afar or close along its walls. Built from the building's model.
 */
import * as THREE from "three";
import {
  type BuildingModel,
  towerWalls,
  type Wall,
} from "../../../../packages/domain/src/building.ts";
import { isGameWindow } from "../../../../packages/domain/src/game.ts";
import { buildFigure, measure, type Spot } from "./figure.ts";
import { PALETTE, STATES } from "./palette.ts";
import { createSnow, SNOW_AMOUNT, type SnowView, towardAmount } from "./snow.ts";

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
  /** The weather's precipitation, 0–3 (/api/v1/weather): how much snow falls. */
  setSnow(precipitation: number): void;
  dispose(): void;
};
/** A door of «Вечорниці» (1–5, left to right seen from the yard) as the facade shows it. */
export type FacadeDoor = {
  door: number;
  /** Its three parts: open or not. */
  parts: boolean[];
  /** Parts someone is opening right now (a puzzle open on their phone): they blink, as windows do. */
  opening: boolean[];
  open: boolean;
  /** Who sits at its table: a photo link, or a letter on a colour. */
  players: { id: number; avatar: string | null; letter: string; shade: string }[];
};

/** Close up: about 12 storeys, 40 m across. */
const CLOSE_W = 40;
/**
 * Close up the camera walks round the tower along its walls; at a corner it swings round it
 * (looking at the corner) over this much of the walk, so the next wall comes into view. Let go
 * near a corner, it settles half way round: 45°, both walls in view (see settleWalk).
 */
const CORNER = 18;
/** Let go this close to a corner on a long wall, the view settles on the corner. */
const NEAR_CORNER = 7;

/** The camera's walk round the walls (in walking order: right as seen from outside). */
function walking(WALLS: readonly Wall[]) {
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
    const first = WALLS[0] as Wall;
    return { x: first.x, z: first.z, nx: first.nx, nz: first.nz };
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

  return { ROUND, wallAt, settleWalk, spotWalk };
}

type Pose = { pos: THREE.Vector3; target: THREE.Vector3 };
const newPose = (): Pose => ({ pos: new THREE.Vector3(), target: new THREE.Vector3() });

export function createFacade(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  building: BuildingModel,
  onPick: (win: FacadeWindow) => void,
  onPickDoor: (door: number) => void = () => {},
): FacadeScene {
  const {
    FLOOR,
    GROUND,
    FLOORS,
    H,
    TOWER_X,
    TOWER_Z,
    WIN_OUT,
    SPOTS,
    DOOR_X,
    DOOR_W,
    DOOR_H,
    DOOR_Y,
    FIRST_FLOOR,
    FAR_TOP,
  } = measure(building);
  const floorY = (floor: number) => GROUND + (floor - FIRST_FLOOR) * FLOOR + FLOOR / 2;
  /** Close up: about 12 storeys. */
  const CLOSE_H = 12 * FLOOR;
  const { ROUND, wallAt, settleWalk, spotWalk } = walking(towerWalls(building));
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
  const { model, yard, decorWindows, shopWindows, winMesh, lights, bars, barMat, signMat } =
    buildFigure(building, keep);
  if (signMat) signMat.emissiveIntensity = 0;
  barMat.color.set(STATES.off.bar); // the generator keeps the hall lights on
  model.position.set(0, 0, 0); // the tower stands on the axis the camera goes round
  // the tower alone: no decor, no yard (nor the decor's windows)
  yard.visible = false;
  const gone = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = decorWindows[0]; i < decorWindows[1]; i++) winMesh.setMatrixAt(i, gone);
  // the tower's shops are the doors of «Вечорниці» here (drawn below)
  for (let i = shopWindows[0]; i < shopWindows[1]; i++) winMesh.setMatrixAt(i, gone);
  winMesh.instanceMatrix.needsUpdate = true;
  scene.add(model);
  scene.updateMatrixWorld(true);

  // fine snow round what the camera looks at, staying where it is as the camera goes round and
  // along the walls: one snowfall for the whole tower, a finer one for the close-ups (as dense by
  // the windows as afar), faded into each other on the way in and out
  const snowFar = reducedMotion ? null : createSnow(1500);
  const snowClose = reducedMotion ? null : createSnow(1200);
  const farView: SnowView = {
    center: new THREE.Vector3(),
    box: new THREE.Vector3(FAR_TOP * 6, FAR_TOP * 3.6, FAR_TOP * 6),
    flake: FAR_TOP * 0.0085,
    fall: 0.04,
    wind: 0.004,
    near: 25,
    opacity: 1,
    amount: 0,
  };
  const closeView: SnowView = {
    center: new THREE.Vector3(),
    box: new THREE.Vector3(CLOSE_H * 3, CLOSE_H * 2, CLOSE_H * 3),
    flake: CLOSE_H * 0.005,
    fall: 0.04,
    wind: 0.004,
    near: 6,
    opacity: 0,
    amount: 0,
  };
  /** The weather's amount, and how much shows now on the way to it. */
  let snowTarget = 0;
  let snowAmount = 0;
  let snowAt = 0;
  for (const snow of [snowFar, snowClose]) if (snow) scene.add(snow.points);
  const born = performance.now();

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
    // a door's part someone is opening blinks like a window being played
    doors.forEach((d) => {
      d.opening.forEach((on, p) => {
        const m = doorParts[d.door - 1]?.[p];
        if (m && on && !d.open && !d.parts[p]) m.color.copy(shutColor).lerp(blink, k);
      });
    });
  };
  const anyOpening = () => doors.some((d) => !d.open && d.opening.some(Boolean));

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
    const mesh = new THREE.InstancedMesh(card, decal(draw, w, h), FLOORS * SPOTS.length);
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
  /** The snow keeps the loop going only while the facade is on screen and the page is seen. */
  let onScreen = true;
  let lastDraw = 0;
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
    if ((playing.size > 0 || anyOpening()) && !reducedMotion) {
      paint(now);
      busy = true;
    }
    const snowing = snowAmount > 0 || snowTarget > 0;
    if (snowFar && snowClose && snowing && onScreen && !document.hidden) {
      // the snow alone needs no more than 30 frames a second
      if (!busy && now - lastDraw < 31) {
        wake();
        return;
      }
      snowAmount = towardAmount(snowAmount, snowTarget, Math.min(0.1, (now - snowAt) / 1000));
      snowAt = now;
      farView.amount = snowAmount;
      closeView.amount = snowAmount;
      const d = camera.position.distanceTo(lookAt);
      const far = THREE.MathUtils.smoothstep(d, CLOSE_H * 2.5, CLOSE_H * 4.5);
      for (const view of [farView, closeView]) {
        // most of what is drawn in front of the walls: the flakes behind them are hidden anyway
        view.center.lerpVectors(lookAt, camera.position, 0.35);
      }
      farView.opacity = far;
      closeView.opacity = 1 - far;
      const seconds = (now - born) / 1000;
      snowFar.update(seconds, farView, camera, renderer);
      snowClose.update(seconds, closeView, camera, renderer);
      busy = true;
    }
    renderer.render(scene, camera);
    lastDraw = now;
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
  const io = new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? true;
    if (onScreen) wake();
  });
  io.observe(host);
  const onVisibility = () => {
    if (!document.hidden) wake();
  };
  document.addEventListener("visibilitychange", onVisibility);
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
      paint();
      wake();
    },
    setSnow(precipitation) {
      snowTarget = SNOW_AMOUNT[precipitation as 0 | 1 | 2 | 3] ?? 0;
      snowAt = performance.now();
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
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      for (const mesh of [cats, dogs, garlands]) mesh.dispose();
      for (const d of disposables) d.dispose();
      winMesh.dispose();
      bars.dispose();
      snowFar?.dispose();
      snowClose?.dispose();
      renderer.dispose();
    },
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
