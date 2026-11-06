/**
 * Site configuration (config/sites.yaml): locations, Yasno group, devices.
 * Secrets never live in the file — a device names the environment variable holding its key.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_DETECTOR_CONFIG, type DetectorConfig, KYIV_TZ } from "@svitlo/domain";
import { parse } from "yaml";
import { z } from "zod";

const espDevice = z.object({
  id: z.string().min(1),
  kind: z.literal("esp"),
  /** udp: signed v2 packets; http: POST /iot/ping with X-Signature (light_bot_tg firmware). */
  transport: z.enum(["udp", "http"]),
  secretEnv: z.string().min(1),
  /** UDP only, migration: accept unsigned legacy {"ping": uptime} packets from these addresses. */
  legacyIps: z.array(z.string()).default([]),
});

const plugDevice = z.object({
  id: z.string().min(1),
  kind: z.literal("plug"),
  /** friendly_name in zigbee2mqtt. */
  zigbeeName: z.string().min(1),
});

const detectorOverrides = z
  .object({
    suspectAfterMs: z.number().int().positive(),
    probeTimeoutMs: z.number().int().positive(),
    probeAttempts: z.number().int().positive(),
    reprobeIntervalMs: z.number().int().positive(),
    plugKeepaliveMs: z.number().int().positive(),
    zigbeeStaleMs: z.number().int().positive(),
    espOnlyOffAfterMs: z.number().int().positive(),
    noVoltageMax: z.number(),
    uptimeToleranceMs: z.number().int().positive(),
  })
  .partial();

const siteSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes"),
  name: z.string().min(1),
  tz: z.string().default(KYIV_TZ),
  /** Domain used in links inside texts. */
  linkUrl: z.url().default("https://svitlo4u.info"),
  yasno: z.object({ region: z.number().int(), dso: z.number().int(), group: z.string().min(1) }),
  devices: z.array(z.discriminatedUnion("kind", [espDevice, plugDevice])).min(1),
  detector: detectorOverrides.default({}),
});

const fileSchema = z.object({ sites: z.array(siteSchema).min(1) });

export type EspDeviceConfig = z.infer<typeof espDevice> & { siteId: string; secret: string };
export type PlugDeviceConfig = z.infer<typeof plugDevice> & { siteId: string };
export type SiteConfig = Omit<z.infer<typeof siteSchema>, "devices" | "detector"> & {
  esp: EspDeviceConfig[];
  plug: PlugDeviceConfig | null;
  detector: DetectorConfig;
};

export function parseSitesConfig(text: string, env: NodeJS.ProcessEnv = process.env): SiteConfig[] {
  const parsed = fileSchema.safeParse(parse(text));
  if (!parsed.success) throw new Error(`sites config: ${z.prettifyError(parsed.error)}`);

  const ids = new Set<string>();
  const deviceIds = new Set<string>();
  return parsed.data.sites.map((site) => {
    if (ids.has(site.id)) throw new Error(`sites config: duplicate site id "${site.id}"`);
    ids.add(site.id);
    for (const d of site.devices) {
      if (deviceIds.has(d.id)) throw new Error(`sites config: duplicate device id "${d.id}"`);
      deviceIds.add(d.id);
    }
    const esp = site.devices
      .filter((d) => d.kind === "esp")
      .map((d) => {
        const secret = env[d.secretEnv];
        if (!secret)
          throw new Error(`sites config: env ${d.secretEnv} (secret of ${d.id}) is not set`);
        return { ...d, siteId: site.id, secret };
      });
    const plugs = site.devices.filter((d) => d.kind === "plug");
    if (plugs.length > 1) throw new Error(`sites config: site "${site.id}" has more than one plug`);
    if (esp.length === 0) throw new Error(`sites config: site "${site.id}" needs an esp device`);
    const plug = plugs[0] ? { ...plugs[0], siteId: site.id } : null;
    const { devices: _devices, detector, ...rest } = site;
    return {
      ...rest,
      esp,
      plug,
      detector: { ...DEFAULT_DETECTOR_CONFIG, ...detector, zigbee: plug !== null },
    };
  });
}

export function loadSitesConfig(path: string, env: NodeJS.ProcessEnv = process.env): SiteConfig[] {
  return parseSitesConfig(readFileSync(path, "utf8"), env);
}
