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

/**
 * A message to the Telegram app around the page (as its web-app script does, without loading it):
 * through the native bridge on phones and the desktop app, to the parent frame on the web.
 */
function tell(event: string, data?: unknown): void {
  try {
    const bridge = (
      window as { TelegramWebviewProxy?: { postEvent(event: string, data?: string): void } }
    ).TelegramWebviewProxy;
    if (bridge) bridge.postEvent(event, data === undefined ? undefined : JSON.stringify(data));
    else if (window.parent !== window)
      window.parent.postMessage(
        JSON.stringify({ eventType: event, eventData: data }),
        "https://web.telegram.org",
      );
  } catch {
    // no Telegram around, or one too old for it: nothing to do
  }
}

if (initData) {
  tell("web_app_ready");
  tell("web_app_expand"); // the whole height from the start
  // the pages scroll and the game drags: pulling down must not fold the app away (Bot API 7.7;
  // older clients ignore it). It still closes from Telegram's own header.
  tell("web_app_setup_swipe_behavior", { allow_vertical_swipe: false });
}

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
