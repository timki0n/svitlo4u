# Deploy (Orange Pi 5B)

Stack: `core` + `cloudflared` + `mosquitto` + `zigbee2mqtt`, all in Docker Compose.
Images are arm64; `core` is built by CI and published to `ghcr.io/timki0n/svitlo4u-core`.

## One-time setup

```bash
sudo mkdir -p /opt/svitlo4u && sudo chown "$USER" /opt/svitlo4u
git clone https://github.com/timki0n/svitlo4u.git /opt/svitlo4u
cd /opt/svitlo4u/deploy
cp .env.example .env            # fill CLOUDFLARE_TUNNEL_TOKEN
```

### Zigbee dongle → `/dev/zigbee`

```bash
sudo cp udev/99-svitlo-zigbee.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger
ls -l /dev/zigbee
```

No sudo? Skip the rule and set `ZIGBEE_DEVICE=/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0`
in `.env` (fine while it is the only CH340 device plugged in).

### MQTT users

Passwords go to `.env` (`MQTT_CORE_PASSWORD`) and `zigbee2mqtt/secret.yaml` only. Feed them through
stdin — never as command arguments, they would be visible in `ps`:

```bash
touch mosquitto/config/passwd
printf '%s\n%s\n' "$Z2M_PW" "$Z2M_PW" | docker compose run --rm -T mosquitto mosquitto_passwd /mosquitto/config/passwd zigbee2mqtt
printf '%s\n%s\n' "$CORE_PW" "$CORE_PW" | docker compose run --rm -T mosquitto mosquitto_passwd /mosquitto/config/passwd core
```

For ad-hoc `mosquitto_pub/sub` inside the container, put `-u core` / `-P …` into
`/root/.config/mosquitto_pub` and `/root/.config/mosquitto_sub` (again via stdin).

### zigbee2mqtt

```bash
cp zigbee2mqtt/configuration.example.yaml zigbee2mqtt/configuration.yaml
cp zigbee2mqtt/secret.example.yaml zigbee2mqtt/secret.yaml   # same password as above
docker compose up -d mosquitto zigbee2mqtt
```

Pairing UI: `ssh -L 8099:127.0.0.1:8099 svitlo`, then open http://localhost:8099.

### Zigbee plug (power confirmation)

The detector expects a mains-powered plug named `4u-plug` (Zbeacon TS011F, any Tuya TS011F with
metering works):

```bash
# open pairing for 254 s, then hold the plug button 5–10 s until the LED blinks fast
mosquitto_pub -t zigbee2mqtt/bridge/request/permit_join -m '{"time":254}'
mosquitto_pub -t zigbee2mqtt/bridge/request/device/rename -m '{"from":"<ieee>","to":"4u-plug"}'
# after a power outage the relay always comes back ON
mosquitto_pub -t zigbee2mqtt/4u-plug/set -m '{"power_outage_memory":"on"}'
```

Notes from measuring the real plug: `get voltage` is not supported, so the core reads
`haElectricalMeasurement.rmsVoltage` (`{"read":{…}}` on `/set`) — answers in 0.2–0.5 s, sometimes
2.5–3 s. The plug ignores reporting settings and can stay silent for an hour, so the core reads it
every minute. zigbee2mqtt availability does not notice the plug disappearing — the core's reads do.

### Cloudflare Tunnel

Cloudflare dashboard → Zero Trust → Networks → Tunnels → **Create tunnel** (Cloudflared) → name `svitlo4u`
→ copy the token into `deploy/.env` → add public hostname `svitlo4u.info` → service `http://core:8080`.
Add a Cache Rule that bypasses cache for `/api/*`, `/iot/*`, `/telegram/*`. The web app at `/` is
served by the core itself (hashed `/assets/*` are immutable, `index.html` is revalidated), so the
default caching is fine for it.

The `cloudflared` image is pinned and Dependabot bumps it daily, so merging its PR keeps the tunnel on the latest release.

### Telegram

Each site with a `telegram` section in `config/sites.yaml` gets its own bot:

1. @BotFather → `/newbot` → put the token into `deploy/.env` under the name from `botTokenEnv`.
2. For silent topics (`silentChats`) the bot must see all messages and delete them:
   @BotFather → `/setprivacy` → Disable, and make the bot a group admin with "Delete messages".
