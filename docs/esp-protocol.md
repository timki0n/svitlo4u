# ESP heartbeat protocol

The ESP32 proves that mains power is present by sending a heartbeat. The core decides outages from
the heartbeat timing **and the ESP uptime**: uptime that keeps growing proves power never dropped
(a Wi-Fi gap), uptime that restarts proves a real outage and tells when power came back.

## UDP v2 (preferred)

One JSON datagram per second to `<server>:5005`:

```json
{
  "v": 2,
  "dev": "esp-4u",
  "boot": "9f3a1c2e",
  "seq": 1234,
  "up": 5678,
  "rst": "poweron",
  "sig": "…"
}
```

| Field  | Meaning                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| `v`    | protocol version, `2`                                                                                                 |
| `dev`  | device id from `config/sites.yaml`                                                                                    |
| `boot` | random hex generated once per boot (e.g. `esp_random()`), never reused                                                |
| `seq`  | packet counter, starts at 0 after boot, +1 per packet                                                                 |
| `up`   | seconds since boot (`esp_timer_get_time() / 1e6`), integer                                                            |
| `rst`  | reset reason of this boot: `poweron`, `brownout`, `sw`, `panic`, `wdt`, `ext`, `usb`, `deepsleep`, `unknown`, `other` |
| `sig`  | signature, see below                                                                                                  |

```text
sig = lowercase hex of the first 16 bytes of
      HMAC-SHA256(secret, "2" + "|" + dev + "|" + boot + "|" + seq + "|" + up + "|" + rst)
```

Test vector: secret `test-secret`, message `2|esp-4u|9f3a1c2e|1234|5678|poweron`
→ `sig = e4a113039c6c786f1b9cf03a3ad5623c`.

`rst` lets the server tell a power loss (`poweron`, `brownout`) from the ESP restarting itself
(`sw`, `panic`, `wdt`, …): the latter is never reported as an outage or a blip.

The server drops packets with a wrong signature, a `seq` not greater than the last one of the same
`boot`, or a `boot` it has already moved past (replays).

Firmware notes:

- send every **1 s**; detection waits 5 s of silence, so a few lost packets are harmless;
- reconnect Wi-Fi without blocking the loop — the legacy firmware waited up to 10 s per attempt,
  which produced the 10–12 s gaps seen in production every ~35 min;
- use a 64-bit uptime (`esp_timer_get_time()`), not `millis()`, which wraps after 49.7 days and
  would look like a reboot;
- reference firmware for the ESP32-C3 SuperMini: `firmware/esp32c3-heartbeat/`;
- the secret is the value of the device's `secretEnv` variable on the server.

## Legacy UDP

`{"ping": <uptime seconds>}` without a signature is accepted only from addresses listed in the
device's `legacyIps` — a migration aid for the current firmware. Remove the list once v2 runs.

## HTTP (light_bot_tg firmware)

`POST /iot/ping` with header `X-Signature: <hex HMAC-SHA256(secret, raw body)>`. The device is
identified by whichever configured secret matches. If the JSON body has `up`, `uptime` or `ping`
(seconds), it is used as uptime; otherwise outages are detected from timing only.
