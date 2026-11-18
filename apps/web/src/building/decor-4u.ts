/**
 * ЖК 4U's own details round the tower, beyond what its model describes: the two-storey annex round
 * the yard with the «4U» sign on its roof, the court, the trees, and the annex's shop windows.
 */
import * as THREE from "three";
import { PALETTE } from "./palette.ts";

export type Keep = <T extends { dispose(): void }>(x: T) => T;
/** Add a window to the figure's one instanced mesh (see buildFigure). */
export type AddWindow = (
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  shop: boolean,
  floor: number,
  col?: number,
) => void;
export type DecorTools = {
  keep: Keep;
  shadowed: (mesh: THREE.Mesh) => THREE.Mesh;
  rounded: (w: number, h: number, d: number, segments: number, r: number) => THREE.BufferGeometry;
  clayMat: THREE.Material;
  clayDarkMat: THREE.Material;
};
/** A building's decor: its glowing sign (lit while there is light), and its own windows. */
export type Decor = {
  signMat: THREE.MeshStandardMaterial | null;
  windows(addWindow: AddWindow): void;
};

/** Everything goes into `yard`, which the game's facade hides (it shows the tower alone). */
export function decor4u(yard: THREE.Group, tools: DecorTools): Decor {
  const { keep, shadowed, rounded, clayMat, clayDarkMat } = tools;
  const treeMat = keep(new THREE.MeshStandardMaterial({ color: PALETTE.tree, roughness: 1 }));
  const courtMat = keep(new THREE.MeshStandardMaterial({ color: PALETTE.court, roughness: 1 }));
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
  return {
    signMat,
    windows(addWindow) {
      // the annex's shop windows
      for (let x = -33; x <= 29; x += 8) {
        addWindow(x, 3.2, 56.12, 3.8, 3.6, 0.3, true, -1);
        addWindow(x, 3.2, 41.88, 3.8, 3.6, 0.3, true, -1);
      }
      for (let z = 15; z <= 37; z += 8) addWindow(38.12, 3.2, z, 0.3, 3.6, 3.8, true, -1);
    },
  };
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
