import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { type MqttLike, type PlugEvent, startPlugAdapter, VOLTAGE_READ } from "./plug.ts";

class FakeMqtt extends EventEmitter {
  subscriptions: string[][] = [];
  published: [string, string][] = [];
  subscribe(topic: string | string[]) {
    this.subscriptions.push(Array.isArray(topic) ? topic : [topic]);
  }
  publish(topic: string, message: string) {
    this.published.push([topic, message]);
  }
  deliver(topic: string, payload: string) {
    this.emit("message", topic, Buffer.from(payload));
  }
}

function setup() {
  const client = new FakeMqtt();
  const events: PlugEvent[] = [];
  const bridge: boolean[] = [];
  const adapter = startPlugAdapter({
    client: client as unknown as MqttLike,
    plugs: [{ id: "4u-plug", kind: "plug", zigbeeName: "4u-plug", siteId: "4u" }],
    onPlug: (e) => events.push(e),
    onBridgeState: (online) => bridge.push(online),
    now: () => 123,
  });
  return { client, events, bridge, adapter };
}

describe("plug adapter (zigbee2mqtt)", () => {
  it("subscribes on every connect", () => {
    const { client } = setup();
    client.emit("connect");
    client.emit("connect");
    expect(client.subscriptions).toEqual([
      ["zigbee2mqtt/4u-plug", "zigbee2mqtt/bridge/state"],
      ["zigbee2mqtt/4u-plug", "zigbee2mqtt/bridge/state"],
    ]);
  });

  it("every state message is a plug event, with voltage when present", () => {
    const { client, events } = setup();
    client.deliver("zigbee2mqtt/4u-plug", '{"voltage":231,"state":"ON","linkquality":131}');
    client.deliver("zigbee2mqtt/4u-plug", '{"state":"OFF"}');
    expect(events).toEqual([
      { siteId: "4u", deviceId: "4u-plug", t: 123, voltage: 231 },
      { siteId: "4u", deviceId: "4u-plug", t: 123, voltage: null },
    ]);
  });

  it("ignores other devices, availability topics and garbage", () => {
    const { client, events } = setup();
    client.deliver("zigbee2mqtt/other-plug", '{"voltage":230}');
    client.deliver("zigbee2mqtt/4u-plug/availability", '{"state":"online"}');
    client.deliver("zigbee2mqtt/4u-plug", "not json");
    expect(events).toEqual([]);
  });

  it("reports bridge online/offline (plain and JSON payloads)", () => {
    const { client, bridge } = setup();
    client.deliver("zigbee2mqtt/bridge/state", '{"state":"online"}');
    client.deliver("zigbee2mqtt/bridge/state", "offline");
    client.deliver("zigbee2mqtt/bridge/state", "{broken");
    expect(bridge).toEqual([true, false]);
  });

  it("probe reads rmsVoltage through /set; unknown site is a no-op", () => {
    const { client, adapter } = setup();
    expect(adapter.probe("4u")).toBe(true);
    expect(adapter.probe("g6")).toBe(false);
    expect(client.published).toEqual([["zigbee2mqtt/4u-plug/set", VOLTAGE_READ]]);
    expect(JSON.parse(VOLTAGE_READ)).toEqual({
      read: { cluster: "haElectricalMeasurement", attributes: ["rmsVoltage"] },
    });
  });
});
