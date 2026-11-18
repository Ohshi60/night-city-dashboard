'use strict';

const Fastify = require('fastify');
const fs = require('node:fs');
const path = require('node:path');
const { ha } = require('./ha');

const app = Fastify({ logger: true });
const demo = process.env.DEMO_MODE === 'true';
const port = Number(process.env.PORT || 3080);
const entities = {
  light: (process.env.LIGHT_ENTITY_ID || '').trim(),
  scene: (process.env.SCENE_ENTITY_ID || '').trim(),
  vacuum: (process.env.VACUUM_ENTITY_ID || '').trim(),
  battery: (process.env.VACUUM_BATTERY_ENTITY_ID || '').trim()
};

const mock = {
  light: { id: 'light.kontoret_main', name: 'Kontoret Main', available: true, on: true, brightness: 25 },
  scene: { id: 'scene.neo_noir', name: 'Neo-Noir', available: true },
  vacuum: { id: 'vacuum.dreame_demo', name: 'Dreame L50s Pro Ultra', available: true, state: 'docked', battery: 85 }
};

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

function isAvailable(s) {
  return Boolean(s && s.state !== 'unavailable' && s.state !== 'unknown');
}

function entityMap(states) {
  const result = Object.create(null);
  states.forEach((s) => { result[s.entity_id] = s; });
  return result;
}

function lightSummary(s, id) {
  return {
    id, name: s && s.attributes && s.attributes.friendly_name || 'Gaming-room light',
    available: isAvailable(s), on: isAvailable(s) && s.state === 'on',
    brightness: s && s.attributes && typeof s.attributes.brightness === 'number'
      ? Math.round(s.attributes.brightness / 255 * 100) : null
  };
}
function sceneSummary(s, id) {
  return { id, name: s && s.attributes && s.attributes.friendly_name || 'Neo-Noir', available: isAvailable(s) };
}
function vacuumSummary(s, id, batterySensor) {
  let battery = null;
  if (s && s.attributes && typeof s.attributes.battery_level === 'number') battery = s.attributes.battery_level;
  if (batterySensor && !isNaN(Number(batterySensor.state)) && isAvailable(batterySensor)) battery = Number(batterySensor.state);
  return {
    id, name: s && s.attributes && s.attributes.friendly_name || 'Dreame L50s Pro Ultra',
    available: isAvailable(s), state: isAvailable(s) ? s.state : 'unavailable', battery
  };
}

app.get('/api/health', async () => ({ ok: true, mode: demo ? 'demo' : 'live' }));

app.get('/api/entities', async (request, reply) => {
  if (demo) return { entities: [{ id: mock.light.id, name: mock.light.name }, { id: mock.scene.id, name: mock.scene.name }, { id: mock.vacuum.id, name: mock.vacuum.name }] };
  try {
    const list = await ha('/api/states');
    return {
      entities: list.filter((s) => /^(light|scene|vacuum|sensor)\./.test(s.entity_id))
        .map((s) => ({ id: s.entity_id, name: s.attributes && s.attributes.friendly_name || s.entity_id }))
    };
  } catch (error) {
    request.log.error({ err: error }, 'Could not load Home Assistant entities');
    return reply.code(502).send({ error: 'Cannot contact Home Assistant: ' + error.message });
  }
});

app.get('/api/state', async (request, reply) => {
  if (demo) return { mode: 'demo', light: mock.light, scene: mock.scene, vacuum: mock.vacuum };
  try {
    const map = entityMap(await ha('/api/states'));
    return {
      mode: 'live',
      light: lightSummary(map[entities.light], entities.light),
      scene: sceneSummary(map[entities.scene], entities.scene),
      vacuum: vacuumSummary(map[entities.vacuum], entities.vacuum, map[entities.battery])
    };
  } catch (error) {
    request.log.error({ err: error }, 'Could not load Home Assistant state');
    return reply.code(502).send({ error: 'Cannot contact Home Assistant: ' + error.message });
  }
});

const actions = {
  'light.on': ['light', 'turn_on', 'light'],
  'light.off': ['light', 'turn_off', 'light'],
  'light.brightness': ['light', 'turn_on', 'light'],
  'scene.activate': ['scene', 'turn_on', 'scene'],
  'vacuum.start': ['vacuum', 'start', 'vacuum'],
  'vacuum.pause': ['vacuum', 'pause', 'vacuum'],
  'vacuum.dock': ['vacuum', 'return_to_base', 'vacuum']
};

app.post('/api/action', {
  schema: {
    body: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: Object.keys(actions) },
        brightness: { type: 'integer', minimum: 1, maximum: 100 }
      }
    }
  }
}, async (request, reply) => {
  const body = request.body;
  const action = body.action;
  if (action === 'light.brightness' && !Number.isInteger(body.brightness)) {
    return reply.code(400).send({ error: 'brightness must be an integer from 1 to 100' });
  }

  const [domain, service, kind] = actions[action];
  if (demo) {
    if (action === 'light.on') mock.light.on = true;
    if (action === 'light.off') mock.light.on = false;
    if (action === 'light.brightness') { mock.light.on = true; mock.light.brightness = body.brightness; }
    if (action === 'scene.activate') { mock.light.on = true; mock.light.brightness = 25; }
    if (action === 'vacuum.start') mock.vacuum.state = 'cleaning';
    if (action === 'vacuum.pause') mock.vacuum.state = 'paused';
    if (action === 'vacuum.dock') mock.vacuum.state = 'returning';
    return { ok: true };
  }

  if (!entities[kind]) return reply.code(409).send({ error: 'Entity not configured: ' + kind + '. See /api/entities.' });
  const payload = { entity_id: entities[kind] };
  if (action === 'light.brightness') payload.brightness_pct = body.brightness;
  try {
    await ha('/api/services/' + domain + '/' + service, 'POST', payload);
    return { ok: true };
  } catch (error) {
    request.log.error({ err: error }, 'Home Assistant service call failed');
    return reply.code(502).send({ error: 'Home Assistant could not complete the action: ' + error.message });
  }
});

if (!demo && !process.env.HA_TOKEN) {
  console.error('Missing HA_TOKEN. Set it in .env, or set DEMO_MODE=true.');
  process.exit(1);
}

app.listen({ port, host: '0.0.0.0' }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
