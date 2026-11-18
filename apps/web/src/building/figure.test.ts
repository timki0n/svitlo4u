/**
 * The clay figure built from ЖК 4U's model is the very figure the old hand-written scene3d.ts built:
 * every object's place, shape and colour, every window and whether it is lit, to a millimetre.
 */
import { createHash } from "node:crypto";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { MODEL_4U, MODEL_KOLASA_27V } from "../../../../packages/domain/src/building.ts";
import { buildFigure } from "./figure.ts";

/** Captured from scene3d.ts before the model (2026-11-18): the figure as residents know it. */
const LEGACY_FINGERPRINT = "18394398f2465285f8e5485b9afc548f781461d522c2dfbcbe52c78adbbd6b14";

const mm = (v: number): string => {
  const x = Math.round(v * 1000) / 1000;
  return (x === 0 ? 0 : x).toFixed(3);
};

function material(m: THREE.Material | THREE.Material[]): string {
  const one = (x: THREE.Material) => {
    const any = x as THREE.Material & { color?: THREE.Color; emissive?: THREE.Color };
    return [x.type, any.color?.getHexString(), any.emissive?.getHexString(), mm(x.opacity)].join(
      ",",
    );
  };
  return Array.isArray(m) ? m.map(one).join("|") : one(m);
}

function geometry(g: THREE.BufferGeometry): string {
  const position = g.getAttribute("position");
  const h = createHash("sha256");
  if (position)
    for (let i = 0; i < position.array.length; i++) h.update(mm(position.array[i] as number));
  return `${g.type}:${position?.count ?? 0}:${h.digest("hex").slice(0, 16)}`;
}

/** Every object's place, shape and colour, every instance, and the windows' lights, hashed. */
function fingerprint(root: THREE.Object3D, lights: readonly unknown[]): string {
  const h = createHash("sha256");
  const walk = (o: THREE.Object3D, depth: number) => {
    const line = [
      depth,
      o.type,
      o.visible,
      ...o.position.toArray().map(mm),
      mm(o.rotation.x),
      mm(o.rotation.y),
      mm(o.rotation.z),
      ...o.scale.toArray().map(mm),
    ];
    if (o instanceof THREE.Mesh) {
      line.push(geometry(o.geometry), material(o.material), o.castShadow, o.receiveShadow);
    }
    if (o instanceof THREE.InstancedMesh) {
      const m = new THREE.Matrix4();
      line.push(o.count);
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        line.push(m.elements.map(mm).join(","));
      }
    }
    h.update(`${line.join(";")}\n`);
    for (const child of o.children) walk(child, depth + 1);
  };
  walk(root, 0);
  h.update(JSON.stringify(lights));
  return h.digest("hex");
}

describe("the clay figure from ЖК 4U's model", () => {
  const figure = buildFigure(MODEL_4U, (x) => x);

  it("is the figure the old code built, to a millimetre", () => {
    expect(fingerprint(figure.model, figure.lights)).toBe(LEGACY_FINGERPRINT);
  });

  it("keeps its windows in the same order: the tower's, the annex's, the shops", () => {
    expect(figure.lights).toHaveLength(596);
    expect(figure.decorWindows).toEqual([572, 591]);
    expect(figure.shopWindows).toEqual([591, 596]);
    expect(figure.bars.count).toBe(52);
    expect(figure.signMat).not.toBeNull();
  });

  it("a building without decor: no annex, no sign, the same tower", () => {
    const plain = buildFigure({ ...MODEL_4U, decor: undefined }, (x) => x);
    expect(plain.decorWindows).toEqual([572, 572]);
    expect(plain.shopWindows).toEqual([572, 577]);
    expect(plain.signMat).toBeNull();
    expect(plain.yard.children).toHaveLength(1); // only the plot's shadow catcher
  });
});

describe("the clay figure of Якуба Коласа, 27В", () => {
  const figure = buildFigure(MODEL_KOLASA_27V, (x) => x);
  const meshes = figure.model.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);

  it("an extruded mass standing on the outline, 16 storeys high", () => {
    const tower = meshes[0] as THREE.Mesh;
    expect(tower.geometry.type).toBe("ExtrudeGeometry");
    tower.geometry.computeBoundingBox();
    const box = tower.geometry.boundingBox as THREE.Box3;
    const r = (v: number) => Math.round(v * 100) / 100 + 0;
    expect([box.min.x, box.max.x, box.min.z, box.max.z, box.min.y, box.max.y].map(r)).toEqual([
      -26, 26, -8, 8, 0, 44.8,
    ]);
  });

  it("windows on every storey from the ground floor, then the two entrances", () => {
    expect(figure.lights).toHaveLength(16 * 27 + 2);
    expect(figure.lights[0]).toMatchObject({ floor: 0, col: 0 });
    expect(figure.shopWindows).toEqual([432, 434]);
    // the first window of the ground floor sits in its middle, 1.4 m up
    const m = new THREE.Matrix4();
    figure.winMesh.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).y).toBeCloseTo(1.4, 5); // float32
  });

  it("two hexagonal loggias a storey on each stair block, from the 2nd storey up", () => {
    const openings = figure.model.children.find(
      (o): o is THREE.InstancedMesh =>
        o instanceof THREE.InstancedMesh && o.geometry.type === "CircleGeometry",
    );
    expect(openings?.count).toBe(2 * 2 * 15);
    const m = new THREE.Matrix4();
    openings?.getMatrixAt(0, m);
    const at = new THREE.Vector3().setFromMatrixPosition(m);
    // the first one: the left half of stair block A's front (x −16.5…−9.5, z 8), storey 2
    expect([at.x, at.z].map((v) => Math.round(v * 100) / 100)).toEqual([-14.75, 8.04]);
    expect(at.y).toBeCloseTo(2.8 + 2.8 * 0.55, 5);
  });

  it("no decor, no galleries, no seams", () => {
    expect(figure.signMat).toBeNull();
    expect(figure.decorWindows).toEqual([432, 432]);
    expect(figure.bars.count).toBe(0);
    expect(figure.yard.children).toHaveLength(1);
  });

  it("balconies: boxes out of the wall, wide glazing over a parapet, on every storey", () => {
    const parapets = figure.model.children.find(
      (o): o is THREE.InstancedMesh =>
        o instanceof THREE.InstancedMesh &&
        (o.material as THREE.MeshStandardMaterial).color?.getHexString() === "8f8b80",
    );
    expect(parapets?.count).toBe(8 * 16);
    // the first balcony of the ground floor: glazing 1 m up, 3 m wide, the slab under it
    // cols 0–11 the +z side, 12 a window of the −z side (z −8), 13 its first balcony
    const spots = figure.lights.findIndex((l) => l.floor === 0 && l.col === 13);
    const m = new THREE.Matrix4();
    figure.winMesh.getMatrixAt(spots, m);
    const at = new THREE.Vector3();
    const size = new THREE.Vector3();
    m.decompose(at, new THREE.Quaternion(), size);
    expect(at.y).toBeCloseTo(1 + 1.35 / 2, 5);
    expect(size.x).toBeCloseTo(3, 5);
    // out of the wall by the balcony's 2 m, as far again as any window stands
    expect(at.z).toBeCloseTo(-8 - 2 - 0.12, 5);
  });
});
