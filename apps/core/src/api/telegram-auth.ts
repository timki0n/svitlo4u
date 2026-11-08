/**
 * Telegram Mini App sign-in: the app passes `initData` (signed by Telegram with the bot's token)
 * and the core checks the signature, so it knows which Telegram user plays — no passwords.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type MiniAppUser = {
  id: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
};

/** A Mini App left open stays signed in this long. */
export const INIT_DATA_MAX_AGE_MS = 24 * 3_600_000;

function checkString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function sign(params: URLSearchParams, botToken: string): string {
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return createHmac("sha256", secret).update(checkString(params)).digest("hex");
}

/** The user of a genuine, fresh initData; null for anything else. */
export function verifyInitData(
  initData: string,
  botToken: string,
  now: number,
  maxAgeMs = INIT_DATA_MAX_AGE_MS,
): MiniAppUser | null {
  if (initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const expected = Buffer.from(sign(params, botToken), "hex");
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return null;
  const authDate = Number(params.get("auth_date")) * 1000;
  if (!Number.isFinite(authDate) || authDate <= 0 || now - authDate > maxAgeMs) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null") as Record<string, unknown> | null;
    if (!user || typeof user.id !== "number" || !Number.isSafeInteger(user.id)) return null;
    const text = (v: unknown, max: number) =>
      typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
    return {
      id: user.id,
      firstName: text(user.first_name, 64) ?? "Сусід",
      lastName: text(user.last_name, 64),
      username: text(user.username, 32),
    };
  } catch {
    return null;
  }
}

/** Build a signed initData the way Telegram does (tests, local development). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  params.set("hash", sign(params, botToken));
  return params.toString();
}
