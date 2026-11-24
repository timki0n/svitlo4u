/**
 * The clay figure of a building, built from its model (packages/domain): the tower with its
 * windows, seams, galleries, stair loggias and roof boxes, the shops or entrances of the ground
 * floor, and the plot round it with the building's own decor. Shared by the main screen and the
 * game's facade.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import {
  alongWall,
  type BuildingModel,
  doorSpots,
  type Point,
  storeyBottom,
  towerBox,
  towerHeight,
  towerTop,
  towerWalls,
  type Wall,
  WINDOW_OUT,
  type WindowSpot,
  windowSpots,
} from "../../../../packages/domain/src/building.ts";
import { type AddWindow, decor4u, type Keep } from "./decor-4u.ts";
import { PALETTE } from "./palette.ts";

/** A window on the ground plan: its centre and the way it looks (a unit vector). */
export type Spot = WindowSpot;

/** One window: floor −1 = shops on the ground; col = its place in the storey's windows, else −1. */
export type Light = { floor: number; col: number; lit: boolean; cool: boolean };

/** A building's sizes as the 3D code uses them (metres). */
export function measure(building: BuildingModel) {
  const { halfX, halfZ } = towerBox(building);
  const FLOOR = building.storey.height;
  const GROUND = building.storey.ground;
  /** Storeys of flats, with windows. */
  const FLOORS = building.storeys - building.firstFlat + 1;
  return {
    FLOOR,
    GROUND,
    FLOORS,
    H: towerHeight(building),
    /** Half the tower's length (x) and depth (z). */
    TOWER_X: halfX,
    TOWER_Z: halfZ,
    WIN_OUT: WINDOW_OUT,
    /** The windows of a storey, in the order the game numbers them. */
    SPOTS: windowSpots(building),
    /** The ground floor's doors (shops, «Вечорниці» in the game), door 1 first. */
    DOOR_X: doorSpots(building).map((d) => d.x),
    DOOR_W: building.doors.width,
    DOOR_H: building.doors.height,
    DOOR_Y: building.doors.y,
    FIRST_FLOOR: building.firstFlat,
    /** The highest point: the roof or the boxes on it. */
    FAR_TOP: towerTop(building),
  };
}

/**
 * The clay figure itself, shared by the main screen and the game's facade. `keep` collects what
 * the caller must dispose.
 */
