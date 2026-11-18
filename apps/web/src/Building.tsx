import { useEffect, useRef, useState } from "react";
import type { BuildingMode, BuildingScene } from "./scene3d.ts";

const LABELS: Record<BuildingMode, string> = {
  on: "Будинок: світло є, вікна світяться",
  off: "Будинок: світла немає, вікна темні, світяться лише балкони холів від генератора",
  low: "Будинок: низька напруга, вікна тьмяні",
};

/**
 * The 3D figure of a building (`scene`: its model's id) on its plateau. three.js loads after the
 * first paint, in its own chunk.
 */
export function Building({ mode, scene }: { mode: BuildingMode; scene: string }) {
  const host = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const plate = useRef<HTMLDivElement>(null);
  const figure = useRef<BuildingScene | null>(null);
  const initialMode = useRef(mode);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("./scene3d.ts")
      .then(({ BUILDING_MODELS, createBuilding }) => {
        if (cancelled || !host.current || !canvas.current || !plate.current) return;
        const building = BUILDING_MODELS[scene];
        if (!building) throw new Error(`no building model "${scene}"`);
        figure.current = createBuilding(
          host.current,
          canvas.current,
          plate.current,
          initialMode.current,
          building,
        );
      })
      .catch((e: unknown) => {
        console.error(e);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      figure.current?.dispose();
      figure.current = null;
    };
  }, [scene]);

  useEffect(() => {
    initialMode.current = mode;
    figure.current?.setMode(mode);
  }, [mode]);

  // only ЖК 4U's hall galleries stay lit without light (its generator)
  const label =
    mode === "off" && scene !== "4u" ? "Будинок: світла немає, вікна темні" : LABELS[mode];
  return (
    <figure className="figure" ref={host}>
      <div className="plate" ref={plate} aria-hidden="true" />
      {/* focusable: the figure turns with the arrow keys */}
      <canvas ref={canvas} role="img" aria-label={label} tabIndex={0} />
      {failed && <p className="figure-fallback">3D-модель недоступна на цьому пристрої.</p>}
    </figure>
  );
}
