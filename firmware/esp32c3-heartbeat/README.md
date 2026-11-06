# ESP32-C3 SuperMini heartbeat

Signed UDP v2 heartbeat for the power detector (protocol: [docs/esp-protocol.md](../../docs/esp-protocol.md)).
Replaces the legacy `{"ping": N}` sketch: 1 s interval, 64-bit uptime, non-blocking Wi-Fi reconnect,
reset reason in every packet.

Compatible with the legacy bot too: it only looks at packet timing, not content, so flashing this
before the switch-over changes nothing for it.

## Configure

```bash
cp secrets.example.h secrets.h   # git-ignored
```

Fill Wi-Fi, `DEVICE_ID` (as in `config/sites.yaml`) and `DEVICE_SECRET` — the same value as the
device's `secretEnv` variable in `deploy/.env` on the server.

## Flash

Arduino IDE 2: open `esp32c3-heartbeat.ino`, board **ESP32C3 Dev Module**, **USB CDC On Boot: Enabled**,
pick the COM port, Upload. Or with arduino-cli:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc firmware/esp32c3-heartbeat
arduino-cli upload -p COM5 --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc firmware/esp32c3-heartbeat
```

If the port does not show up or the upload fails: hold **BOOT**, tap **RESET**, release BOOT, upload again.

Serial monitor (115200) prints the device id, boot id, reset reason and the Wi-Fi IP. The blue LED
blinks once per sent heartbeat.

## Avoiding a false alarm while flashing

While the ESP is off its charger, the server sees silence and the legacy bot would announce an outage
after 20 s. Flash while the mains is **on**, and keep the legacy bot fed for those minutes from the
server itself:

```bash
# on the server, stop with Ctrl+C right after the new firmware is sending
while true; do printf '{"ping":0}' > /dev/udp/127.0.0.1/5005; sleep 1; done
```
