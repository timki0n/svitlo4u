/**
 * Fine snow in a 3D scene: points that the GPU moves — falling, swaying, a light breeze. They stand
 * in the scene, so the building hides the flakes behind it and nearer ones are larger. Each flake
 * has its place in an endless snowfall (the box repeated everywhere); the box only picks the part
 * round its centre to draw. So the box may follow the camera while the snow stays where it is: the
 * camera moves through it.
 */
import * as THREE from "three";

export type SnowView = {
  /** The part drawn: its centre (it may move freely) and size (the snowfall's repeat: keep it). */
  center: THREE.Vector3;
  box: THREE.Vector3;
  /** A flake's size in world units (on screen it shrinks with distance). */
  flake: number;
  /** Fall, boxes per second; the breeze, box widths per second. */
  fall: number;
  wind: number;
  /** Flakes nearer to the camera than this melt away (none flies into the lens). */
  near: number;
  /** 0–1: to fade one snowfall into another. */
  opacity: number;
  /** 0–1: the share of the flakes falling (the weather); the rest melt away one by one. */
  amount: number;
};

export type Snow = {
  points: THREE.Points;
  /** Before each render. */
  update(
    seconds: number,
    view: SnowView,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
  ): void;
  dispose(): void;
};

/** No larger than this on screen, device pixels: fine snow even right by the camera. */
const MAX_PX = 7;

const vertexShader = /* glsl */ `
  attribute vec4 aSeed; // speed, phase, size, brightness
  attribute float aRank; // 0..1: the flake falls while the amount is above it
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform float uTime;
  uniform float uFall;
  uniform float uWind;
  uniform float uFlake;
  uniform float uScale;
  uniform float uMaxPx;
  uniform float uNear;
  uniform float uOpacity;
  uniform float uAmount;
  varying float vAlpha;

  void main() {
    float speed = aSeed.x;
    // the flake's place in the endless snowfall: it moves by falling and the breeze only
    vec3 w = position * uBox;
    w.y -= uTime * uFall * speed * uBox.y;
    w.x += uTime * uWind * speed * uBox.x + 0.012 * uBox.x * sin(uTime * 0.9 * speed + aSeed.y);
    w.z += 0.012 * uBox.z * cos(uTime * 0.7 * speed + aSeed.y * 1.7);
    // its copy inside the box round the centre: 0..1 on each axis
    vec3 n = fract((w - uCenter) / uBox + 0.5);
    vec3 p = uCenter + (n - 0.5) * uBox;
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    float dist = max(-view.z, 0.001);
    gl_Position = projectionMatrix * view;
    gl_PointSize = clamp(uFlake * aSeed.z * uScale / dist, 1.0, uMaxPx);
    // flakes come in and leave at the box's sides softly; near the camera they melt away
    vec3 edge = smoothstep(0.0, 0.06, n) * smoothstep(1.0, 0.94, n);
    float shown = 1.0 - smoothstep(uAmount - 0.04, uAmount, aRank);
    vAlpha = uOpacity * shown * aSeed.w * edge.x * edge.y * edge.z * smoothstep(uNear, uNear * 2.0, dist);
  }
`;

const fragmentShader = /* glsl */ `
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.12, d) * vAlpha;
    if (a < 0.02) discard;
    gl_FragColor = vec4(1.0, 1.0, 1.0, a);
  }
`;

export function createSnow(count: number): Snow {
  const position = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  const rank = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    rank[i] = (i + 0.5) / count;
    position.set([Math.random(), Math.random(), Math.random()], i * 3);
    seed.set(
      [
        0.6 + Math.random() * 0.8,
        Math.random() * Math.PI * 2,
        0.55 + Math.random() * 0.9,
        0.35 + Math.random() * 0.55,
      ],
      i * 4,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
  geometry.setAttribute("aRank", new THREE.BufferAttribute(rank, 1));
  const uniforms = {
    uCenter: { value: new THREE.Vector3() },
    uBox: { value: new THREE.Vector3(1, 1, 1) },
    uTime: { value: 0 },
    uFall: { value: 0 },
    uWind: { value: 0 },
    uFlake: { value: 1 },
    uScale: { value: 1 },
    uMaxPx: { value: MAX_PX },
    uNear: { value: 0 },
    uOpacity: { value: 1 },
    uAmount: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  // the shader moves the points: the geometry's bounds say nothing about where they are
  points.frustumCulled = false;
  points.renderOrder = 10;
  const buffer = new THREE.Vector2();

  return {
    points,
    update(seconds, view, camera, renderer) {
      renderer.getDrawingBufferSize(buffer);
      uniforms.uCenter.value.copy(view.center);
      uniforms.uBox.value.copy(view.box);
      uniforms.uTime.value = seconds;
      uniforms.uFall.value = view.fall;
      uniforms.uWind.value = view.wind;
      uniforms.uFlake.value = view.flake;
      uniforms.uNear.value = view.near;
      uniforms.uOpacity.value = view.opacity;
      uniforms.uAmount.value = view.amount;
      points.visible = view.opacity > 0.01 && view.amount > 0.001;
      uniforms.uScale.value = buffer.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
