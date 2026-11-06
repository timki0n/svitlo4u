import { describe, expect, it } from "vitest";
import { parseSitesConfig } from "./sites-config.ts";

const YAML = `
sites:
  - id: 4u
    name: ЖК 4U
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
      - { id: esp-4u, kind: esp, transport: udp, secretEnv: ESP_4U_SECRET, legacyIps: ["192.168.0.225"] }
      - { id: 4u-plug, kind: plug, zigbeeName: 4u-plug }
    detector: { probeTimeoutMs: 2500 }
  - id: g6
    name: Група 6.1
    yasno: { region: 25, dso: 902, group: "6.1" }
    devices:
      - { id: esp-g6, kind: esp, transport: http, secretEnv: ESP_G6_SECRET }
`;
const env = { ESP_4U_SECRET: "s1", ESP_G6_SECRET: "s2" };

describe("sites config", () => {
  it("parses sites, resolves secrets from env, merges detector defaults", () => {
    const [a, b] = parseSitesConfig(YAML, env);
    expect(a?.tz).toBe("Europe/Kyiv");
    expect(a?.linkUrl).toBe("https://svitlo4u.info");
    expect(a?.esp).toEqual([
      {
        id: "esp-4u",
        kind: "esp",
        transport: "udp",
        secretEnv: "ESP_4U_SECRET",
        legacyIps: ["192.168.0.225"],
        siteId: "4u",
        secret: "s1",
      },
    ]);
    expect(a?.plug).toEqual({ id: "4u-plug", kind: "plug", zigbeeName: "4u-plug", siteId: "4u" });
    expect(a?.detector.probeTimeoutMs).toBe(2500);
    expect(a?.detector.suspectAfterMs).toBe(5000);
    expect(a?.detector.zigbee).toBe(true);
    // A site without a plug runs the ESP-only detector.
    expect(b?.plug).toBeNull();
    expect(b?.detector.zigbee).toBe(false);
  });

  it("fails loudly on missing secrets, duplicates and bad ids", () => {
    expect(() => parseSitesConfig(YAML, { ESP_4U_SECRET: "s1" })).toThrow(/ESP_G6_SECRET/);
    expect(() => parseSitesConfig(YAML.replace("id: g6", "id: 4u"), env)).toThrow(
      /duplicate site id/,
    );
    expect(() => parseSitesConfig(YAML.replace("id: g6", "id: G 6"), env)).toThrow(/lowercase/);
    expect(() => parseSitesConfig("sites: []", env)).toThrow(/sites config/);
  });

  it("parses per-site Telegram settings with forum topics; one bot per site", () => {
    const telegram = (site: string, tokenEnv: string) => `
  - id: ${site}
    name: ${site}
    yasno: { region: 25, dso: 902, group: "1.1" }
    devices:
      - { id: esp-${site}, kind: esp, transport: http, secretEnv: ESP_4U_SECRET }
    telegram:
      botTokenEnv: ${tokenEnv}
      chats: ["-1001", "-1002_7"]
      adminChatId: 42
`;
    const [site] = parseSitesConfig(`sites:${telegram("a", "TG_A")}`, { ...env, TG_A: "1:x" });
    expect(site?.telegram).toMatchObject({
      botToken: "1:x",
      chats: [
        { chatId: -1001, threadId: null },
        { chatId: -1002, threadId: 7 },
      ],
      blockedChats: [],
      silentChats: [],
      adminChatId: 42,
      shadow: true,
      commands: true,
    });
    expect(() => parseSitesConfig(`sites:${telegram("a", "TG_A")}`, env)).toThrow(
      /env TG_A \(bot of a\) is not set/,
    );
    expect(() =>
      parseSitesConfig(`sites:${telegram("a", "TG_A")}${telegram("b", "TG_B")}`, {
        ...env,
        TG_A: "1:x",
        TG_B: "1:x",
      }),
    ).toThrow(/reuses another site's Telegram bot/);
    expect(() =>
      parseSitesConfig(`sites:${telegram("a", "TG_A").replace('"-1001"', '"@chan"')}`, {
        ...env,
        TG_A: "1:x",
      }),
    ).toThrow(/chatId_threadId/);
  });
});
