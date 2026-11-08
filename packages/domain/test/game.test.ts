import { describe, expect, it } from "vitest";
import { GAME_COLS, GAME_WINDOWS, gamePoints, gameTier, isGameWindow } from "../src/game.ts";

describe("game windows", () => {
  it("are every window round the tower, storeys 2–27", () => {
    expect(GAME_COLS).toBe(22);
    expect(GAME_WINDOWS).toBe(26 * 22);
    let count = 0;
    for (let floor = 0; floor <= 30; floor++)
      for (let col = -1; col <= 25; col++) if (isGameWindow(floor, col)) count++;
    expect(count).toBe(GAME_WINDOWS);
    expect([isGameWindow(2, 1), isGameWindow(2, 22), isGameWindow(27, 11)]).toEqual([
      true,
      true,
      true,
    ]);
    expect([
      isGameWindow(1, 1),
      isGameWindow(28, 1),
      isGameWindow(5, 23),
      isGameWindow(5.5, 2),
    ]).toEqual([false, false, false, false]);
  });

  it("get harder and pay more up the tower; the first to light one gets half more", () => {
    expect([
      gameTier(2),
      gameTier(9),
      gameTier(10),
      gameTier(18),
      gameTier(19),
      gameTier(27),
    ]).toEqual([0, 0, 1, 1, 2, 2]);
    expect([gamePoints(5, false), gamePoints(14, true), gamePoints(27, true)]).toEqual([
      10, 30, 45,
    ]);
  });
});
