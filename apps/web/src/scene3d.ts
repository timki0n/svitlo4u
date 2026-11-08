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
/** Windows per floor on each long facade. */
const BACK_COLS = 8;

/** One window: floor −1 = shops on the ground; col ≥ 0 only on the back facade. */
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

// ── the game's facade: the same figure, fixed on its back facade, windows to tap ─────────────

/** A window of the back facade: storey 2–27 (the ground floor is shops), window 1–8 from the left. */
export type FacadeWindow = { floor: number; col: number };
export type FacadeScene = {
  setLit(lit: ReadonlySet<string>): void;
  /** Windows someone is playing right now: they blink. */
  setPlaying(playing: ReadonlySet<string>): void;
  /** Mark a window and come closer to it; null goes back to the whole facade. */
  select(win: FacadeWindow | null): void;
  /** Room (px) kept free on the right of the whole facade: the building moves left, same size. */
  setInset(px: number): void;
  dispose(): void;
};
const FIRST_FLOOR = 2;

/** x of the windows on a long facade, left to right in model coordinates. */
const WINDOW_XS: number[] = (() => {
  const xs: number[] = [];
  for (let x = -34; x <= 34.01; x += 6.8) {
    if ([-19, 19].some((g) => Math.abs(x - g) < 3) || Math.abs(x) < 1.5) continue;
    xs.push(x);
  }
  return xs;
})();
const BACK_Z = -9.62;
const colX = (col: number) => WINDOW_XS[BACK_COLS - col] as number;
const floorY = (floor: number) => GROUND + (floor - FIRST_FLOOR) * FLOOR + FLOOR / 2;

