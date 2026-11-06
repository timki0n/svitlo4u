/**
 * Live smoke test of the input adapters (run on the server, inside the compose network):
 *   MQTT_URL=mqtt://mosquitto:1883 MQTT_CORE_PASSWORD=… node apps/core/src/cli/adapters-smoke.ts
 * Polls Yasno twice and reads the plug three times. Changes nothing.
 */
import { connect } from "mqtt";
import { startPlugAdapter } from "../adapters/plug.ts";
import { YasnoPoller } from "../adapters/yasno.ts";

const groups = (process.env.YASNO_GROUPS ?? "12.1,6.1").split(",");
const poller = new YasnoPoller({
  region: 25,
  dso: 902,
  groups,
  onUpdate: (u) => {
    for (const [group, g] of Object.entries(u.groups)) {
      console.log(
        `  ${group}: today ${g.today.status} ${g.today.date}, tomorrow ${g.tomorrow.status}, updatedOn ${g.updatedOn}`,
      );
    }
  },
  onError: (e) => console.log(`  error: ${e}`),
});
for (let i = 1; i <= 2; i++) {
  const outcome = await poller.pollOnce();
  console.log(
    `yasno poll ${i}: ${outcome.kind}${"source" in outcome ? ` (${outcome.source})` : ""}, ${outcome.latencyMs} ms`,
  );
}

const password = process.env.MQTT_CORE_PASSWORD;
if (!password) {
  console.log("MQTT_CORE_PASSWORD not set — skipping plug");
  process.exit(0);
}
const client = connect(process.env.MQTT_URL ?? "mqtt://mosquitto:1883", {
  username: "core",
  password,
  reconnectPeriod: 0,
});
let sentAt = 0;
let answers = 0;
const adapter = startPlugAdapter({
  client,
  plugs: [
    { id: "4u-plug", kind: "plug", zigbeeName: process.env.PLUG_NAME ?? "4u-plug", siteId: "4u" },
  ],
  onPlug: (e) => {
    if (sentAt === 0) return;
    answers++;
    console.log(`plug answer: ${Date.now() - sentAt} ms, voltage ${e.voltage}`);
    sentAt = 0;
  },
  onBridgeState: (online) => console.log(`zigbee2mqtt bridge: ${online ? "online" : "offline"}`),
});
client.on("error", (e) => console.log(`mqtt error: ${e.message}`));
await new Promise<void>((resolve) => client.once("connect", () => resolve()));
console.log("mqtt connected as core");
await new Promise((r) => setTimeout(r, 1000));
for (let i = 0; i < 3; i++) {
  sentAt = Date.now();
  adapter.probe("4u");
  await new Promise((r) => setTimeout(r, 2500));
  if (sentAt !== 0) {
    console.log("plug: no answer within 2.5 s");
    sentAt = 0;
  }
}
console.log(`plug answered ${answers}/3`);
client.end(true);
