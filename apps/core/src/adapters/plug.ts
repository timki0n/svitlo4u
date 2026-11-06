/**
 * Zigbee plug adapter over zigbee2mqtt. Every state message from a configured plug becomes a
 * detector "plug" input (the plug is mains-powered: any message means power). Probes read
 * haElectricalMeasurement.rmsVoltage — this TS011F does not support `get voltage`, and the answer
 * arrives as an ordinary state message.
 */
import type { PlugDeviceConfig } from "../sites-config.ts";

export type PlugEvent = { siteId: string; deviceId: string; t: number; voltage: number | null };

/** The part of mqtt.js MqttClient this adapter uses (a fake implements it in tests). */
export type MqttLike = {
  subscribe(topic: string | string[], callback?: (error: Error | null) => void): unknown;
  publish(topic: string, message: string, callback?: (error?: Error) => void): unknown;
  on(event: "message", handler: (topic: string, payload: Buffer) => void): unknown;
  on(event: "connect", handler: () => void): unknown;
  on(event: string, handler: (...args: never[]) => void): unknown;
};

export const VOLTAGE_READ = JSON.stringify({
  read: { cluster: "haElectricalMeasurement", attributes: ["rmsVoltage"] },
});

export type PlugAdapter = {
  /** Ask the site's plug for a fresh reading (answer arrives via onPlug). */
  probe(siteId: string): boolean;
};

export function startPlugAdapter(options: {
  client: MqttLike;
  plugs: readonly PlugDeviceConfig[];
  baseTopic?: string;
  onPlug: (event: PlugEvent) => void;
  onBridgeState?: (online: boolean) => void;
  now?: () => number;
}): PlugAdapter {
  const base = options.baseTopic ?? "zigbee2mqtt";
  const now = options.now ?? Date.now;
  const byTopic = new Map(options.plugs.map((p) => [`${base}/${p.zigbeeName}`, p]));
  const bySite = new Map(options.plugs.map((p) => [p.siteId, p]));
  const topics = [...byTopic.keys(), `${base}/bridge/state`];

  // Subscribe on every (re)connect: a clean session forgets subscriptions.
  options.client.on("connect", () => options.client.subscribe(topics));

  options.client.on("message", (topic: string, payload: Buffer) => {
    if (topic === `${base}/bridge/state`) {
      const text = payload.toString();
      let state: unknown = text;
      try {
        if (text.startsWith("{")) state = (JSON.parse(text) as { state?: unknown }).state;
      } catch {
        return;
      }
      options.onBridgeState?.(state === "online");
      return;
    }
    const plug = byTopic.get(topic);
    if (!plug) return;
    let voltage: number | null = null;
    try {
      const body = JSON.parse(payload.toString()) as Record<string, unknown>;
      if (typeof body.voltage === "number" && Number.isFinite(body.voltage)) voltage = body.voltage;
    } catch {
      return; // not a state message
    }
    options.onPlug({ siteId: plug.siteId, deviceId: plug.id, t: now(), voltage });
  });

  return {
    probe(siteId) {
      const plug = bySite.get(siteId);
      if (!plug) return false;
      options.client.publish(`${base}/${plug.zigbeeName}/set`, VOLTAGE_READ);
      return true;
    },
  };
}
