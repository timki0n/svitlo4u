import { useEffect, useRef, useState } from "react";
import type { BuildingMode, BuildingScene } from "./scene3d.ts";

const LABELS: Record<BuildingMode, string> = {
  on: "Будинок: світло є, вікна світяться",
  off: "Будинок: світла немає, вікна темні, світяться лише балкони холів від генератора",
  low: "Будинок: низька напруга, вікна тьмяні",
};

/** The 3D figure on its plateau. three.js loads after the first paint, in its own chunk. */
export function Building({ mode }: { mode: BuildingMode }) {
  const host = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const plate = useRef<HTMLDivElement>(null);
  const scene = useRef<BuildingScene | null>(null);
  const initialMode = useRef(mode);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("./scene3d.ts")
      .then(({ createBuilding }) => {
        if (cancelled || !host.current || !canvas.current || !plate.current) return;
        scene.current = createBuilding(
          host.current,
          canvas.current,
          plate.current,
          initialMode.current,
        );
      })
      .catch((e: unknown) => {
        console.error(e);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    initialMode.current = mode;
    scene.current?.setMode(mode);
  }, [mode]);

  return (
    <figure className="figure" ref={host}>
      <div className="plate" ref={plate} aria-hidden="true" />
      {/* focusable: the figure turns with the arrow keys */}
      <canvas ref={canvas} role="img" aria-label={LABELS[mode]} tabIndex={0} />
      {failed && <p className="figure-fallback">3D-модель недоступна на цьому пристрої.</p>}
    </figure>
  );
}
