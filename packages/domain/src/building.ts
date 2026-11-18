/**
 * A building as data: its tower's outline and storeys, the windows of every wall, the open
 * galleries and stair loggias, the doors of the ground floor and the plot round it. The main
 * screen's figure, the game's facade and the game's rules (which windows and doors exist) all come
 * from one model.
 *
 * Metres. Seen from above x runs along the building and z across it; y is up. The outline goes
 * round the tower to the right as seen from outside, and that is the order its windows are
 * numbered in (col 1, 2, … on every storey of flats).
 */

export type Point = readonly [x: number, z: number];

/** A window on a wall: its distance from the wall's start; a balcony's is wide glazing over a parapet. */
export type WindowPlace = number | { at: number; balcony: true };

/** Where a window stands along its wall. */
export const placeAt = (place: WindowPlace): number =>
  typeof place === "number" ? place : place.at;

export type BuildingModel = {
  id: string;
  /** Heights of the ground floor and of every storey above it. */
  storey: { ground: number; height: number };
  /** Storeys, the ground floor too. */
  storeys: number;
  /** The first storey of flats (with windows, the game's): 1, or 2 above shops on the ground floor. */
  firstFlat: number;
  tower: {
    /** Corners round the tower; wall i runs from corner i to corner i + 1 (the last to the first). */
    outline: readonly Point[];
    /** Rounded edges of the mass. */
    radius: number;
    /** Windows of every wall, the same on every storey of flats. */
    windows: readonly (readonly WindowPlace[])[];
    /** A window's size: across and up (m). */
    window: { width: number; height: number };
    /** A balcony: its glazing (over the parapet) across and up, and how far it stands out (m). */
    balcony?: { width: number; height: number; depth: number };
    /** Open galleries of the halls (vertical strips of lights): wall and distance from its start. */
    galleries: readonly { wall: number; at: number }[];
    /** Open loggias of the stairs: a whole wall of hexagonal openings, so many a storey, above the ground floor. */
    loggias: readonly { wall: number; perStorey: number }[];
    /** Seams between sections: distances along wall 0, across the whole tower. */
    seams: readonly number[];
    /** Boxes on the roof (lift machine rooms): centre on the plan and size (along x, up, along z). */
    roof: readonly { at: Point; size: readonly [number, number, number] }[];
  };
  /**
   * Doors of the ground floor (shops, entrances), «Вечорниці» in the game, door 1 first: wall and
   * distance from its start; their size and the height of their centre.
   */
  doors: {
    places: readonly { wall: number; at: number }[];
    width: number;
    height: number;
    y: number;
  };
  /** The plot round the tower on the main screen: the figure turns round its centre. */
  plot: { centre: Point; radius: number };
  /** Hand-made details beyond the shape, drawn by the web app (the annex and the sign of ЖК 4U). */
  decor?: "4u";
};

/** A wall of the tower: where it starts, which way it runs (unit), how long, which way it looks. */
export type Wall = {
  x: number;
  z: number;
  dx: number;
  dz: number;
  len: number;
  nx: number;
  nz: number;
};

/** A window on the plan: its centre (a little out of the wall) and the way it looks. */
export type WindowSpot = { x: number; z: number; nx: number; nz: number; balcony?: true };

/** How far windows stand out of the walls. */
export const WINDOW_OUT = 0.12;

/** −0 → 0, so that a way that looks along an axis compares and turns like the plain number. */
const plain = (v: number) => v + 0;

export function towerWalls(model: BuildingModel): Wall[] {
  const { outline } = model.tower;
  return outline.map(([x, z], i) => {
    const [x1, z1] = outline[(i + 1) % outline.length] as Point;
    const len = Math.hypot(x1 - x, z1 - z);
    const dx = plain((x1 - x) / len);
    const dz = plain((z1 - z) / len);
    // the way out of the wall: the way round turned a quarter
    return { x, z, dx, dz, len, nx: plain(-dz), nz: plain(dx) };
  });
}

/** The point `at` metres along a wall, `out` metres out of it. */
export function alongWall(wall: Wall, at: number, out = 0): { x: number; z: number } {
  return { x: wall.x + wall.dx * at + wall.nx * out, z: wall.z + wall.dz * at + wall.nz * out };
}

/** The windows of a storey of flats in the order they are numbered (col 1 first). */
export function windowSpots(model: BuildingModel): WindowSpot[] {
  const walls = towerWalls(model);
  return model.tower.windows.flatMap((list, i) => {
    const wall = walls[i] as Wall;
    return list.map((place) => ({
      ...alongWall(wall, placeAt(place), WINDOW_OUT),
      nx: wall.nx,
      nz: wall.nz,
      ...(typeof place === "number" ? {} : { balcony: true as const }),
    }));
  });
}

/** Where a storey (1 = the ground floor) starts above the ground. */
export const storeyBottom = (model: BuildingModel, storey: number): number =>
  storey <= 1 ? 0 : model.storey.ground + (storey - 2) * model.storey.height;

