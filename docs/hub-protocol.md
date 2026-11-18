# Hub protocol

The hub is an ESP32-C6 that runs its own Zigbee network with one mains-powered smart
plug and reports to the core over Wi-Fi. Unlike the ESP heartbeat, the hub itself is meant to sit
on the router's UPS: its reports say nothing about the mains by themselves — **the plug** does.
The hub reads the plug's voltage every second; any answer means the plug — so the mains — is
alive (it has no battery). A silence of the **alert delay** means the mains is gone since the
plug's last answer; the first answer after that means it is back. The hub decides this itself and
tells the core when it happened by its own clock (the last answer before the silence, the first
one after it), so the core gets exact times even when the internet was down in between.

The alert delay follows the plug's signal at the hub (averaged over about a minute): 15 s from
−70 dBm, 18 s to −78, 22 s below. A shorter silence is a problem of the link, not
the light: the radio link drops for up to ~15 s now and then (a router renews its links every
15 s; at −79 dBm two such gaps came as false «off», 2026-11-16). They are counted (`plug.gaps`)
and tell the admin. A blink of the power shorter than the delay looks the same (the TS011F does
not announce itself when it starts again, and needs 3–4 s to: a 5 s unplug is ~8.4 s of silence)
and is not an outage on purpose. The time in the notice stays exact; the delay is only how soon
it comes.

The hub also tells the plug to come on whenever the power returns (Tuya `0x8002` and ZCL
`StartUpOnOff` of its On/Off cluster) and turns it on after its own start and after an outage.

Firmware: `firmware/hub/`. Measurements behind this design (2026-11-15): a hub on a plain charger
outlives the plug by only 0–200 ms after a power cut — not enough to send anything with Wi-Fi on —
so the supported setup is the hub on the router's UPS. On a UPS the core learned of a cut 5.0 s
after the plug's last answer (then the threshold; now the alert delay) and of the light coming
back within milliseconds.

## Request

`POST /iot/hub`, header `X-Signature: <lowercase hex HMAC-SHA256(secret, raw body)>`, JSON body:

```json
{
  "v": 1,
  "dev": "hub-2a4c11",
  "boot": "9f3a1c2e",
  "seq": 17,
  "up": 1234.567,
  "rst": "poweron",
  "fw": "0.1.0",
  "plug": {
    "paired": true,
    "mains": "on",
    "since": 15.2,
    "voltage": 228.4,
    "rssi": -61,
    "gaps": 0,
    "longestGap": 0,
    "delay": 15,
    "rssiAvg": -62
  },
  "events": [{ "up": 1200.153, "mains": "off" }, { "up": 1210.882, "mains": "on" }],
  "wifi": {
    "rssi": -68,
    "ch": 8,
    "drops": 2,
    "reason": 200,
    "down": 4.6,
    "kicks": 0,
    "lost": 0,
    "redone": 5
  },
  "ota": { "state": "idle", "version": null, "error": null, "rejected": null }
}
```

