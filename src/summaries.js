'use strict';

// Pure functions turning Home Assistant states into the dashboard's card data.
// Used for both live and demo mode, so the response shape is identical in both.

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const PET_OBSTACLE_TYPE = 158; // Dreame obstacle type code for a detected pet
const MAX_PHOTOS = 24;

// Package names reported by Android TV Remote → names people recognise.
const APPS = {
  'com.amazon.amazonvideo.livingroom': 'Prime Video',
  'com.amazon.avod.thirdpartyclient': 'Prime Video',
  'com.wbd.stream': 'HBO Max',
  'com.hbo.hbonow': 'HBO Max',
  'com.plexapp.android': 'Plex',
  'org.jellyfin.androidtv': 'Jellyfin',
  'com.netflix.ninja': 'Netflix',
  'com.google.android.youtube.tv': 'YouTube',
  'com.disney.disneyplus': 'Disney+',
  'com.google.android.tvlauncher': 'Home screen',
  'com.google.android.apps.tv.launcherx': 'Home screen'
};

// binary_sensor.<vacuum>_maintenance "items" → plain instructions.
const MAINTENANCE = {
  sensor: 'Wipe the sensors',
  wheel: 'Clean the wheel',
  main_brush: 'Clean the main brush',
  side_brush: 'Check the side brush',
  filter: 'Clean the filter',
  mop_pad: 'Replace the mop pads',
  detergent: 'Refill detergent'
};

const CONSUMABLES = [
  ['main_brush_left', 'Main brush'],
  ['side_brush_left', 'Side brush'],
  ['filter_left', 'Filter'],
  ['wheel_dirty_left', 'Wheel'],
  ['sensor_dirty_left', 'Sensors']
];

const STATION_PARTS = [
  ['clean_water_tank_status', 'Clean water'],
  ['dirty_water_tank_status', 'Dirty water'],
  ['detergent_status', 'Detergent'],
  ['dust_bag_status', 'Dust bag'],
  ['mop_pad', 'Mop pads']
];

const BLOCKED_REASONS = {
  'Blocked by door': 'door was closed',
  'Blocked by obstacle': 'something was in the way',
  'Blocked by dynamic obstacle': 'something moving was in the way',
  'Blocked by threshold': "couldn't get over the threshold"
};