export function createFacade(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  onPick: (win: FacadeWindow) => void,
): FacadeScene {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 10, 1600);
  scene.add(new THREE.HemisphereLight(PALETTE.sky, PALETTE.clay, STATES.off.hemi));
  const sun = new THREE.DirectionalLight(0xfff1e0, STATES.off.sun);
  sun.position.set(-90, 160, -110);
  scene.add(sun);

  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const { model, winMesh, lights, bars, barMat, signMat } = buildFigure(keep);
  signMat.emissiveIntensity = 0;
  barMat.color.set(STATES.off.bar); // the generator keeps the hall lights on
  const spin = new THREE.Group();
  spin.add(model);
  scene.add(spin);
  spin.rotation.y = Math.PI - 0.2; // the back facade, a little from the side
  scene.updateMatrixWorld(true);

  const mark = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(3.5, 2.5)),
    keep(new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false })),
  );
  mark.rotation.y = Math.PI;
  mark.visible = false;
  model.add(mark);

  const glass = new THREE.Color(PALETTE.glass);
  const dark = new THREE.Color("#2c2e35");
  const lamp = new THREE.Color(PALETTE.lamp);
  let lit: ReadonlySet<string> = new Set();
  const blink = new THREE.Color(PALETTE.lampCool);
  const pulse = new THREE.Color();
  let playing: ReadonlySet<string> = new Set();
  const paint = (now = performance.now()) => {
    // ~1.2 blinks a second; with reduced motion a steady pale light
    const k = reducedMotion ? 0.8 : 0.5 + 0.5 * Math.sin((now / 1000) * Math.PI * 2.4);
    lights.forEach((l, i) => {
      const game = l.col >= 0;
      const key = `${l.floor + FIRST_FLOOR}-${l.col + 1}`;
      const on = game && lit.has(key);
      if (game && playing.has(key))
        winMesh.setColorAt(i, pulse.copy(on ? lamp : dark).lerp(blink, k));
      else winMesh.setColorAt(i, on ? lamp : game ? dark : glass);
    });
    if (winMesh.instanceColor) winMesh.instanceColor.needsUpdate = true;
  };
  let blinkRaf = 0;
  let lastBlink = 0;
  const blinkFrame = (now: number) => {
    blinkRaf = 0;
    if (disposed || playing.size === 0 || reducedMotion) return;
    if (now - lastBlink > 60) {
      lastBlink = now;
      paint(now);
      renderer.render(scene, camera);
    }
    blinkRaf = requestAnimationFrame(blinkFrame);
  };

  // ── camera: the whole facade, or close to the chosen window ──────────────────────────────
  const outward = new THREE.Vector3(0, 0, -1).applyQuaternion(spin.quaternion);
  type View = { pos: THREE.Vector3; target: THREE.Vector3 };
  const screenRight = new THREE.Vector3()
    .crossVectors(outward.clone().negate(), camera.up)
    .normalize();
  let selected: FacadeWindow | null = null;
  let inset = 0;
  let viewWidth = 1;
  const viewFor = (win: FacadeWindow | null): View => {
    const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const x = win ? colX(win.col) : 0;
    const height = win ? 12 * FLOOR : H + 6;
    const width = win ? 40 : 76;
    // the whole facade fills the part of the view left of the inset
    const share = win ? 1 : Math.max(0.5, (viewWidth - inset) / viewWidth);
    // close up, the view stays on the facade instead of showing the ground or the sky
    const y = win
      ? Math.min(H + 2 - height / 2, Math.max(GROUND - 2 + height / 2, floorY(win.floor)))
      : (GROUND + H) / 2 + 2;
    const target = model.localToWorld(new THREE.Vector3(x * 0.6, y, BACK_Z));
    const dist = Math.max(height / 2 / half, width / share / 2 / (half * camera.aspect));
    // shift the view right so the building sits in the middle of its share
    const seen = 2 * dist * half * camera.aspect;
    target.addScaledVector(screenRight, (0.5 - share / 2) * seen);
    return { pos: target.clone().addScaledVector(outward, dist), target };
  };
  const from: View = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  const to: View = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  const look = new THREE.Vector3();
  let moveStart = 0;
  let raf = 0;
  let disposed = false;
  const render = () => renderer.render(scene, camera);
  const frame = (now: number) => {
    raf = 0;
    const k = reducedMotion ? 1 : Math.min(1, (now - moveStart) / 450);
    const e = k * k * (3 - 2 * k);
    camera.position.lerpVectors(from.pos, to.pos, e);
    look.lerpVectors(from.target, to.target, e);
    camera.lookAt(look);
    render();
    if (k < 1 && !disposed) raf = requestAnimationFrame(frame);
  };
  const moveTo = (view: View, instant = false) => {
    from.pos.copy(instant ? view.pos : camera.position);
    from.target.copy(instant ? view.target : look);
    to.pos.copy(view.pos);
    to.target.copy(view.target);
    moveStart = instant ? 0 : performance.now();
    if (!raf && !disposed) raf = requestAnimationFrame(frame);
  };

  // ── picking: the tap's ray against the plane of the back facade ──────────────────────────
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const toModel = new THREE.Matrix4();
  const pick = (clientX: number, clientY: number): FacadeWindow | null => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    toModel.copy(model.matrixWorld).invert();
    const local = ray.ray.clone().applyMatrix4(toModel);
    if (Math.abs(local.direction.z) < 1e-6) return null;
    const t = (BACK_Z - local.origin.z) / local.direction.z;
    if (t < 0) return null;
    const p = local.at(t, new THREE.Vector3());
    const k = WINDOW_XS.findIndex((x) => Math.abs(p.x - x) < 3.4);
    const f = Math.floor((p.y - GROUND) / FLOOR);
    if (k < 0 || f < 0 || f >= FLOORS) return null;
    return { floor: f + FIRST_FLOOR, col: BACK_COLS - k };
  };
  let down: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => {
    down = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 10) return;
    const win = pick(e.clientX, e.clientY);
    if (win) onPick(win);
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);

  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    viewWidth = width;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    moveTo(viewFor(selected), true);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  paint();
  resize();

  return {
    setLit(next) {
      lit = next;
      paint();
      render();
    },
    setPlaying(next) {
      playing = next;
      paint();
      render();
      if (playing.size > 0 && !blinkRaf) blinkRaf = requestAnimationFrame(blinkFrame);
    },
    setInset(px) {
      if (px === inset) return;
      inset = px;
      moveTo(viewFor(selected));
    },
    select(win) {
      selected = win;
      mark.visible = win !== null;
      if (win) mark.position.set(colX(win.col), floorY(win.floor), BACK_Z - 0.08);
      moveTo(viewFor(win));
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(blinkRaf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
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
  const annexH = 8.5;
  const annexFront = shadowed(new THREE.Mesh(rounded(72, annexH, 14, 4, 2), clayMat));
  annexFront.position.set(-2, annexH / 2, 49);
  const annexSide = shadowed(new THREE.Mesh(rounded(14, annexH, 33, 4, 2), clayMat));
  annexSide.position.set(31, annexH / 2, 26);
  model.add(annexFront, annexSide);

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
  model.add(sign);
  const court = shadowed(new THREE.Mesh(rounded(17, 0.5, 10, 2, 0.25), courtMat));
  court.position.set(-21, 0.25, 26);
  model.add(court);
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
    model.add(trunk, crownTree);
  }
  // the plateau itself is CSS; here only its shadow catcher
  const shadowMat = keep(new THREE.ShadowMaterial({ opacity: 0.35, color: PALETTE.shadow }));
  const ground = new THREE.Mesh(keep(new THREE.CircleGeometry(PLATE_R - 1, 72)), shadowMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0.01, 22);
  ground.receiveShadow = true;
  model.add(ground);

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
  const galleryX = [-19, 19];
  for (let f = 0; f < FLOORS; f++) {
    const y = GROUND + f * FLOOR + FLOOR / 2;
    let k = 0;
    for (let x = -34; x <= 34.01; x += 6.8) {
      if (galleryX.some((g) => Math.abs(x - g) < 3) || Math.abs(x) < 1.5) continue;
      addWindow(x, y, 9.62, 2.4, 1.5, 0.3, false, f);
      // the back facade (the game's facade): seen from behind, larger x is further left
      addWindow(x, y, -9.62, 2.4, 1.5, 0.3, false, f, BACK_COLS - 1 - k);
      k++;
    }
    for (const z of [-5, 5]) {
      addWindow(38.12, y, z, 0.3, 1.5, 2.4, false, f);
      addWindow(-38.12, y, z, 0.3, 1.5, 2.4, false, f);
    }
  }
  for (let x = -33; x <= 29; x += 8) {
    addWindow(x, 3.2, 56.12, 3.8, 3.6, 0.3, true, -1);
    addWindow(x, 3.2, 41.88, 3.8, 3.6, 0.3, true, -1);
  }
  for (let z = 15; z <= 37; z += 8) addWindow(38.12, 3.2, z, 0.3, 3.6, 3.8, true, -1);
  for (let x = -28; x <= 28; x += 14) addWindow(x, 3, 9.62, 5.5, 4, 0.3, true, -1);

  const winMesh = new THREE.InstancedMesh(
    keep(new THREE.BoxGeometry(1, 1, 1)),
    keep(new THREE.MeshBasicMaterial({ toneMapped: false })),
    lights.length,
  );
  matrices.forEach((m, i) => {
    winMesh.setMatrixAt(i, m);
  });
  model.add(winMesh);

  // open galleries: the vertical strips of hall lights (the generator keeps them on)
  const recessGeo = keep(new THREE.BoxGeometry(3.6, H - GROUND - 1, 0.25));
  const barMat = keep(new THREE.MeshBasicMaterial({ toneMapped: false }));
  const bars = new THREE.InstancedMesh(
    keep(new THREE.BoxGeometry(3, 0.75, 0.35)),
    barMat,
    galleryX.length * 2 * FLOORS,
  );
  let b = 0;
  for (const gx of galleryX) {
    for (const side of [1, -1]) {
      const recess = new THREE.Mesh(recessGeo, clayDarkMat);
      recess.position.set(gx, GROUND + (H - GROUND) / 2, side * 9.6);
      model.add(recess);
      for (let f = 0; f < FLOORS; f++) {
        bars.setMatrixAt(
          b++,
          new THREE.Matrix4().makeTranslation(gx, GROUND + f * FLOOR + 0.6, side * 9.75),
        );
      }
    }
  }
  model.add(bars);

  return { model, winMesh, lights, bars, barMat, signMat };
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
