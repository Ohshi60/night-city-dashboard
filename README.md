# Night City — local Home Assistant dashboard MVP

Lightweight Fastify backend + ES5 frontend intended for Safari on a **first-generation iPad mini**. No React, browser bundles, cloud services, external fonts, or Bluetooth hardware required.

## What works

- Office lighting as a scene picker: every Home Assistant scene (or the ones in `SCENE_ENTITY_IDS`), the lights those scenes control with their on/off/offline state, and an "all lights off" button
- Dreame vacuum status (read-only): state, battery, plain-language "needs attention" items, base-station parts, the last run (finished or not, skipped rooms and why, rooms that keep getting skipped), consumable wear, and pet photos from the last run
- Now playing (a slim bar, only shown while something is on): the most active media player. Plex and Jellyfin integrations provide title, poster and progress; Android TV Remote only provides the open app (e.g. "Prime Video")
- Weather (a chip in the header; tap for the forecast): current temperature, conditions and wind (m/s), rain in the next 12 hours in plain words, the temperature range, the next sunrise or sunset, and the next six hours. Uses `WEATHER_ENTITY_ID` (default `weather.home`, met.no) and `sun.sun`
- Electricity prices: the current price per kWh (incl. tariffs and VAT), a bar chart of the coming hours, and the cheapest time to start each appliance in `APPLIANCES`. Needs the [Energi Data Service](https://github.com/MTrab/energidataservice) custom integration in Home Assistant (installed manually into `/config/custom_components/energidataservice/`); the card stays hidden without it
- Offline demo mode to verify layout on an older browser
- Server-side Home Assistant token, never returned to the browser
- Docker deployment on a Linux VM/LXC **inside Proxmox** (do not install Docker directly on the Proxmox hypervisor)

No auth in MVP: **LAN-only**, never port-forward `3080` or expose it through a public tunnel. The old iPad runs unsupported software and should be used on a trusted/isolated network.

## Quick start

```sh
cp .env.example .env
# Start in demo mode — no Home Assistant token needed
sudo docker compose up -d --build
```

Open `http://<IP_OF_YOUR_DOCKER_VM>:3080` from your MacBook or iPad. Test the on/off, scene, and vacuum buttons; they alter only mock state in demo mode.

To connect real devices:

1. In Home Assistant, click your user profile (bottom-left) → **Security** → **Long-lived access tokens** → **Create token**. Name it `Night City Dashboard`. Copy the token once; don't paste it in chat.
2. Edit `.env` (or the deployment's environment variables, e.g. in Coolify): set `DEMO_MODE=false`, `HA_TOKEN=...`, and `HA_URL` to Home Assistant's base URL **including the port** (e.g. `http://10.0.0.169` if HA serves on port 80, or `http://<ip>:8123` for the HAOS default). Both are required in live mode; the server exits at startup if either is missing.
3. Find *exact* entity IDs: Home Assistant **Developer tools → States**, or use `http://<DOCKER_VM_IP>:3080/api/entities` after setting the token (read-only list of relevant entities).
4. Set `VACUUM_ENTITY_ID` in `.env`, and optionally `VACUUM_BATTERY_ENTITY_ID` if battery is published as a separate sensor. Scenes and media players are discovered automatically; set `SCENE_ENTITY_IDS` or `MEDIA_PLAYER_ENTITY_IDS` (comma-separated) only to limit which ones are shown. Lights are taken from the scenes.
5. Restart with `sudo docker compose up -d --force-recreate` (rebuild only after code changes).
6. Open `http://<DOCKER_VM_IP>:3080` again. Badge must read `LIVE SYSTEM`, not `DEMO MODE`. Verify status before issuing commands.

Entity IDs are not guaranteed to match friendly device names. For example, the Zigbee2MQTT bulb `Kontoret_main` appears in Home Assistant as `light.0x8c65a3fffedf71b8` (its Zigbee address), not `light.kontoret_main`.

## Troubleshooting

```sh
sudo docker compose logs -f night-city
curl http://localhost:3080/api/health
curl http://localhost:3080/api/entities
```

- `403`: browser request not from this dashboard or missing custom header.
- `401` from Home Assistant: bad/expired access token.
- Light shows `OFFLINE` or the vacuum card is missing data: wrong entity ID or the device is unavailable in HA.
- No pet photos: the last run had no pet detections, or the Dreame integration couldn't fetch the photos (they come from Dreame's cloud via HA).
- iPad can't connect: ensure its Wi-Fi network can reach the Docker VM's IP and port 3080. With two routers, outbound routing/firewall may prevent this.
- iPad renders badly: ensure it's updated to iOS 9.3.x; disable any content blockers. The UI is designed to avoid modern JS features but actual legacy Safari needs hardware verification.

## Notes

- The frontend polls every 8 seconds rather than maintaining a browser WebSocket, to reduce compatibility issues.
- Home Assistant integration calls go through Fastify on the server. The browser doesn't receive HA credentials.
- No arbitrary HA service calls are exposed. Only a small list of permitted actions is mapped by the server.
- Commands are submitted over HTTP on LAN. No login exists in MVP. Use a separate HA account for the dashboard token if you want to manage permissions separately, though Home Assistant service access should still be considered powerful.
- The overview is sized to fit one first-gen iPad mini screen in landscape (about 1024×690 in Safari). Tapping a card opens its details in a panel that closes itself after a minute.
- From sunset to sunrise the page switches to a dim, warm night mode. Add `?theme=day` or `?theme=night` to the URL to force one.
