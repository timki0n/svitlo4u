/**
 * The main screen's 3D clay figure of a building, from its model (ЖК 4U: sections I–II, one mass
 * 76 × 19 m on 27 floors, with the two-storey annex round the yard). Windows glow when there is
 * light; without it only the open hall galleries stay lit (the generator). Low voltage: dim,
 * flickering windows.
 *
 * Renders on demand only: while something moves, the finger turns it, or it slowly turns by itself
 * after a pause. Nothing is drawn while the page is hidden or the figure is off screen.
 */
import * as THREE from "three";
import {
  type BuildingModel,
  MODEL_4U,
  towerTop,
} from "../../../../packages/domain/src/building.ts";
import { buildFigure, type Light, measure } from "./figure.ts";
import { PALETTE, STATES } from "./palette.ts";

export type BuildingMode = "on" | "off" | "low";

export type BuildingScene = {
  setMode(mode: BuildingMode): void;
  dispose(): void;
};

const FADE = 380;
const IDLE_MS = 3500;

export function createBuilding(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  plateEl: HTMLElement,
  initial: BuildingMode,
  building: BuildingModel,
): BuildingScene {
  const { FLOORS } = measure(building);
  const PLATE_R = building.plot.radius;
  // The view was set for ЖК 4U; any other building is framed the same way, scaled to its plot or
  // its height, whichever needs more room.
  const k = Math.max(PLATE_R / MODEL_4U.plot.radius, towerTop(building) / towerTop(MODEL_4U));
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 10 * k, 1200 * k);
  const target = new THREE.Vector3(0, 28 * k, 0);
  const pitch = 0.36; // fixed tilt: the figure only turns around its vertical axis
  const DIST = 340 * k;
  camera.position.set(0, target.y + Math.sin(pitch) * DIST, Math.cos(pitch) * DIST);
  camera.lookAt(target);

  const hemi = new THREE.HemisphereLight(PALETTE.sky, PALETTE.clay, 1.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1e0, 0.85);
  sun.position.set(-90 * k, 160 * k, 110 * k);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {
    left: -95 * k,
    right: 95 * k,
    top: 95 * k,
    bottom: -95 * k,
    near: 20 * k,
    far: 420 * k,
  });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun);

  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const { model, winMesh, lights, bars, barMat, signMat } = buildFigure(building, keep);
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
    if (signMat) signMat.emissiveIntensity = look.sign;
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