/** The top of the walls (the roof), above the ground. */
export const towerHeight = (model: BuildingModel): number =>
  model.storey.ground + (model.storeys - 1) * model.storey.height;

/** The highest point: the roof or what stands on it. */
export const towerTop = (model: BuildingModel): number =>
  towerHeight(model) + Math.max(0, ...model.tower.roof.map((box) => box.size[1]));

/** Storeys of flats (the game's windows), the first and the last. */
export const flatStoreys = (model: BuildingModel): { first: number; last: number } => ({
  first: model.firstFlat,
  last: model.storeys,
});

/** Windows on a storey of flats. */
export const windowsPerStorey = (model: BuildingModel): number =>
  model.tower.windows.reduce((sum, list) => sum + list.length, 0);

/** The doors' centres on the plan (at the wall's line) and the way they look, door 1 first. */
export function doorSpots(model: BuildingModel): WindowSpot[] {
  const walls = towerWalls(model);
  return model.doors.places.map(({ wall, at }) => {
    const w = walls[wall] as Wall;
    return { ...alongWall(w, at), nx: w.nx, nz: w.nz };
  });
}

/** The tower's outline as an axis-aligned box (half length and half depth round its middle). */
export function towerBox(model: BuildingModel): { halfX: number; halfZ: number } {
  const xs = model.tower.outline.map((p) => p[0]);
  const zs = model.tower.outline.map((p) => p[1]);
  return {
    halfX: (Math.max(...xs) - Math.min(...xs)) / 2,
    halfZ: (Math.max(...zs) - Math.min(...zs)) / 2,
  };
}

/** Twice the outline's area, signed: negative when it goes round the way the walls expect. */
function signedArea2(outline: readonly Point[]): number {
  return outline.reduce((sum, [x, z], i) => {
    const [x1, z1] = outline[(i + 1) % outline.length] as Point;
    return sum + x * z1 - x1 * z;
  }, 0);
}

/** What is wrong with a model; empty when its figure can be drawn (see facadeProblems for the game). */
export function modelProblems(model: BuildingModel): string[] {
  const problems: string[] = [];
  const { outline, windows, galleries, loggias, seams } = model.tower;
  const walls = towerWalls(model);
  const onWall = (wall: number, at: number) => {
    const len = walls[wall]?.len;
    return len !== undefined && at > 0 && at < len;
  };
  if (outline.length < 3) problems.push("the outline needs at least 3 corners");
  else if (signedArea2(outline) >= 0) problems.push("the outline goes round the wrong way");
  if (windows.length !== outline.length) problems.push("a list of windows for every wall");
  windows.forEach((places, i) => {
    const list = places.map(placeAt);
    if (list.some((at) => !onWall(i, at))) problems.push(`wall ${i}: a window off the wall`);
    if (list.some((at, k) => k > 0 && at <= (list[k - 1] as number)))
      problems.push(`wall ${i}: windows not in order along the wall`);
  });
  if (windows.some((places) => places.some((p) => typeof p !== "number")) && !model.tower.balcony)
    problems.push("balconies without a balcony's size");
  if (galleries.some((g) => !onWall(g.wall, g.at))) problems.push("a gallery off the walls");
  if (loggias.some((l) => walls[l.wall] === undefined || l.perStorey < 1))
    problems.push("a loggia off the walls");
  if (seams.some((at) => !onWall(0, at))) problems.push("a seam off wall 0");
  if (model.doors.places.some((d) => walls[d.wall] === undefined))
    problems.push("a door's wall does not exist");
  else if (model.doors.places.some((d) => !onWall(d.wall, d.at)))
    problems.push("a door off its wall");
  if (model.firstFlat < 1 || model.firstFlat > model.storeys)
    problems.push("the first storey of flats is out of the building");
  // what the figure handles so far: walls along x or z
  if (!walls.every((w) => w.dx === 0 || w.dz === 0))
    problems.push("walls along x or z only (not yet otherwise)");
  return problems;
}

/** What keeps the game's facade from showing a model so far (it was written for ЖК 4U). */
export function facadeProblems(model: BuildingModel): string[] {
  const problems: string[] = [];
  const walls = towerWalls(model);
  const { outline } = model.tower;
  if (outline.length !== 4) problems.push("a rectangle only (not yet otherwise)");
  const xs = outline.map((p) => p[0]);
  const zs = outline.map((p) => p[1]);
  const off = (v: number[]) => Math.abs(Math.min(...v) + Math.max(...v)) > 1e-9;
  if (off(xs) || off(zs)) problems.push("the tower centred on the origin only (not yet otherwise)");
  if (model.firstFlat !== 2) problems.push("shops on the ground floor only (not yet otherwise)");
  const front = Math.max(...zs);
  if (model.doors.places.some((d) => walls[d.wall]?.nz !== 1 || walls[d.wall]?.z !== front))
    problems.push("doors on the +z wall only (not yet otherwise)");
  return problems;
}

