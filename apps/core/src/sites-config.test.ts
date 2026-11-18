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

  it("parses per-site Telegram settings with forum topics; buildings may share a bot", () => {
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
    // One bot, many buildings: a chat's commands answer for the building it follows.
    const shared = parseSitesConfig(`sites:${telegram("a", "TG_A")}${telegram("b", "TG_B")}`, {
      ...env,
      TG_A: "1:x",
      TG_B: "1:x",
    });
    expect(shared.map((s) => [s.id, s.telegram?.botToken, s.telegram?.commands])).toEqual([
      ["a", "1:x", true],
      ["b", "1:x", true],
    ]);
    expect(() =>
      parseSitesConfig(`sites:${telegram("a", "TG_A").replace('"-1001"', '"@chan"')}`, {
        ...env,
        TG_A: "1:x",
      }),
    ).toThrow(/chatId_threadId/);
  });

  it("a hub site: the hub instead of ESP and plug, its secret from env", () => {
    const hubSite = (devices: string) => `
  - id: hub-test
    name: Тест хаб
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
${devices}`;
    const hub = "      - { id: hub-2a4c11, kind: hub, secretEnv: HUB_SECRET }";
    const [site] = parseSitesConfig(`sites:${hubSite(hub)}`, { HUB_SECRET: "h" });
    expect(site?.hub).toEqual({
      id: "hub-2a4c11",
      kind: "hub",
      secretEnv: "HUB_SECRET",
      silentAlertMs: 120_000,
      firmware: "latest",
      siteId: "hub-test",
      secret: "h",
    });
    expect(site?.esp).toEqual([]);
    expect(site?.plug).toBeNull();
    expect(() => parseSitesConfig(`sites:${hubSite(hub)}`, {})).toThrow(/env HUB_SECRET/);
    expect(() =>
      parseSitesConfig(`sites:${hubSite(`${hub}\n      - { id: p, kind: plug, zigbeeName: p }`)}`, {
        HUB_SECRET: "h",
      }),
    ).toThrow(/mixes a hub/);
    expect(() =>
      parseSitesConfig(`sites:${hubSite("      - { id: p, kind: plug, zigbeeName: p }")}`, {}),
    ).toThrow(/needs an esp or a hub/);
  });

  it("a send-only site may borrow another site's bot and announce only some kinds", () => {
    const yaml = `
sites:
  - id: 4u
    name: ЖК 4U
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
      - { id: esp-4u, kind: esp, transport: udp, secretEnv: ESP_4U_SECRET }
    telegram: { botTokenEnv: TG_4U, adminChatId: 42 }
  - id: hub-test
    name: Тест хаб
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
      - { id: hub-1, kind: hub, secretEnv: HUB_SECRET }
    telegram: { botTokenEnv: TG_4U, adminChatId: 42, commands: false, announce: [power, voltage] }
`;
    const [, test] = parseSitesConfig(yaml, { ...env, TG_4U: "1:x", HUB_SECRET: "h" });
    expect(test?.telegram).toMatchObject({
      botToken: "1:x",
      commands: false,
      announce: ["power", "voltage"],
    });
  });

  it("a building is public unless said otherwise, has no 3D figure, and cannot take a reserved address", () => {
    const yaml = (extra: string, id = "a") => `
sites:
  - id: ${id}
    name: A
    yasno: { region: 25, dso: 902, group: "1.1" }
    devices:
      - { id: esp-a, kind: esp, transport: http, secretEnv: ESP_4U_SECRET }
${extra}`;
    expect(parseSitesConfig(yaml(""), env)[0]).toMatchObject({
      access: "public",
      scene: "none",
      origin: "config",
    });
    expect(parseSitesConfig(yaml("    access: link\n    scene: 4u"), env)[0]).toMatchObject({
      access: "link",
      scene: "4u",
    });
    // any building's model from packages/domain, nothing else
    expect(parseSitesConfig(yaml("    scene: kolasa-27v"), env)[0]?.scene).toBe("kolasa-27v");
    expect(() => parseSitesConfig(yaml("    scene: castle"), env)).toThrow(/building model/);
    expect(() => parseSitesConfig(yaml("", "my"), env)).toThrow(/reserved/);
    expect(() => parseSitesConfig(yaml("", "api"), env)).toThrow(/reserved/);
  });
});
