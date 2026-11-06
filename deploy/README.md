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

### MQTT users

```bash
touch mosquitto/config/passwd
docker compose run --rm mosquitto mosquitto_passwd -b /mosquitto/config/passwd zigbee2mqtt '<password>'
docker compose run --rm mosquitto mosquitto_passwd -b /mosquitto/config/passwd core '<password>'
```

### zigbee2mqtt

```bash
cp zigbee2mqtt/configuration.example.yaml zigbee2mqtt/configuration.yaml
cp zigbee2mqtt/secret.example.yaml zigbee2mqtt/secret.yaml   # same password as above
```

Pairing UI: `ssh -L 8099:127.0.0.1:8099 svitlo`, then open http://localhost:8099.

### Cloudflare Tunnel

Cloudflare dashboard → Zero Trust → Networks → Tunnels → **Create tunnel** (Cloudflared) → name `svitlo4u`
→ copy the token into `deploy/.env` → add public hostname `svitlo4u.info` → service `http://core:8080`.
Add a Cache Rule that bypasses cache for `/api/*`, `/iot/*`, `/tg/*`.

The `cloudflared` image is pinned and Dependabot bumps it daily, so merging its PR keeps the tunnel on the latest release.

## Run / update

```bash
docker login ghcr.io            # only while the package is private
docker compose pull && docker compose up -d
docker compose ps
curl -s http://127.0.0.1:8090/health
```

Rollback: set `CORE_TAG=<previous commit sha>` in `.env` and `docker compose up -d`.
