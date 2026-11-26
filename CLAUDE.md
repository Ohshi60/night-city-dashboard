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

There is no test suite, linter, or build step. To verify changes, run with `DEMO_MODE=true` (no HA token needed) and exercise `/api/health`, `/api/state`, and `POST /api/action` (needs the `X-Night-City: 1` header).

Deployment: `docker compose up -d --build` (read-only container, port 3080). It is meant for a Linux VM/LXC inside Proxmox, not the Proxmox host itself.

## Architecture

- **`src/ha.js`**: a thin `fetch` wrapper around the Home Assistant REST API (Bearer token, 8s timeout). The HA token lives only on the server and must never reach the browser.
- **`src/server.js`** contains everything else:
  - The static files are served from an explicit whitelist (`files` map), not a static-file plugin. Adding a frontend file means adding it there.
  - An `onRequest` hook sets security headers (strict CSP: `default-src 'self'`, so no inline scripts or styles and no external resources). It blocks any POST that is cross-origin or lacks the `x-night-city: 1` header. That is the only CSRF protection; there is no auth.
  - `GET /api/state` fetches all HA states once and reduces them to `light`/`scene`/`vacuum` summaries. A summary marks a missing or unavailable entity as `available: false` rather than erroring.
  - `POST /api/action` accepts only the names in the `actions` map (`'action.name': [domain, service, entityKind]`), enforced by the JSON schema enum. Never expose arbitrary HA service calls. A new control needs an entry in `actions`, demo-mode handling of the `mock` object, and an entity env var in `entities`.
  - **Demo mode** (`DEMO_MODE=true`): every endpoint short-circuits to the in-memory `mock` object, so the UI works with no HA connection. Keep demo and live paths in sync when changing response shapes.
  - `GET /api/entities` lists light/scene/vacuum/sensor entities to help users find the IDs for `.env`.
- **`public/app.js`**: must stay **ES5** (no `let`/`const`, arrow functions, `fetch`, promises, template literals, or classes). It uses `XMLHttpRequest`, polls `/api/state` every 8s (deliberately not WebSockets), and enables or disables controls from each entity's `available` flag.

## Configuration

All config is env vars (see `.env.example`): `DEMO_MODE`, `PORT`, `HA_URL`, `HA_TOKEN`, `LIGHT_ENTITY_ID`, `SCENE_ENTITY_ID`, `VACUUM_ENTITY_ID`, and the optional `VACUUM_BATTERY_ENTITY_ID`. The server exits at startup if it is not in demo mode and `HA_TOKEN` is unset.