function isAvailable(s) {
  return Boolean(s && s.state !== 'unavailable' && s.state !== 'unknown');
}
function attr(s, key) {
  return s && s.attributes ? s.attributes[key] : undefined;
}
function friendly(s, fallback) {
  return attr(s, 'friendly_name') || fallback;
}
function humanize(value) {
  const text = String(value == null ? '' : value).replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The Dreame integration names the vacuum "Ottoto  Ottoto" (device name + entity name).
function dedupeName(name) {
  const words = name.trim().split(/\s+/);
  const half = words.length / 2;
  if (words.length % 2 === 0 && words.slice(0, half).join(' ') === words.slice(half).join(' ')) return words.slice(0, half).join(' ');
  return words.join(' ');
}

function entityMap(states) {
  const result = Object.create(null);
  states.forEach((s) => { result[s.entity_id] = s; });
  return result;
}

// ---- Lights & scenes ------------------------------------------------------

// Scenes come from SCENE_ENTITY_IDS when set, otherwise every scene in HA.
// The lights shown are the ones those scenes control.
function lightsSummary(map, configuredScenes) {
  const ids = configuredScenes.length
    ? configuredScenes
    : Object.keys(map).filter((id) => id.startsWith('scene.')).sort();

  const scenes = ids.map((id) => {
    const s = map[id];
    const activated = s ? Date.parse(s.state) : NaN; // a scene's state is when it was last activated
    return { id, name: friendly(s, id), available: Boolean(s) && s.state !== 'unavailable', lastActivated: isNaN(activated) ? null : activated };
  });

  const lightIds = [];
  ids.forEach((id) => {
    [].concat(attr(map[id], 'entity_id') || []).forEach((e) => {
      if (e.startsWith('light.') && lightIds.indexOf(e) < 0) lightIds.push(e);
    });
  });
  const lights = lightIds.map((id) => {
    const s = map[id];
    const brightness = attr(s, 'brightness');
    return {
      id, name: friendly(s, id), available: isAvailable(s), on: isAvailable(s) && s.state === 'on',
      brightness: typeof brightness === 'number' ? Math.round(brightness / 255 * 100) : null
    };
  });

  // HA has no "active scene". Treat the most recently activated one as current while any light is on.
  let latest = null;
  scenes.forEach((scene) => {
    if (scene.lastActivated && (!latest || scene.lastActivated > latest.lastActivated)) latest = scene;
  });
  const anyOn = lights.some((l) => l.on);
  return {
    scenes, lights,
    activeScene: latest && anyOn ? latest.id : null,
    activeSince: latest && anyOn ? latest.lastActivated : null
  };
}

// ---- Vacuum (Dreame integration naming: sensor.<name>_*, camera.<name>_map) -----

function vacuumBase(vacuumId) {
  return vacuumId.replace(/^vacuum\./, '');
}

function lastRun(map, base) {
  const history = map['sensor.' + base + '_cleaning_history'];
  const attrs = (history && history.attributes) || {};
  const runs = Object.keys(attrs).map((k) => attrs[k])
    .filter((r) => r && typeof r === 'object' && typeof r.timestamp === 'number')
    .sort((a, b) => b.timestamp - a.timestamp);
  if (!runs.length) return null;

  const roomName = (id) => {
    const s = map['select.' + base + '_room_' + id + '_name'];
    return isAvailable(s) ? s.state : 'Room ' + id;
  };
  const reason = (r) => BLOCKED_REASONS[r] || String(r).toLowerCase();

  // Rooms that keep getting skipped are more useful to know about than a one-off.
  const recent = runs.slice(0, 5);
  const counts = {};
  recent.forEach((run) => Object.keys(run.blocked_rooms || {}).forEach((id) => { counts[id] = (counts[id] || 0) + 1; }));

  const run = runs[0];
  return {
    timestamp: run.timestamp * 1000,
    minutes: parseInt(run.cleaning_time, 10) || null,
    area: parseInt(run.cleaned_area, 10) || null,
    completed: run.completed === true,
    skipped: Object.keys(run.blocked_rooms || {}).map((id) => ({ room: roomName(id), reason: reason(run.blocked_rooms[id]) })),
    oftenSkipped: Object.keys(counts).filter((id) => counts[id] >= 2)
      .map((id) => ({ room: roomName(id), count: counts[id], of: recent.length }))
  };
}

function vacuumSummary(map, vacuumId, batteryId) {
  const v = map[vacuumId];
  const base = vacuumBase(vacuumId);
  const sensor = (suffix) => map['sensor.' + base + '_' + suffix];
  const value = (suffix) => (isAvailable(sensor(suffix)) ? sensor(suffix).state : null);
  const available = isAvailable(v);

  let battery = typeof attr(v, 'battery_level') === 'number' ? attr(v, 'battery_level') : null;
  const batterySensor = batteryId ? map[batteryId] : sensor('battery_level');
  if (isAvailable(batterySensor) && !isNaN(Number(batterySensor.state))) battery = Number(batterySensor.state);

  const attention = [];
  const error = sensor('error');
  if (isAvailable(error) && error.state !== 'no_error') attention.push(attr(error, 'description') || humanize(error.state));
  const water = value('low_water_warning');
  if (water && water !== 'no_warning') attention.push('Water: ' + humanize(water).toLowerCase());

  const station = STATION_PARTS
    .map(([suffix, label]) => ({ label, state: value(suffix) }))
    .filter((p) => p.state !== null)
    .map((p) => ({ label: p.label, ok: p.state === 'installed', state: humanize(p.state) }));
  station.forEach((p) => { if (!p.ok) attention.push(p.label + ': ' + p.state.toLowerCase()); });

  const maintenance = map['binary_sensor.' + base + '_maintenance'];
  if (maintenance && maintenance.state === 'on') {
    [].concat(attr(maintenance, 'items') || []).forEach((item) => attention.push(MAINTENANCE[item] || humanize(item) + ' needs maintenance'));
  }

  const consumables = CONSUMABLES
    .map(([suffix, label]) => ({ label, percent: value(suffix) === null ? NaN : Number(value(suffix)) }))
    .filter((c) => !isNaN(c.percent));

  let detail = value('status') ? humanize(value('status')) : null;
  const room = value('current_room');
  if (available && v.state === 'cleaning' && room) detail = (detail ? detail + ' · ' : '') + room;

  return {
    id: vacuumId,
    name: dedupeName(friendly(v, 'Vacuum')),
    available,
    state: available ? humanize(v.state) : 'Unavailable',
    detail, battery, attention, station, consumables,
    lastRun: lastRun(map, base)
  };
}

// Pet photos for the latest run, from the Dreame integration's history map data
// (/api/camera_history_map_proxy/<camera>?index=1&data=1). Each obstacle is an array:
// [0] index, [3] type code, [6] picture status (2 = has photo), [12] room name.
// Only pets for now: a run has dozens of obstacle photos, which is too much for the dashboard.
function parsePhotoList(body) {
  const raw = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body) : body;
  const data = JSON.parse(raw.toString('utf8'));
  const obstacles = Array.isArray(data.obstacles) ? data.obstacles
    : data.obstacles && typeof data.obstacles === 'object' ? Object.values(data.obstacles) : [];
  return obstacles
    .filter((o) => Array.isArray(o) && o[6] === 2 && o[3] === PET_OBSTACLE_TYPE)
    .map((o) => ({ index: Number(o[0]), room: typeof o[12] === 'string' ? o[12] : null }))
    .filter((p) => Number.isInteger(p.index) && p.index > 0)
    .slice(0, MAX_PHOTOS);
}

