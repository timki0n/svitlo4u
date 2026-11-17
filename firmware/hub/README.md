# svitlo4u hub

ESP32-C6 (SuperMini, 4 MB flash) with its own Zigbee network and one mains-powered smart plug: it
tells the core when the light goes and comes back. Meant to sit on the router's UPS. Protocol and
the reasoning behind it: [docs/hub-protocol.md](../../docs/hub-protocol.md).

## Build

ESP-IDF **v5.5.6** (the version esp-zigbee-sdk recommends), target `esp32c6`:

```bash
idf.py set-target esp32c6
idf.py build
```

Components (`espressif/esp-zigbee-lib` 2.x, `espressif/led_strip`) come from the component
registry on the first build; `dependencies.lock` pins them.

The version is `version.txt` (it goes into the image and the reports).

## Flash

The first flash writes everything (the bootloader with rollback, the partition table, the update
slot selector, the app); later the hub updates itself over the air.

Over USB from download mode (hold BOOT while plugging in): `idf.py -p COM6 flash`. After that the
board stays in download mode until it is replugged.

Over the chip's built-in JTAG (same cable, no buttons, no replug):

```bash
openocd -f board/esp32c6-builtin.cfg -c "init; reset halt; program_esp build/bootloader/bootloader.bin 0x0 verify; program_esp build/partition_table/partition-table.bin 0x8000 verify; program_esp build/ota_data_initial.bin 0x19000 verify; program_esp build/svitlo4u_hub.bin 0x20000 verify; reset run; shutdown"
```

Writing `ota_data_initial.bin` matters after an update: the hub may run from the second slot,
and without it a fresh app in the first one would not boot. Settings in NVS (identity, Wi-Fi, the
plug) survive both. A JTAG reset does not fully reset the radio: power-cycle the board (or `reboot`
in the console) before testing Wi-Fi.

## Release

Bump `version.txt` and push to `main`: CI builds the image and publishes the GitHub release
`hub-v<version>` (`svitlo4u_hub.bin` + its SHA-256). The core picks it up within 30 minutes and
offers it to the hubs (docs/hub-protocol.md → Updates). A push without a new version only builds.

## Provision

Each hub needs an id and a secret that the server knows. A hub for someone else's building comes
from the bench script: the server creates it, the hub gets its identity over USB and a sticker
with the owner's QR is written (deploy/README.md → Hubs for other buildings):

```bash
python tools/factory.py --port COM6 --ssh <server>
```

A hub of a site in `config/sites.yaml` (`kind: hub`, its secret in `deploy/.env`) is provisioned by
hand in the USB console (115200, any terminal; one command per line):

```text
provision hub-xxxxxx <secret>
status
```

Other commands: `server <url|default>` (report URL, default `https://svitlo4u.info/iot/hub`),
`wifi <ssid> <password>`, `wifi-forget`, `portal`, `pair`, `plug-forget`, `reboot`, and
`test loop-stuck|wifi-lost|kick-stuck` to break the hub the way the watchdog must fix.

## Use

- **First start** (no Wi-Fi saved): the hub opens the Wi-Fi network `Svitlo4U-XXXX`; the phone
  shows the setup page. Pick the home 2.4 GHz network, enter its password, then «Під'єднати
  розетку»: the hub restarts and looks for the plug for 3 minutes — hold the plug's button for
  5 s until its light blinks fast.
- **BOOT button**: a short press opens pairing for 180 s, holding it 5 s restarts into the setup
  page.
- **Updates**: on their own when the light is on; `status` in the console shows the slot, the
  state and a version that was rolled back.
- **Watchdog** (`main/watch.c`): the Wi-Fi driver lost the router without telling the firmware
  (it happens when the router changes its channel) → the hub reconnects within ~15 s; no answer
  from the server for 3 minutes while Wi-Fi looks connected → it reconnects too (again after 3, 6,
  12… up to 30 minutes); a stuck event loop, a stuck driver, a reconnect that hangs or Wi-Fi that
  goes quiet → it restarts. `status` shows the reconnects and why it last restarted itself.
- **Router**: a fixed 2.4 GHz channel (1, 6 or 11) instead of «auto» spares the hub those drops.
- **LED**: blue blinking — setup page; cyan blinking — looking for the plug; purple — no key or no
  plug; yellow — no Wi-Fi or no answer from the server; green — light on; red — light off.
