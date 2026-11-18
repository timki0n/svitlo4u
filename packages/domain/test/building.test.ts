/**
 * The building's model: ЖК 4U as data gives exactly what was written into the 3D code before;
 * Якуба Коласа, 27В is a right-angled outline of two sections with stair loggias.
 */
import { describe, expect, it } from "vitest";
import {
  BUILDING_MODELS,
  type BuildingModel,
  doorSpots,
  facadeProblems,
  GAME_COLS,
  GAME_FLOORS,
  GAME_WINDOWS,
  MODEL_4U,
  MODEL_KOLASA_27V,
  modelProblems,
  placeAt,
  storeyBottom,
  towerBox,
  towerHeight,
  towerTop,
  towerWalls,
  windowSpots,
  windowsPerStorey,
} from "../src/index.ts";

/** The windows of a storey as scene3d.ts computed them from its constants (before the model). */
function legacySpots() {
  const TOWER_X = 38;
  const TOWER_Z = 9.5;
  const WIN_OUT = 0.12;
  const GALLERY_X = [-19, 19];
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
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe("ЖК 4U as a model", () => {
  it("is a model that can be drawn and played", () => {
    expect(modelProblems(MODEL_4U)).toEqual([]);
    expect(facadeProblems(MODEL_4U)).toEqual([]);
  });

  it("the windows, numbered round the tower, stand where they stood (col 1–22)", () => {
    const spots = windowSpots(MODEL_4U);
    const legacy = legacySpots();
    expect(spots).toHaveLength(22);
    spots.forEach((s, i) => {
      const l = legacy[i] as (typeof legacy)[number];
      expect(close(s.x, l.x) && close(s.z, l.z), `col ${i + 1}`).toBe(true);
      expect([s.nx, s.nz]).toEqual([l.nx, l.nz]);
      expect(Object.is(s.nx, -0) || Object.is(s.nz, -0)).toBe(false);
    });
  });

  it("the walls the game's camera walks along are the same", () => {
    expect(towerWalls(MODEL_4U)).toEqual([
      { x: 38, z: -9.5, dx: -1, dz: 0, len: 76, nx: 0, nz: -1 },
      { x: -38, z: -9.5, dx: 0, dz: 1, len: 19, nx: -1, nz: 0 },
      { x: -38, z: 9.5, dx: 1, dz: 0, len: 76, nx: 0, nz: 1 },
      { x: 38, z: 9.5, dx: 0, dz: -1, len: 19, nx: 1, nz: 0 },
    ]);
    expect(towerBox(MODEL_4U)).toEqual({ halfX: 38, halfZ: 9.5 });
  });

  it("heights, storeys and doors: as before", () => {
    expect(towerHeight(MODEL_4U)).toBeCloseTo(6 + 26 * 2.95, 9);
    expect(towerTop(MODEL_4U)).toBeCloseTo(6 + 26 * 2.95 + 3.4, 9);
    expect(storeyBottom(MODEL_4U, 1)).toBe(0);
    expect(storeyBottom(MODEL_4U, 2)).toBe(6);
    expect(doorSpots(MODEL_4U)).toEqual(
      [-28, -14, 0, 14, 28].map((x) => ({ x, z: 9.5, nx: 0, nz: 1 })),
    );
    expect([GAME_FLOORS.first, GAME_FLOORS.last, GAME_COLS, GAME_WINDOWS]).toEqual([
      2, 27, 22, 572,
    ]);
  });
});

describe("Якуба Коласа, 27В as a model", () => {
  const m = MODEL_KOLASA_27V;

  it("can be drawn; the game's facade does not take its shape yet", () => {
    expect(modelProblems(m)).toEqual([]);
    expect(facadeProblems(m)).toEqual([
      "a rectangle only (not yet otherwise)",
      "shops on the ground floor only (not yet otherwise)",
      "doors on the +z wall only (not yet otherwise)",
    ]);
    expect(BUILDING_MODELS[m.id]).toBe(m);
  });

  it("two stair blocks stand 2 m out of the +z side; every wall runs along x or z", () => {
    const walls = towerWalls(m);
    expect(walls).toHaveLength(12);
    expect(walls.map((w) => Math.round(w.len * 100) / 100)).toEqual([
      9.5, 2, 7, 2, 19.7, 1.8, 6.6, 1.8, 9.2, 14, 52, 14,
    ]);
    // the fronts of the stair blocks look out (+z), their sides to the sides
    expect([walls[1], walls[2], walls[3]].map((w) => [w?.nx, w?.nz])).toEqual([
      [-1, 0],
      [0, 1],
      [1, 0],
    ]);
    expect(towerBox(m)).toEqual({ halfX: 26, halfZ: 8 });
  });

  it("16 storeys of flats from the ground floor, 27 windows each, an entrance under each stair block", () => {
    expect(towerHeight(m)).toBeCloseTo(16 * 2.8, 9);
    expect(storeyBottom(m, 2)).toBeCloseTo(2.8, 9);
    expect(windowsPerStorey(m)).toBe(27);
    // windows only on the long walls between the stair blocks, none on the ends
    expect(m.tower.windows.map((w) => w.length)).toEqual([3, 0, 0, 0, 6, 0, 0, 0, 3, 0, 15, 0]);
    // every window keeps clear of its wall's ends
    const walls = towerWalls(m);
    m.tower.windows.forEach((places, i) => {
      for (const at of places.map(placeAt)) {
        expect(at).toBeGreaterThanOrEqual(1.3);
        expect((walls[i]?.len ?? 0) - at).toBeGreaterThanOrEqual(1.3);
      }
    });
    expect(doorSpots(m)).toEqual([
      { x: -13, z: 8, nx: 0, nz: 1 },
      { x: 13.5, z: 7.8, nx: 0, nz: 1 },
    ]);
  });

  it("the −z side as on its photo: four pairs of balconies, two windows between them", () => {
    const side = (m.tower.windows[10] ?? []).map((p) => (typeof p === "number" ? "w" : "B"));
    expect(side.join("")).toBe("wBBwwBBwwBBwwBB");
    // the balconies of a pair stand side by side (3 m of glazing each), apart from the windows
    const spots = windowSpots(m).filter((s) => s.balcony);
    expect(spots).toHaveLength(8);
    expect(spots.every((s) => s.nz === -1)).toBe(true);
    expect(modelProblems({ ...m, tower: { ...m.tower, balcony: undefined } })).toContain(
      "balconies without a balcony's size",
    );
  });
});

describe("what is wrong with a model", () => {
  it("windows off a wall, a missing wall, a slanted wall", () => {
    const bent: BuildingModel = {
      ...MODEL_4U,
      tower: {
        ...MODEL_4U.tower,
        outline: [
          [38, -9.5],
          [-38, -9.5],
          [-30, 9.5],
          [38, 9.5],
        ],
        windows: [[4, 80], [], [], []],
      },
      doors: { ...MODEL_4U.doors, places: [{ wall: 7, at: 1 }] },
    };
    expect(modelProblems(bent)).toEqual([
      "wall 0: a window off the wall",
      "a door's wall does not exist",
      "walls along x or z only (not yet otherwise)",
    ]);
  });

  it("an outline that goes round the other way would turn every wall inside out", () => {
    const inside: BuildingModel = {
      ...MODEL_4U,
      tower: { ...MODEL_4U.tower, outline: [...MODEL_4U.tower.outline].reverse() },
    };
    expect(modelProblems(inside)).toContain("the outline goes round the wrong way");
  });
});