// ---- Media ----------------------------------------------------------------

// Picks the most interesting player: playing with a title > paused > merely on.
// Plex/Jellyfin integrations give titles; Android TV Remote only knows the open app.
function mediaSummary(map, configuredPlayers) {
  const ids = configuredPlayers.length
    ? configuredPlayers
    : Object.keys(map).filter((id) => id.startsWith('media_player.'));
  const rank = (s) => (s.state === 'playing' ? 0 : s.state === 'paused' ? 2 : 4) + (attr(s, 'media_title') ? 0 : 1);
  const candidates = ids.map((id) => map[id])
    .filter((s) => isAvailable(s) && ['off', 'standby', 'idle'].indexOf(s.state) < 0)
    .sort((a, b) => rank(a) - rank(b));
  if (!candidates.length) return { active: false };

  const s = candidates[0];
  const a = s.attributes || {};
  const appName = a.app_name && a.app_name.indexOf('.') < 0 ? a.app_name : null; // skip raw package names
  let subtitle = null;
  if (a.media_series_title) {
    subtitle = a.media_series_title + (a.media_season && a.media_episode ? ' · S' + a.media_season + 'E' + a.media_episode : '');
  } else if (a.media_artist) subtitle = a.media_artist;

  return {
    active: true,
    id: s.entity_id,
    device: friendly(s, s.entity_id),
    state: s.state,
    title: a.media_title || null,
    subtitle,
    app: APPS[a.app_id] || APPS[a.app_name] || appName,
    // Cache-buster only. Hashed because entity_picture URLs carry an HA access token.
    artwork: typeof a.entity_picture === 'string'
      ? crypto.createHash('sha1').update(String(a.media_content_id || '') + a.entity_picture).digest('hex').slice(0, 12)
      : null,
    position: typeof a.media_position === 'number' ? a.media_position : null,
    duration: typeof a.media_duration === 'number' ? a.media_duration : null,
    positionUpdatedAt: a.media_position_updated_at ? Date.parse(a.media_position_updated_at) || null : null
  };
}

// ---- Electricity prices (Energi Data Service integration) -------------------

// Prices are per slot (hourly today; the code also copes with 15-minute slots).
// raw_today / raw_tomorrow: [{ hour: ISO time, price: kr/kWh incl. tariffs and VAT }].
function energySummary(map, priceId, appliances, now) {
  const s = map[priceId];
  if (!isAvailable(s)) return { available: false };
  const a = s.attributes || {};
  const all = [].concat(a.raw_today || [], a.tomorrow_valid ? a.raw_tomorrow || [] : [])
    .map((p) => ({ start: Date.parse(p.hour), price: Number(p.price) }))
    .filter((p) => !isNaN(p.start) && !isNaN(p.price))
    .sort((x, y) => x.start - y.start);
  const slotMs = all.length > 1 ? all[1].start - all[0].start : 3600000;
  const slots = all.filter((p) => p.start + slotMs > now); // the current slot onwards
  if (!slots.length) return { available: false };

  // "Cheap" and "expensive" are relative to the prices still ahead (bottom and top third).
  const sorted = slots.map((p) => p.price).sort((x, y) => x - y);
  const low = sorted[Math.floor((sorted.length - 1) / 3)];
  const high = sorted[Math.ceil((sorted.length - 1) * 2 / 3)];
  const level = (price) => (price <= low ? 'cheap' : price >= high ? 'expensive' : 'normal');
  const average = (from, count) => slots.slice(from, from + count).reduce((sum, p) => sum + p.price, 0) / count;
  const round = (n) => Math.round(n * 100) / 100;

  const advice = appliances.map(({ name, minutes }) => {
    const count = Math.max(1, Math.ceil(minutes * 60000 / slotMs));
    let best = -1;
    let bestAverage = Infinity;
    for (let i = 0; i + count <= slots.length; i++) {
      const avg = average(i, count);
      if (avg < bestAverage - 1e-9) { best = i; bestAverage = avg; } // ties keep the earliest start
    }
    if (best < 0) return { name, minutes, start: null };
    const nowAverage = average(0, count);
    return {
      name, minutes,
      start: slots[best].start,
      startsNow: best === 0,
      average: round(bestAverage),
      savingsPct: nowAverage > 0 ? Math.round((nowAverage - bestAverage) / nowAverage * 100) : 0
    };
  });

  return {
    available: true,
    unit: (a.currency === 'DKK' || !a.currency ? 'kr' : a.currency) + '/' + (a.unit || 'kWh'),
    current: { price: round(slots[0].price), level: level(slots[0].price) },
    slotMinutes: Math.round(slotMs / 60000),
    slots: slots.map((p) => ({ start: p.start, price: round(p.price), level: level(p.price) })),
    tomorrowAvailable: Boolean(a.tomorrow_valid),
    appliances: advice
  };
}

