/**
 * Pictures of the schedule for Telegram. A headless Chromium in its own container (reached over
 * CDP) opens the web app's #/render page — served by this core, so the picture always looks like
 * the site — and screenshots the card. One picture at a time; a failure means "send text only".
 */
import { lookup } from "node:dns/promises";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";

export type RenderDay = "today" | "tomorrow";

export type ScheduleImages = {
  /** A PNG of the day's schedule card, or null: nothing to draw (no schedule) or it failed. */
  render(siteId: string, day: RenderDay): Promise<string | null>;
};

export type ChromiumImagesConfig = {
  /** DevTools endpoint of the browser, e.g. http://renderer:9222. */
  cdpUrl: string;
  /** This core as the browser sees it, e.g. http://core:8080. */
  webUrl: string;
  /** Where the PNGs are written (and old ones removed). */
  dir: string;
  timeoutMs?: number;
  /** Pictures older than this are deleted when a new one is made. */
  keepMs?: number;
  log: { warn: (obj: object, msg: string) => void };
};

/** CSS width of the card; ×3 pixels so text stays sharp after Telegram's scaling. */
const WIDTH = 420;
const SCALE = 3;

export class ChromiumScheduleImages implements ScheduleImages {
  private readonly config: ChromiumImagesConfig;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(config: ChromiumImagesConfig) {
    this.config = config;
  }

  render(siteId: string, day: RenderDay): Promise<string | null> {
    const run = this.queue.then(() => this.renderNow(siteId, day));
    this.queue = run.catch(() => {});
    return run;
  }

  private async renderNow(siteId: string, day: RenderDay): Promise<string | null> {
    const timeout = this.config.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeout;
    const left = () => Math.max(1000, deadline - Date.now());
    let browser: Browser | null = null;
    try {
      browser = await chromium.connectOverCDP(await cdpEndpoint(this.config.cdpUrl), {
        timeout: left(),
      });
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: 900 },
        deviceScaleFactor: SCALE,
      });
      try {
        const page = await context.newPage();
        const base = this.config.webUrl.replace(/\/$/, "");
        await page.goto(`${base}/#/render/${encodeURIComponent(siteId)}/${day}`, {
          timeout: left(),
        });
        const card = page.locator("[data-render][data-ready]");
        await card.waitFor({ timeout: left() });
        if ((await card.getAttribute("data-empty")) !== null) return null;
        const png = await card.screenshot({ type: "png", animations: "disabled", timeout: left() });
        return this.save(siteId, day, png);
      } finally {
        await context.close().catch(() => {});
      }
    } catch (err) {
      this.config.log.warn({ err, site: siteId, day }, "schedule picture failed");
      return null;
    } finally {
      // Over CDP this only drops the connection; the browser keeps running for the next picture.
      await browser?.close().catch(() => {});
    }
  }

  private save(siteId: string, day: RenderDay, png: Buffer): string {
    const { dir } = this.config;
    mkdirSync(dir, { recursive: true });
    const keep = this.config.keepMs ?? 2 * 86_400_000;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (Date.now() - statSync(path).mtimeMs > keep) rmSync(path, { force: true });
      } catch {
        // gone meanwhile
      }
    }
    const file = join(dir, `${siteId}-${day}-${Date.now()}.png`);
    writeFileSync(file, png);
    return file;
  }
}

/**
 * Chrome answers DevTools HTTP requests only when the Host header is an IP or localhost, so a
 * service name (renderer) is resolved first; the WebSocket URL it returns then uses that IP.
 */
export async function cdpEndpoint(url: string): Promise<string> {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || isIP(host)) return url;
  const { address, family } = await lookup(host);
  parsed.hostname = family === 6 ? `[${address}]` : address;
  return parsed.toString().replace(/\/$/, "");
}