/** Pairs of balconies side by side round each centre, and plain windows: all along the wall, in order. */
function balconyRow(pairs: readonly number[], plain: readonly number[]): WindowPlace[] {
  const balconies = pairs
    .flatMap((c) => [c - 1.6, c + 1.6])
    .map((at) => ({
      at: Math.round(at * 100) / 100,
      balcony: true as const,
    }));
  return [...balconies, ...plain].sort((a, b) => placeAt(a) - placeAt(b));
}

/** Windows `step` apart along a wall of `len`, centred on it, at least `margin` from its ends. */
function spaced(len: number, step: number, margin = 1.3): number[] {
  const n = Math.floor((len - 2 * margin) / step) + 1;
  const start = (len - (n - 1) * step) / 2;
  return Array.from({ length: n }, (_, i) => Math.round((start + i * step) * 100) / 100);
}

/**
 * ЖК 4U, sections I–II: one mass 76 × 19 m on 27 storeys (OSM and the developer's site plan),
 * shops on the yard side of the ground floor, two open hall galleries on the yard side, the annex
 * round the yard. Windows every 6.8 m on the long walls (none on the seam of the sections nor in
 * front of the galleries), two on each end.
 */
export const MODEL_4U: BuildingModel = {
  id: "4u",
  storey: { ground: 6, height: 2.95 },
  storeys: 27,
  firstFlat: 2,
  tower: {
    // the street side (−z) from its +x end, the −x end, the yard side (+z), the +x end
    outline: [
      [38, -9.5],
      [-38, -9.5],
      [-38, 9.5],
      [38, 9.5],
    ],
    radius: 2.2,
    windows: [
      [4, 10.8, 17.6, 24.4, 31.2, 44.8, 51.6, 58.4, 65.2, 72],
      [4.5, 14.5],
      [4, 10.8, 24.4, 31.2, 44.8, 51.6, 65.2, 72],
      [4.5, 14.5],
    ],
    window: { width: 2.4, height: 1.5 },
    galleries: [
      { wall: 2, at: 19 },
      { wall: 2, at: 57 },
    ],
    loggias: [],
    seams: [38],
    roof: [
      { at: [-19, -1.5], size: [12, 3.4, 9] },
      { at: [19, -1.5], size: [12, 3.4, 9] },
    ],
  },
  doors: {
    places: [10, 24, 38, 52, 66].map((at) => ({ wall: 2, at })),
    width: 5.5,
    height: 4,
    y: 3,
  },
  plot: { centre: [0, 22], radius: 58 },
  decor: "4u",
};

/**
 * Якуба Коласа, 27В: a panel slab of two sections on 16 storeys, 52 × 14 m along the street
 * (OSM way 39700117, turned so its long walls run along x; +z looks north-north-west). On the
 * +z side each section's stairs and lifts stand 2 m out of the wall, their front a column of
 * open loggias with hexagonal openings, two a storey, the entrance under it. Flats from the
 * ground floor; windows about every 3.2 m on the long walls, none on the ends. The −z side (a
 * photo of it): four pairs of balconies standing 2 m out, 13.4 m apart, two windows between them.
 */
export const MODEL_KOLASA_27V: BuildingModel = {
  id: "kolasa-27v",
  storey: { ground: 2.8, height: 2.8 },
  storeys: 16,
  firstFlat: 1,
  tower: {
    // the +z side from its −x end with the two stair blocks, the +x end, the −z side, the −x end
    outline: [
      [-26, 6],
      [-16.5, 6],
      [-16.5, 8],
      [-9.5, 8],
      [-9.5, 6],
      [10.2, 6],
      [10.2, 7.8],
      [16.8, 7.8],
      [16.8, 6],
      [26, 6],
      [26, -8],
      [-26, -8],
    ],
    radius: 0.6,
    windows: [
      spaced(9.5, 3.2),
      [],
      [],
      [],
      spaced(19.7, 3.2),
      [],
      [],
      [],
      spaced(9.2, 3.2),
      [],
      balconyRow([7.2, 20.6, 34, 47.4], [1.7, 12.6, 15.5, 26.5, 29.3, 39.6, 42.4]),
      [],
    ],
    window: { width: 1.6, height: 1.5 },
    balcony: { width: 3, height: 1.35, depth: 2 },
    galleries: [],
    loggias: [
      { wall: 2, perStorey: 2 },
      { wall: 6, perStorey: 2 },
    ],
    seams: [],
    roof: [
      { at: [-13, 5.5], size: [6, 2.8, 5] },
      { at: [13.5, 5.3], size: [6, 2.8, 5] },
    ],
  },
  doors: {
    places: [
      { wall: 2, at: 3.5 },
      { wall: 6, at: 3.3 },
    ],
    width: 2,
    height: 2.4,
    y: 1.3,
  },
  plot: { centre: [0, 0], radius: 34 },
};

/** The models by id (a site's `scene`). */
export const BUILDING_MODELS: Readonly<Record<string, BuildingModel>> = {
  [MODEL_4U.id]: MODEL_4U,
  [MODEL_KOLASA_27V.id]: MODEL_KOLASA_27V,
};
