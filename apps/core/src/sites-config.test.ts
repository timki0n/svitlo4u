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
});