export function buildFigure(building: BuildingModel, keep: Keep) {
  const { FLOOR, GROUND, FLOORS, H, TOWER_X, TOWER_Z, SPOTS, DOOR_W, DOOR_H, DOOR_Y } =
    measure(building);
  const walls = towerWalls(building);
  const clayMat = keep(new THREE.MeshStandardMaterial({ color: PALETTE.clay, roughness: 0.95 }));
  const clayDarkMat = keep(
    new THREE.MeshStandardMaterial({ color: PALETTE.clayDark, roughness: 1 }),
  );

  // ── model: metres, from the building's model ──────────────────────────────────────────────
  const model = new THREE.Group();
  const [cx, cz] = building.plot.centre;
  model.position.set(0 - cx, 0, 0 - cz); // turn around the middle of the plot

  const shadowed = (mesh: THREE.Mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const rounded = (w: number, h: number, d: number, segments: number, r: number) =>
    keep(new RoundedBoxGeometry(w, h, d, segments, r));

  const { outline } = building.tower;
  // a rectangle: a rounded box (ЖК 4U); any other outline: extruded, its corners rounded
  const tower =
    outline.length === 4
      ? shadowed(
          new THREE.Mesh(rounded(2 * TOWER_X, H, 2 * TOWER_Z, 5, building.tower.radius), clayMat),
        )
      : shadowed(new THREE.Mesh(keep(extruded(outline, H, building.tower.radius)), clayMat));
  if (outline.length === 4) {
    const xs = outline.map((p) => p[0]);
    const zs = outline.map((p) => p[1]);
    tower.position.set(
      (Math.min(...xs) + Math.max(...xs)) / 2,
      H / 2,
      (Math.min(...zs) + Math.max(...zs)) / 2,
    );
  }
  model.add(tower);
  // the seams of the sections, dark, across the whole tower
  for (const at of building.tower.seams) {
    const seam = new THREE.Mesh(
      keep(new THREE.BoxGeometry(0.5, H - 1, 2 * TOWER_Z + 0.3)),
      clayDarkMat,
    );
    seam.position.set(alongWall(walls[0] as Wall, at).x, H / 2, 0);
    model.add(seam);
  }
  // the boxes on the roof (lift machine rooms), sunk a little into it
  for (const box of building.tower.roof) {
    const [w, h, d] = box.size;
    const roofBox = shadowed(new THREE.Mesh(rounded(w, h, d, 3, 1), clayMat));
    roofBox.position.set(box.at[0], H + h / 2 - 0.1, box.at[1]);
    model.add(roofBox);
  }
  // everything round the tower (the decor, the plot's ground): the game shows the tower alone
  const yard = new THREE.Group();
  model.add(yard);
  const decor =
    building.decor === "4u"
      ? decor4u(yard, { keep, shadowed, rounded, clayMat, clayDarkMat })
      : null;
  // the plateau itself is CSS; here only its shadow catcher
  const shadowMat = keep(new THREE.ShadowMaterial({ opacity: 0.35, color: PALETTE.shadow }));
  const ground = new THREE.Mesh(
    keep(new THREE.CircleGeometry(building.plot.radius - 1, 72)),
    shadowMat,
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, 0.01, cz);
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
  const { window: pane, balcony } = building.tower;
  for (let f = 0; f < FLOORS; f++) {
    const bottom = storeyBottom(building, building.firstFlat + f);
    SPOTS.forEach((s, i) => {
      const long = s.nz !== 0; // on a long wall the window is wide along x
      // a balcony's glazing over its parapet, out of the wall; a window in the middle of the storey
      const size = s.balcony && balcony ? balcony : pane;
      const y = s.balcony && balcony ? bottom + 1 + balcony.height / 2 : bottom + FLOOR / 2;
      const out = s.balcony && balcony ? balcony.depth : 0;
      addWindow(
        s.x + s.nx * out,
        y,
        s.z + s.nz * out,
        long ? size.width : 0.3,
        size.height,
        long ? 0.3 : size.width,
        false,
        f,
        i,
      );
    });
  }
  // the decor's own windows (instances [decorFrom, decorTo)), then the tower's shops
  const decorFrom = lights.length;
  decor?.windows(addWindow satisfies AddWindow);
  const decorTo = lights.length;
  for (const place of building.doors.places) {
    const doorWall = walls[place.wall] as Wall;
    const p = alongWall(doorWall, place.at, WINDOW_OUT);
    const long = doorWall.nz !== 0;
    addWindow(p.x, DOOR_Y, p.z, long ? DOOR_W : 0.3, DOOR_H, long ? 0.3 : DOOR_W, true, -1);
  }
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

  // open galleries: the vertical strips of hall lights (the generator keeps them on)
  const recessGeo = keep(new THREE.BoxGeometry(3.6, H - GROUND - 1, 0.25));
  const barMat = keep(new THREE.MeshBasicMaterial({ toneMapped: false }));
  const { galleries } = building.tower;
  const bars = new THREE.InstancedMesh(
    keep(new THREE.BoxGeometry(3, 0.75, 0.35)),
    barMat,
    galleries.length * FLOORS,
  );
  let b = 0;
  for (const gallery of galleries) {
    const wall = walls[gallery.wall] as Wall;
    const turn = Math.atan2(wall.nx, wall.nz);
    const recessAt = alongWall(wall, gallery.at, 0.1);
    const recess = new THREE.Mesh(recessGeo, clayDarkMat);
    recess.position.set(recessAt.x, GROUND + (H - GROUND) / 2, recessAt.z);
    recess.rotation.y = turn;
    model.add(recess);
    const barAt = alongWall(wall, gallery.at, 0.25);
    for (let f = 0; f < FLOORS; f++) {
      bars.setMatrixAt(
        b++,
        new THREE.Matrix4()
          .makeRotationY(turn)
          .setPosition(barAt.x, storeyBottom(building, building.firstFlat + f) + 0.6, barAt.z),
      );
    }
  }
  model.add(bars);

  // balconies: on every storey a clay box out of the wall, a lighter parapet on its front and the
  // glazing over it (in the windows above); a thin gap between storeys draws their slabs
  const balconySpots = balcony ? SPOTS.filter((s) => s.balcony) : [];
  if (balcony && balconySpots.length > 0) {
    const cube = keep(new THREE.BoxGeometry(1, 1, 1));
    const count = balconySpots.length * FLOORS;
    // the tower's clay, a copy of its own: a material drawn both by an instanced mesh and by plain
    // ones makes three.js pick its shader anew at every switch between them, every frame
    const bodies = keep(new THREE.InstancedMesh(cube, keep(clayMat.clone()), count));
    const parapets = keep(
      new THREE.InstancedMesh(
        cube,
        keep(new THREE.MeshStandardMaterial({ color: PALETTE.parapet, roughness: 0.95 })),
        count,
      ),
    );
    const width = balcony.width + 0.2;
    const tall = FLOOR - 0.16;
    const { depth } = balcony;
    let k = 0;
    for (let f = 0; f < FLOORS; f++) {
      const bottom = storeyBottom(building, building.firstFlat + f);
      for (const s of balconySpots) {
        const long = s.nz !== 0;
        // from the wall's line (the window's spot stands WINDOW_OUT out of it)
        const out = (d: number) =>
          new THREE.Vector3(s.x + s.nx * (d - WINDOW_OUT), 0, s.z + s.nz * (d - WINDOW_OUT));
        const body = out(depth / 2).setY(bottom + 0.08 + tall / 2);
        const bodySize = new THREE.Vector3(long ? width : depth, tall, long ? depth : width);
        bodies.setMatrixAt(k, new THREE.Matrix4().compose(body, q, bodySize));
        const front = out(depth + 0.03).setY(bottom + 0.55);
        const frontSize = new THREE.Vector3(
          long ? width + 0.02 : 0.08,
          0.9,
          long ? 0.08 : width + 0.02,
        );
        parapets.setMatrixAt(k, new THREE.Matrix4().compose(front, q, frontSize));
        k++;
      }
    }
    for (const mesh of [bodies, parapets]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      model.add(mesh);
    }
  }

  // open loggias of the stairs: dark hexagonal openings side by side, from the storey above the
  // entrances up
  const { loggias } = building.tower;
  if (loggias.length > 0) {
    const storeys = building.storeys - 1;
    const openings = keep(
      new THREE.InstancedMesh(
        keep(new THREE.CircleGeometry(1, 6)),
        keep(new THREE.MeshStandardMaterial({ color: PALETTE.loggia, roughness: 1 })),
        loggias.reduce((sum, l) => sum + l.perStorey, 0) * storeys,
      ),
    );
    const up = new THREE.Vector3(0, 1, 0);
    let k = 0;
    for (const loggia of loggias) {
      const wall = walls[loggia.wall] as Wall;
      const facing = new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(wall.nx, wall.nz));
      const width = Math.min(1.3, wall.len / loggia.perStorey / 2 - 0.3);
      const size = new THREE.Vector3(width, FLOOR * 0.34, 1);
      for (let s = 2; s <= building.storeys; s++) {
        for (let i = 0; i < loggia.perStorey; i++) {
          const p = alongWall(wall, (wall.len * (i + 0.5)) / loggia.perStorey, 0.04);
          const at = new THREE.Vector3(p.x, storeyBottom(building, s) + FLOOR * 0.55, p.z);
          openings.setMatrixAt(k++, new THREE.Matrix4().compose(at, facing, size));
        }
      }
    }
    model.add(openings);
  }

  return {
    model,
    yard,
    decorWindows: [decorFrom, decorTo] as const,
    shopWindows: [decorTo, shopsTo] as const,
    winMesh,
    lights,
    bars,
    barMat,
    signMat: decor?.signMat ?? null,
  };
}

