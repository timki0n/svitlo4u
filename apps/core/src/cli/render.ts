/**
 * One schedule picture, as Telegram would get it:
 *   node src/cli/render.ts <siteId> <today|tomorrow> [out.png]
 * Needs RENDERER_CDP_URL (the headless Chromium, e.g. http://127.0.0.1:9222) and RENDER_WEB_URL
 * (a core or dev server with the web app and the API, e.g. http://127.0.0.1:5173).
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChromiumScheduleImages } from "../services/images.ts";

const [siteId = "4u", day = "today", out] = process.argv.slice(2);
const cdpUrl = process.env.RENDERER_CDP_URL;
const webUrl = process.env.RENDER_WEB_URL;
if (!cdpUrl || !webUrl || (day !== "today" && day !== "tomorrow")) {
  console.error(
    "Usage: RENDERER_CDP_URL=… RENDER_WEB_URL=… node src/cli/render.ts <siteId> <today|tomorrow> [out.png]",
  );
  process.exit(2);
}

const images = new ChromiumScheduleImages({
  cdpUrl,
  webUrl,
  dir: mkdtempSync(join(tmpdir(), "svitlo-render-")),
  log: { warn: (obj, msg) => console.error(msg, obj) },
});
const started = Date.now();
const file = await images.render(siteId, day);
if (!file) {
  console.error("No picture: nothing to draw, or the renderer failed (see above).");
  process.exit(1);
}
const target = resolve(out ?? `${siteId}-${day}.png`);
copyFileSync(file, target);
console.log(`${target} (${Date.now() - started} ms)`);