| Field             | Meaning                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| `v`               | protocol version, `1`                                                                  |
| `dev`             | device id from `config/sites.yaml` (`kind: hub`)                                       |
| `boot`            | random hex generated once per boot, never reused                                       |
| `seq`             | request counter, starts at 0 after boot, +1 per request                                |
| `up`              | seconds since boot, with milliseconds, when the request was built                      |
| `rst`             | reset reason of this boot, as in the ESP protocol (`poweron`, `brownout`, `sw`, …)     |
| `fw`              | firmware version                                                                       |
| `plug.paired`     | a plug is paired                                                                       |
| `plug.mains`      | `on` (plug answers), `off` (plug silent) or `unknown` (not decided yet after boot)     |
| `plug.since`      | hub uptime (s) when the current `mains` verdict began, `null` if unknown               |
| `plug.voltage`    | last voltage the plug measured, V, `null` if none yet                                  |
| `plug.rssi`       | signal of the plug's last answer, dBm, `null` if none                                  |
| `plug.gaps`       | silences shorter than the alert delay since the boot: gaps of the radio link           |
| `plug.longestGap` | the longest of them, s                                                                 |
| `plug.delay`      | the alert delay now, s (follows the signal)                                            |
| `plug.rssiAvg`    | the plug's signal averaged over about a minute, dBm, `null` if none                    |
| `events`          | mains changes the core has not acknowledged yet, oldest first, by hub uptime (s)       |
| `wifi.rssi`       | the router's signal at the hub, dBm (firmware 0.2.5+; the whole `wifi` is optional)    |
| `wifi.ch`         | the router's channel                                                                   |
| `wifi.drops`      | times a working Wi-Fi was lost since the boot                                          |
| `wifi.reason`     | reason of the last drop (ESP-IDF `wifi_err_reason_t`: 200 = beacon timeout), 0 if none |
| `wifi.down`       | how long the last drop lasted, s (until the address was back)                          |
| `wifi.kicks`      | reconnects the hub's watchdog had to force                                             |
| `wifi.lost`       | reports that got no answer, neither on the kept connection nor on a new one            |
| `wifi.redone`     | reports whose kept connection was dead and that went through on a new one              |
| `ota.state`       | `idle`, `downloading`, `ready` (waits to restart into it) or `failed`                  |
| `ota.version`     | the version being downloaded / ready / failed, else `null`                             |
| `ota.error`       | why the last attempt failed (`http 403`, `sha256`, `version`, …), else `null`          |
| `ota.rejected`    | a version that did not confirm itself and was rolled back, else `null`                 |

Times are hub uptimes, not clock times: the core converts them as
`receivedAt − (up − event.up) × 1000`. No clock sync is needed and an internet gap does not shift
anything.

The hub sends a request every **30 s**, at once after a mains change and when its Wi-Fi is back,
and keeps resending every few seconds (3 s, then slower up to 30 s) while requests fail. It drops
the events up to the acknowledged `seq`.

The connection is kept between requests. The internet drops such connections whenever it likes
(measured 2026-11-18 at a home with a busy line: several times an hour, and a PC next to the hub
lost its own at the same moments), so a request that got no answer at all is sent once more at
once, on a new connection (0.2.5; before that the hub waited for the next half-minute, a 64-s hole
each time).

## Wi-Fi

The hub shares one radio between Wi-Fi and Zigbee. Measured on the bench (2026-11-18): in the
steady state Wi-Fi stays up for hours; what breaks it is the router (one that changes its channel
by itself does it many times a day) and a weak signal. Since 0.2.5:

- the driver's «beacon timeout» warning makes the hub look 3 s later (and once more after 3 s)
  whether the driver still has the router: it drops it without an event when it shares the radio;
- the reconnect first tries the router it just had, starting from its channel (found in a fraction
  of a second when the router stayed, in one pass over the channels when it moved), then any
  router of the network; retries after 0.5, 1, 2, 4… up to 30 s;
- while Wi-Fi connects (and while the driver checks its router) the hub does not read the plug,
  and the plug's silence in that time does not count towards the alert delay: a reconnect is not
  a power cut;
- the watchdog (`main/watch.c`) stays behind all that.

The core keeps the `wifi` block in `hub_health`: a row for every change of its counters or channel
and at least every 10 minutes. «Мої будинки» shows the signal and says when it is weak (below
−75 dBm).

## Response

`200 {"ok": true, "ack": 17}` — `ack` is the `seq` the core processed (and maybe `ota`, see
Updates). `401`/`403` for a missing or
wrong signature (the hub keeps the events and retries later), `400` for a body it cannot read.

The core drops requests with a `seq` not greater than the last one of the same `boot`, and boots it
has already moved past (replays).

## What the core concludes

- `plug.mains` / `events` → the site's power, at the times the hub measured.
- The hub silent for 2 min → an admin alert only: on a UPS its silence means no internet (or a dead
  hub), not an outage.
- The hub back with a new `boot` and `rst` = `poweron`/`brownout` → the hub itself lost power (no
  UPS, or the UPS ran out): if the light was on, it went off around the hub's last request
  (approximate), and came back when the plug first answered after the boot.