/**
 * A mass of any outline: its corners rounded (a curve from `r` before a corner to `r` after it,
 * never more than half a wall), extruded up to `h`, the top edge softened by a bevel that keeps
 * the walls where the outline puts them.
 */
function extruded(outline: readonly Point[], h: number, r: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const n = outline.length;
  outline.forEach(([x, z], i) => {
    const [px, pz] = outline[(i + n - 1) % n] as Point;
    const [nx, nz] = outline[(i + 1) % n] as Point;
    const back = Math.hypot(px - x, pz - z);
    const ahead = Math.hypot(nx - x, nz - z);
    const cut = Math.min(r, back / 2, ahead / 2);
    // the shape's y is the plan's −z: turned up below, it lands where the plan says
    const ax = x + ((px - x) / back) * cut;
    const az = z + ((pz - z) / back) * cut;
    if (i === 0) shape.moveTo(ax, -az);
    else shape.lineTo(ax, -az);
    shape.quadraticCurveTo(x, -z, x + ((nx - x) / ahead) * cut, -(z + ((nz - z) / ahead) * cut));
  });
  shape.closePath();
  const bevel = Math.min(0.4, r);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: h - 2 * bevel,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 2,
    curveSegments: 4,
  });
  geometry.rotateX(-Math.PI / 2); // extruded along +z: now up
  geometry.translate(0, bevel, 0);
  return geometry;
}