3. With `PUBLIC_URL` set, the core registers the webhook itself on start
   (`/telegram/<site id>`, checked with a secret token derived from the bot token) and the command menu.
4. `shadow: true` (the default) sends every announcement only to `adminChatId`, marked and with the
   measured delay — run it next to the old bots, then set `shadow: false` to switch over.
5. A bot that an old app still uses (its webhook) gets `commands: false`: the core only sends.

Commands: `/start`, `/status`, `/today`, `/tomorrow`, `/sub` (personal notifications); in the admin
chat also `/health`, `/stats`, `/notify <HTML>` (announcement to all chats of the site) and
`/testscreenshot [завтра]` (the schedule picture, to check how it looks).

Schedule notices carry a picture of that day's schedule card. The `renderer` service (headless
Chromium) opens the core's own `#/render/<site>/<today|tomorrow>` page and the core sends the
screenshot with the text as its caption (a text over 1024 characters follows the picture). If the
picture cannot be made within 15 s the notice goes out as text. Without `RENDERER_CDP_URL`
pictures are off. To make one by hand:

```bash
docker compose exec core node apps/core/src/cli/render.ts 4u tomorrow /tmp/tomorrow.png
```

Undelivered messages are retried for 30 minutes (5 s → 3 min backoff) and survive restarts;
the admin chat hears about chats that reject messages, Yasno failures, zigbee2mqtt going offline,
rejected heartbeats and core restarts (with the downtime).

### Core: sites and history

```bash
mkdir -p config data            # data must belong to uid 1000 (the image runs as `node`)
cp ../config/sites.example.yaml config/sites.yaml   # edit: devices, telegram; secrets go to .env
```

Import the old bot's history once (a copy of its database; `--adopt-open` continues an outage that
is going on right now, so its start is not lost):

```bash
mkdir -p /tmp/legacy && cp /opt/svitlo/svitlo_web/data/svitlo.db* /tmp/legacy/
docker compose run --rm -v /tmp/legacy:/legacy core node packages/storage/src/cli/import-legacy.ts   --db /app/data/svitlo4u.db --site 4u --name "ЖК 4U" --group 12.1   --legacy /legacy/svitlo.db --format svitlo --adopt-open
```

UDP 5005 must be free: the old bot listens there.

### Backups (Cloudflare R2)

Every night at `BACKUP_TIME` (03:30 Kyiv) the core makes a consistent copy of the database
(`VACUUM INTO`), checks its integrity, gzips it and uploads it to
`<prefix>daily/svitlo4u-YYYY-MM-DD.db.gz`; on the 1st of a month also to
`<prefix>monthly/svitlo4u-YYYY-MM.db.gz`. A failed run is retried every 30 minutes; after three
failures in a row the admin chat gets an alert. `/health` shows the last backup.

1. Cloudflare dashboard → R2 Object Storage → **Create bucket**, e.g. `svitlo4u-backups`
   (location: Automatic, storage class: Standard).
2. Bucket → Settings → **Object lifecycle rules** → add:
   - prefix `svitlo4u/daily/` → delete objects 30 days after upload;
   - prefix `svitlo4u/monthly/` → delete after 365 days (or keep).
3. R2 → **Manage API tokens** → Create **Account API token** → permission _Object Read & Write_,
   _Apply to specific buckets only_ → the backup bucket. Copy the Access Key ID, the Secret Access
   Key and the S3 endpoint `https://<account id>.r2.cloudflarestorage.com` (shown once).
4. Put them into `.env` (`BACKUP_S3_*`, `BACKUP_PREFIX=svitlo4u/`), then `docker compose up -d core`.
5. Check right away: `docker compose exec core node apps/core/src/cli/backup.ts`.

Restore: download an object, `gunzip` it, stop `core`, replace `data/svitlo4u.db` (remove
`svitlo4u.db-wal` / `-shm`), start `core`.

## Run / update

```bash
docker compose pull && docker compose up -d
docker compose ps
curl -s http://127.0.0.1:8090/health
```

Rollback: set `CORE_TAG=sha-<previous commit sha>` in `.env` and `docker compose up -d`.
