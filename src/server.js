'use strict';

const Fastify = require('fastify');
const fs = require('node:fs');
const path = require('node:path');
const { ha, haBinary } = require('./ha');
const { entityMap, sceneColor, lightsSummary, vacuumSummary, vacuumBase, parsePhotoList, mediaSummary, energySummary, weatherSummary } = require('./summaries');
const mock = require('./mock');

const app = Fastify({ logger: true });
const demo = process.env.DEMO_MODE === 'true';
const port = Number(process.env.PORT || 3080);
const list = (value) => (value || '').split(',').map((s) => s.trim()).filter(Boolean);
const config = {
  scenes: list(process.env.SCENE_ENTITY_IDS), // empty = every scene in HA
  mediaPlayers: list(process.env.MEDIA_PLAYER_ENTITY_IDS), // empty = every media player in HA
  vacuum: (process.env.VACUUM_ENTITY_ID || '').trim() || (demo ? 'vacuum.ottoto' : ''),
  battery: (process.env.VACUUM_BATTERY_ENTITY_ID || '').trim(),
  prices: (process.env.PRICE_ENTITY_ID || 'sensor.energi_data_service').trim(),
  weather: (process.env.WEATHER_ENTITY_ID || 'weather.home').trim(),
  // "Name:minutes,Name:minutes": appliances to find the cheapest start time for.
  appliances: list(process.env.APPLIANCES || 'Washing machine:120,Dishwasher:180')
    .map((item) => {
      const i = item.lastIndexOf(':');
      return { name: item.slice(0, i).trim(), minutes: Number(item.slice(i + 1)) };
    })
    .filter((item) => item.name && item.minutes > 0)
};
const demoStates = demo ? mock.createStates(config.vacuum) : null;

async function loadStates() {
  return entityMap(demo ? demoStates : await ha('/api/states'));
}

// Scene states don't include colours; each UI-made scene's config does. Scenes rarely change: cache.
const SCENE_COLOR_TTL_MS = 10 * 60000;
let sceneColorCache = { at: 0, colors: {} };

async function loadSceneColors(map, log) {
  if (demo) return mock.sceneColors();
  if (Date.now() - sceneColorCache.at < SCENE_COLOR_TTL_MS) return sceneColorCache.colors;
  const colors = {};
  const scenes = Object.keys(map).filter((id) => id.startsWith('scene.') && map[id].attributes && map[id].attributes.id);
  await Promise.all(scenes.map(async (id) => {
    try {
      colors[id] = sceneColor(await ha('/api/config/scene/config/' + encodeURIComponent(map[id].attributes.id)));
    } catch (error) {
      log.warn({ err: error }, 'Could not load scene config for ' + id); // the dot is just left out
    }
  }));
  sceneColorCache = { at: Date.now(), colors };
  return colors;
}

// The hourly forecast is not a state attribute in modern HA; it comes from a service call.
// Forecasts change slowly, so cache it instead of calling HA on every 8-second poll.
const FORECAST_TTL_MS = 15 * 60000;
let forecastCache = { at: 0, hours: [] };

async function loadForecast(log) {
  if (demo) return mock.forecast();
  if (Date.now() - forecastCache.at < FORECAST_TTL_MS) return forecastCache.hours;
  try {
    const result = await ha('/api/services/weather/get_forecasts?return_response', 'POST', { entity_id: config.weather, type: 'hourly' });
    const entry = result && result.service_response && result.service_response[config.weather];
    forecastCache = { at: Date.now(), hours: (entry && entry.forecast) || [] };
  } catch (error) {
    // Weather is a nice-to-have: show current conditions without a forecast, retry in a minute.
    log.warn({ err: error }, 'Could not load weather forecast');
    forecastCache = { at: Date.now() - FORECAST_TTL_MS + 60000, hours: forecastCache.hours };
  }
  return forecastCache.hours;
}

const publicDir = path.resolve(__dirname, '../public');
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};

app.addHook('onRequest', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

  // This is a LAN-only MVP with no login. Restrict write requests to our own UI.
  if (request.method === 'POST') {
    const origin = request.headers.origin;
    if (origin) {
      let originHost;
      try { originHost = new URL(origin).host; } catch (_) { originHost = ''; }
      if (originHost !== request.headers.host) {
        reply.code(403).send({ error: 'Cross-origin requests are blocked' });
        return reply;
      }
    }
    if (request.headers['x-night-city'] !== '1') {
      reply.code(403).send({ error: 'Missing required application header' });
      return reply;
    }
  }
});

Object.keys(files).forEach((url) => {
  app.get(url, async (request, reply) => {
    const [filename, mime] = files[url];
    return reply.type(mime).send(fs.createReadStream(path.join(publicDir, filename)));
  });
});

function haUnreachable(request, reply, error, what) {
  request.log.error({ err: error }, 'Home Assistant request failed: ' + what);
  return reply.code(502).send({ error: 'Cannot contact Home Assistant: ' + error.message });
}

app.get('/api/health', async () => ({ ok: true, mode: demo ? 'demo' : 'live' }));

app.get('/api/entities', async (request, reply) => {
  try {
    const map = await loadStates();
    return {
      entities: Object.keys(map).filter((id) => /^(light|scene|vacuum|sensor|media_player)\./.test(id))
        .map((id) => ({ id, name: map[id].attributes && map[id].attributes.friendly_name || id }))
    };
  } catch (error) {
    return haUnreachable(request, reply, error, 'entities');
  }
});