// ---- Weather (any HA weather entity; hourly forecast from weather.get_forecasts) ----

// HA condition → [plain words, symbol]. Symbols are old-iOS-safe Unicode, not newer emoji.
const CONDITIONS = {
  'clear-night': ['Clear', '☾'], sunny: ['Sunny', '☀'], partlycloudy: ['Partly cloudy', '⛅'],
  cloudy: ['Cloudy', '☁'], fog: ['Fog', '≋'], rainy: ['Rain', '☂'], pouring: ['Heavy rain', '☂'],
  snowy: ['Snow', '❄'], 'snowy-rainy': ['Sleet', '❄'], hail: ['Hail', '❄'], lightning: ['Lightning', '⚡'],
  'lightning-rainy': ['Thunderstorms', '⚡'], windy: ['Windy', '≈'], 'windy-variant': ['Windy', '≈'],
  exceptional: ['Unusual weather', '!']
};
const OUTLOOK_HOURS = 12;

function toMs(speed, unit) {
  if (typeof speed !== 'number') return null;
  if (unit === 'm/s') return Math.round(speed);
  if (unit === 'mph') return Math.round(speed * 0.447);
  return Math.round(speed / 3.6); // km/h, met.no's default. Danes read wind in m/s.
}

function weatherSummary(map, weatherId, forecast, now) {
  const w = map[weatherId];
  if (!isAvailable(w)) return { available: false };
  const a = w.attributes || {};
  const condition = CONDITIONS[w.state] || [humanize(w.state), ''];
  const hourly = (forecast || [])
    .map((f) => ({ start: Date.parse(f.datetime), f }))
    .filter((h) => !isNaN(h.start) && h.start + 3600000 > now)
    .slice(0, OUTLOOK_HOURS);

  // First stretch of rain in the outlook: from (null = already raining) and to (null = beyond the outlook).
  const wet = (f) => (f.precipitation || 0) >= 0.1;
  let rain = null;
  const first = hourly.findIndex((h) => wet(h.f));
  if (first >= 0) {
    let last = first;
    while (last + 1 < hourly.length && wet(hourly[last + 1].f)) last++;
    rain = {
      from: first === 0 ? null : hourly[first].start,
      to: last === hourly.length - 1 ? null : hourly[last].start + 3600000
    };
  }
  const temps = hourly.map((h) => h.f.temperature).filter((t) => typeof t === 'number');
  const sun = map['sun.sun'];
  const sunTime = (key) => (attr(sun, key) ? Date.parse(attr(sun, key)) || null : null);

  return {
    available: true,
    temperature: typeof a.temperature === 'number' ? Math.round(a.temperature) : null,
    condition: condition[0],
    icon: condition[1],
    wind: toMs(a.wind_speed, a.wind_speed_unit),
    outlookHours: hourly.length,
    rain,
    low: temps.length ? Math.round(Math.min.apply(null, temps)) : null,
    high: temps.length ? Math.round(Math.max.apply(null, temps)) : null,
    hours: hourly.slice(1, 7).map((h) => ({
      start: h.start,
      temperature: typeof h.f.temperature === 'number' ? Math.round(h.f.temperature) : null,
      icon: (CONDITIONS[h.f.condition] || ['', ''])[1],
      wet: wet(h.f)
    })),
    sunUp: Boolean(sun) && sun.state === 'above_horizon',
    sunrise: sunTime('next_rising'),
    sunset: sunTime('next_setting')
  };
}

module.exports = { entityMap, lightsSummary, vacuumSummary, vacuumBase, parsePhotoList, mediaSummary, energySummary, weatherSummary };
