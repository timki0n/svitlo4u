/**
 * The 3D figure of a building, loaded after the first paint in its own chunk: the main screen's
 * figure and the game's facade, both built from the building's model (packages/domain).
 */
export { BUILDING_MODELS } from "../../../packages/domain/src/building.ts";
export {
  createFacade,
  type FacadeDoor,
  type FacadeLit,
  type FacadeScene,
  type FacadeWindow,
} from "./building/facade.ts";
export { type BuildingMode, type BuildingScene, createBuilding } from "./building/main.ts";
