/**
 * Opened as the bot's Mini App, the page gets Telegram's signed launch data in the address
 * (#tgWebAppData=…). It is read once at start, kept for the tab's life (a reload inside the app
 * keeps it) and sent with the game's calls; the core checks the signature. Outside the Mini App
 * there is none, and the game is not offered.
 */
const KEY = "svitlo4u.tg";
let initData: string | null = null;

(function capture() {
  const raw = location.hash.slice(1);
  if (raw.includes("tgWebAppData=")) {
    initData = new URLSearchParams(raw).get("tgWebAppData");
    try {
      if (initData) sessionStorage.setItem(KEY, initData);
    } catch {
      // storage blocked: the data lives until the page is closed
    }
    // the page's own routes live in the hash too
    history.replaceState(null, "", `${location.pathname}${location.search}#/`);
    return;
  }
  try {
    initData = sessionStorage.getItem(KEY);
  } catch {
    initData = null;
  }
})();

/** Signed launch data of the Mini App, null in a plain browser. */
export const tgInitData = (): string | null => initData;
export const inMiniApp = (): boolean => initData !== null;

/** The Telegram id of whoever opened the Mini App (to mark "you" before the core answers). */
export function tgUserId(): number | null {
  if (!initData) return null;
  try {
    const user = JSON.parse(new URLSearchParams(initData).get("user") ?? "null") as {
      id?: unknown;
    } | null;
    return typeof user?.id === "number" ? user.id : null;
  } catch {
    return null;
  }
}
