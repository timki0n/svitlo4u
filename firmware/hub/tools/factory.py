"""A new hub at the bench, in one go:

1. the server creates the hub (id, secret, the sticker's link) — `cli/hub.ts new` over ssh;
2. the hub gets its identity over the USB console (`provision <id> <secret>`, `server default`);
3. a sticker to print: the hub's id and the QR its owner scans to claim it in Telegram.

The secret only passes from the server's answer to the hub's console: it is never printed or saved.

    python firmware/hub/tools/factory.py --port COM6 --ssh svitlo
    python firmware/hub/tools/factory.py --port COM6 --ssh svitlo --hub hub-fa2a4c   # reprint, no new hub

Needs pyserial (the ESP-IDF Python environment has it). Flash the firmware first (README → Flash).
"""

import argparse
import html
import json
import subprocess
import sys
import time

CLI = "node apps/core/src/cli/hub.ts"


def server(args: argparse.Namespace, command: str) -> dict:
    """Run the hub CLI inside the core's container on the server; its JSON answer."""
    remote = f"docker exec -i {args.container} {CLI} {command} --bot {args.bot}"
    out = subprocess.run(["ssh", args.ssh, remote], capture_output=True, text=True, check=False)
    if out.returncode != 0:
        sys.exit(f"server: {out.stderr.strip() or out.returncode}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def console(port: str, lines: list[str], wait: float = 1.5) -> str:
    """Send lines to the hub's USB console (DTR/RTS low: no reset); what it answered."""
    import serial

    s = serial.Serial()
    s.port, s.baudrate, s.timeout, s.write_timeout = port, 115200, 0.1, 2
    s.dtr = s.rts = False
    s.open()
    time.sleep(0.3)
    s.reset_input_buffer()
    out = bytearray()
    for line in lines:
        s.write((line + "\n").encode())
        end = time.time() + wait
        while time.time() < end:
            out += s.read(4096)
    s.close()
    return out.decode("utf-8", "replace")


STICKER = """<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>{id}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
  @page {{ size: 60mm 40mm; margin: 0 }}
  body {{ margin: 0; font: 9pt/1.25 system-ui, sans-serif; color: #000 }}
  .s {{ width: 60mm; height: 40mm; box-sizing: border-box; padding: 3mm; display: flex; gap: 3mm }}
  #qr {{ width: 26mm; height: 26mm; flex: none }} #qr img, #qr canvas {{ width: 100%; height: auto }}
  b {{ font-size: 10pt }} small {{ color: #333 }}
</style></head>
<body><div class="s"><div id="qr"></div><div>
  <b>Світло4U · хаб</b><br><small>{id}</small><br><br>
  1. Увімкніть біля роутера, на ДБЖ.<br>
  2. Wi-Fi «Svitlo4U-…» → налаштування.<br>
  3. Скануйте QR — сповіщення в Telegram.
</div></div>
<script>new QRCode(document.getElementById("qr"), {{ text: {link}, width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M }});</script>
</body></html>
"""


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", required=True, help="the hub's USB console, e.g. COM6")
    p.add_argument("--ssh", required=True, help="ssh host of the server")
    p.add_argument("--container", default="svitlo4u-core-1")
    p.add_argument("--bot", default="svitlo_4u_bot", help="the bot's @username (without @)")
    p.add_argument("--hub", help="an existing hub: print its sticker again, no new hub")
    p.add_argument("--out", help="sticker file (default: <hub id>.html)")
    args = p.parse_args()

    if args.hub:
        hub = server(args, f"link {args.hub}")
    else:
        hub = server(args, "new")
        answer = console(args.port, [f"provision {hub['id']} {hub['secret']}", "server default", "status"])
        del hub["secret"]
        if "identity saved" not in answer:
            sys.exit(f"{hub['id']} was created, but the hub did not confirm its identity: check the port")
        print(f"{hub['id']}: identity and server set")
    out = args.out or f"{hub['id']}.html"
    with open(out, "w", encoding="utf-8") as f:
        f.write(STICKER.format(id=html.escape(hub["id"]), link=json.dumps(hub["link"])))
    print(f"sticker: {out} (open it and print, 60×40 mm)")


if __name__ == "__main__":
    main()