- Other reset reasons (`sw`, `panic`, `wdt`, …) are the hub restarting itself: nothing about the
  mains.

## Updates

Firmware with `ota` in its reports can be updated over the air. CI publishes the GitHub release
`hub-v<version>` (`firmware/hub/version.txt`); the core mirrors it (only an ESP32-C6
`svitlo4u_hub` image whose embedded version is the tag's and whose bytes match the release
digest) into its cache and the R2 bucket. When a hub should take a version (sites.yaml
`firmware`: `latest` upgrades only, a pinned version also downgrades, `off`) and the moment is
safe — the light is on, no events wait, the hub is not busy with another update — the reply says:

```json
{
  "ok": true,
  "ack": 17,
  "ota": {
    "version": "0.2.1",
    "url": "https://….r2.cloudflarestorage.com/…/svitlo4u_hub-0.2.1.bin?X-Amz-…",
    "size": 1486880,
    "sha256": "4924c5c0…",
    "sig": "9b1d…"
  }
}
```

`sig` is the lowercase hex HMAC-SHA256 with the hub's secret of these lines joined by `\n`:
`ota`, `dev`, `boot` and `seq` of the report it answers, `version`, `size`, `sha256`.

`url` is a presigned R2 link valid for 15 minutes, or a path (`/iot/hub/firmware/hub-0.2.1.bin`)
on the report server when the core has no R2. The signature binds the offer to this hub and to the
report it answers, so it cannot be replayed or forged without the secret; the hash then covers the
bytes wherever they come from.

The hub:

1. checks the signature; skips the version it runs, the one it rejected, and one that failed less
   than 10 minutes ago;
2. downloads into the other app slot while it keeps working, checks the size, SHA-256, the image
   and its project/version;
3. restarts into it once nothing is waiting to be sent, the light is on and no pairing is open
   (`rst` = `sw`, so the core concludes nothing about the mains);
4. keeps the new image after its first acknowledged report with Zigbee up. A crash before that
   makes the bootloader go back; no such report within 10 minutes makes the hub go back itself.
   The old image then reports the new version as `ota.rejected` and never takes it again.

The core tells the admin chat when a hub comes back on another version and when one was rejected.

## Provisioning

Each hub has an id and a secret given when it is flashed (USB console: `provision <id> <secret>`,
see `firmware/hub/README.md`), stored in its NVS and on the server:

- a hub of a site in `config/sites.yaml`: in `deploy/.env` under the `secretEnv` of the device;
- a hub for someone else's building: in the database. `cli/hub.ts new` (run by
  `firmware/hub/tools/factory.py`) creates it with no building and no owner, and gives the
  sticker's link `t.me/<bot>?start=own-<hub id>-<code>`. The code is the first 10 base32
  characters of the HMAC-SHA256 of the text `svitlo4u-claim` keyed with the hub's secret: only the
  sticker (or the secret) gives it.

The first scan of the sticker makes the person the hub's owner. A hub without a building asks for
its address (YASNO's search gives the queue) and a name and creates it (`b-` + 10 random characters, its page only by link);
its reports drive the building from then on. Until then the core answers the hub's reports (and
may update it) but they drive nothing. The owner gets the hub's service news (silent, back,
updated, rolled back) in their private chat, as the admin does, and «Мої будинки» in the Mini App;
releasing the hub there lets the next scan take it, with the building and its history.

Wi-Fi and the plug are set by the user on the hub's own setup page. One radio cannot serve an
access point and a Zigbee network at once, so the hub has two modes and restarts to switch:

- **setup** — with no Wi-Fi saved, or after holding BOOT for 5 s: the open access point
  `Svitlo4U-XXXX` with the page (a captive portal), no Zigbee. The user picks the home network and
  enters its password; the hub checks it.
- **normal** — home Wi-Fi, Zigbee and reports, no access point. «Під'єднати розетку» on the page
  restarts into it with pairing open for 180 s (also a short BOOT press); the device that joins
  becomes the plug.