app.get('/api/state', async (request, reply) => {
  try {
    const map = await loadStates();
    const forecast = map[config.weather] ? await loadForecast(request.log) : [];
    return {
      mode: demo ? 'demo' : 'live',
      weather: weatherSummary(map, config.weather, forecast, Date.now()),
      lights: lightsSummary(map, config.scenes, await loadSceneColors(map, request.log)),
      vacuum: config.vacuum ? vacuumSummary(map, config.vacuum, config.battery) : null,
      media: mediaSummary(map, config.mediaPlayers),
      energy: energySummary(map, config.prices, config.appliances, Date.now())
    };
  } catch (error) {
    return haUnreachable(request, reply, error, 'state');
  }
});

// ---- Vacuum obstacle photos (latest run only; that is all the integration serves) ----

let photoCache = { key: null, photos: [] };

app.get('/api/vacuum/photos', async (request, reply) => {
  if (demo || !config.vacuum) return { version: null, photos: [] };
  const base = vacuumBase(config.vacuum);
  try {
    // The history sensor's state is the latest run's time: only re-read the photo list when it changes.
    const history = await ha('/api/states/sensor.' + base + '_cleaning_history');
    if (photoCache.key !== history.state) {
      const data = await haBinary('/api/camera_history_map_proxy/camera.' + base + '_map?index=1&data=1');
      photoCache = { key: history.state, photos: parsePhotoList(data.body) };
    }
    return { version: photoCache.key, photos: photoCache.photos };
  } catch (error) {
    return haUnreachable(request, reply, error, 'vacuum photo list');
  }
});

app.get('/api/vacuum/photos/:index', {
  schema: { params: { type: 'object', properties: { index: { type: 'integer', minimum: 1, maximum: 999 } } } }
}, async (request, reply) => {
  const index = request.params.index;
  if (demo || !config.vacuum || !photoCache.photos.some((p) => p.index === index)) {
    return reply.code(404).send({ error: 'Photo not found' });
  }
  try {
    const image = await haBinary('/api/camera_map_obstacle_history_proxy/camera.' + vacuumBase(config.vacuum) + '_map?history_index=1&index=' + index);
    return reply.header('Cache-Control', 'private, max-age=86400').type(image.contentType).send(image.body);
  } catch (error) {
    return haUnreachable(request, reply, error, 'vacuum photo');
  }
});

// ---- Media artwork (proxied so the browser never sees HA URLs or tokens) ----

app.get('/api/media/artwork', {
  schema: { querystring: { type: 'object', required: ['entity'], properties: { entity: { type: 'string', pattern: '^media_player\\.[a-z0-9_]+$' } } } }
}, async (request, reply) => {
  const id = request.query.entity;
  if (demo || (config.mediaPlayers.length && config.mediaPlayers.indexOf(id) < 0)) {
    return reply.code(404).send({ error: 'No artwork' });
  }
  try {
    const player = await ha('/api/states/' + id);
    const picture = player && player.attributes && player.attributes.entity_picture;
    // Only follow HA-relative paths, never arbitrary URLs.
    if (typeof picture !== 'string' || picture.charAt(0) !== '/' || picture.charAt(1) === '/') {
      return reply.code(404).send({ error: 'No artwork' });
    }
    const image = await haBinary(picture);
    return reply.header('Cache-Control', 'private, max-age=3600').type(image.contentType).send(image.body);
  } catch (error) {
    return haUnreachable(request, reply, error, 'media artwork');
  }
});

// ---- Actions: a fixed list, mapped to HA service calls on the server ----

app.post('/api/action', {
  schema: {
    body: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['scene.activate', 'lights.off'] },
        scene: { type: 'string', pattern: '^scene\\.[a-z0-9_]+$' }
      }
    }
  }
}, async (request, reply) => {
  const { action, scene } = request.body;
  try {
    const lights = lightsSummary(await loadStates(), config.scenes);
    let call;
    if (action === 'scene.activate') {
      // Only scenes the dashboard shows may be activated.
      if (!scene || !lights.scenes.some((s) => s.id === scene)) {
        return reply.code(400).send({ error: 'Unknown scene: ' + (scene || '(none)') });
      }
      call = ['scene', 'turn_on', { entity_id: scene }];
    } else {
      const ids = lights.lights.filter((l) => l.available).map((l) => l.id);
      if (!ids.length) return reply.code(409).send({ error: 'No reachable lights to turn off' });
      call = ['light', 'turn_off', { entity_id: ids }];
    }

    if (demo) mock.applyAction(demoStates, call);
    else await ha('/api/services/' + call[0] + '/' + call[1], 'POST', call[2]);
    return { ok: true };
  } catch (error) {
    request.log.error({ err: error }, 'Home Assistant service call failed');
    return reply.code(502).send({ error: 'Home Assistant could not complete the action: ' + error.message });
  }
});

if (!demo) {
  const missing = ['HA_URL', 'HA_TOKEN'].filter((name) => !(process.env[name] || '').trim());
  if (missing.length) {
    console.error('Missing ' + missing.join(', ') + '. Set in the environment (or .env), or set DEMO_MODE=true.');
    process.exit(1);
  }
}

app.listen({ port, host: '0.0.0.0' }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
