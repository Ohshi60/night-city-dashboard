# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A LAN-only Home Assistant dashboard: a single-file Fastify backend (`src/server.js`) serving a static ES5 frontend (`public/`) built for Safari on a first-generation iPad mini (iOS 9.3). It controls one light, one scene, and one Dreame vacuum.

## Commands

```sh
npm install
npm run dev      # node --env-file=.env src/server.js (Node >= 22); copy .env.example to .env first
npm start        # no .env loading; env must come from the environment (as in Docker)
npm run check    # syntax check only (node --check on server, ha client, and frontend)
```

There is no test suite, linter, or build step. To verify changes, run with `DEMO_MODE=true` (no HA token needed) and exercise `/api/health`, `/api/state`, and `POST /api/action` (needs the `X-Night-City: 1` header). Demo mode has no vacuum photos or artwork; checking those needs a live HA.

Deployment: production runs on Coolify (Dockerfile build pack, from `main`). Coolify does **not** deploy automatically on push, so trigger a deploy after merging. `docker compose up -d --build` also works for a plain Docker host.

## Architecture

- **`src/ha.js`**: `fetch` wrappers around the Home Assistant API: `ha()` for JSON, `haBinary()` for images and gzipped map data. The HA token lives only on the server and must never reach the browser. Images (vacuum photos, media artwork) are proxied through the server for the same reason.
- **`src/summaries.js`**: pure functions that turn HA states into card data (`lightsSummary`, `vacuumSummary`, `mediaSummary`, `energySummary`, `weatherSummary`, `parsePhotoList`). A missing or unavailable entity becomes `available: false`, not an error, and the frontend hides that card.
  - Electricity prices come from the Energi Data Service integration's `raw_today`/`raw_tomorrow` attributes, already including tariffs and VAT. "Cheap" and "expensive" are the bottom and top third of the remaining prices. The best start for each appliance is the lowest-average window of the remaining slots. Slot length is derived from the data, so 15-minute prices also work.
  - The weather forecast is not a state attribute in modern HA. `server.js` gets it from the `weather.get_forecasts` service (`?return_response`) and caches it for 15 minutes, so the 8-second poll doesn't call HA every time. If the forecast fails, the card still shows current conditions.
  - Lights come from the `entity_id` lists of the shown scenes. HA has no "active scene", so the most recently activated scene counts as active while any light is on.
  - The vacuum card relies on the Dreame integration's naming: `vacuum.<name>` implies `sensor.<name>_*`, `binary_sensor.<name>_maintenance`, `select.<name>_room_<id>_name` and `camera.<name>_map`.
  - The last run's details live in the attributes of `sensor.<name>_cleaning_history`, not in the problem/error entities.
  - Pet photos use the integration's `camera_history_map_proxy` (with `data=1`) and `camera_map_obstacle_history_proxy` endpoints, which no entity links to. Only the latest run is served, and only pets (type code 158) are shown.
- **`src/mock.js`**: fake HA states for demo mode, plus `applyAction`, which applies the same `[domain, service, data]` calls that live mode sends to HA. The server runs the same summaries over mock and live states, so the response shapes can't drift apart.
- **`src/server.js`**: routes and security.
  - Static files are served from an explicit whitelist (`files` map), not a static-file plugin.
  - An `onRequest` hook sets a strict CSP (`default-src 'self'`). This also blocks inline `style="…"` attributes in the HTML, so hide elements with the `is-hidden` CSS class, never with inline styles. It also blocks POSTs that are cross-origin or lack the `x-night-city: 1` header; that is the only CSRF protection, and there is no auth.
  - `POST /api/action` accepts only `scene.activate` (scene must be one the dashboard shows) and `lights.off`. Never expose arbitrary HA service calls, or vacuum controls (the user removed them on purpose).
- **`public/app.js`**: must stay **ES5** (no `let`/`const`, arrow functions, `fetch`, promises, template literals, or classes); `npm run check` greps for these. It uses `XMLHttpRequest` and polls `/api/state` every 8s (deliberately not WebSockets). It only rebuilds a card's DOM when that card's data changed, so taps aren't lost on the old iPad.

## Configuration

All config is env vars (see `.env.example`): `DEMO_MODE`, `PORT`, `HA_URL`, `HA_TOKEN`, `VACUUM_ENTITY_ID`, and the optional `VACUUM_BATTERY_ENTITY_ID`, `SCENE_ENTITY_IDS` and `MEDIA_PLAYER_ENTITY_IDS` (comma-separated; empty means every scene or media player in HA), `WEATHER_ENTITY_ID` (default `weather.home`), `PRICE_ENTITY_ID` (default `sensor.energi_data_service`) and `APPLIANCES` (`Name:minutes,…`, default `Washing machine:120,Dishwasher:180`). There is no hardcoded fallback for `HA_URL`: it includes the port (this install's HA serves on port 80, not the default 8123). Outside demo mode the server exits at startup if `HA_URL` or `HA_TOKEN` is unset. In production these are set as Coolify environment variables, not in a committed file.
