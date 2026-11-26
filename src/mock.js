'use strict';

// Fake Home Assistant states for DEMO_MODE. The server runs the same summaries over these
// as over live data, and applies service calls to them, so demo and live always match in shape.

const SCENE_BRIGHTNESS = { 'scene.neo_noir': 64, 'scene.night_city': 120, 'scene.work_light': 255 };

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60000).toISOString();
}
function state(entityId, value, attributes) {
  return { entity_id: entityId, state: String(value), attributes: attributes || {} };
}

// Hourly prices (kr/kWh incl. tariffs and VAT) shaped like a real Radius/DK2 winter day.
const PRICE_PROFILE = [2.21, 2.21, 2.17, 2.14, 2.17, 2.24, 2.81, 3.45, 3.70, 3.72, 3.64, 3.60,
  3.62, 3.71, 3.76, 3.98, 4.10, 4.96, 4.86, 4.76, 4.35, 3.33, 3.10, 2.80];

function priceDay(dayOffset, wiggle) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() + dayOffset);
  return PRICE_PROFILE.map((price, hour) => ({
    hour: new Date(midnight.getTime() + hour * 3600000).toISOString(),
    price: Math.round((price + wiggle * Math.sin(hour)) * 1000) / 1000
  }));
}

function createStates(vacuumId) {
  const base = vacuumId.replace(/^vacuum\./, '');
  const lights = ['light.kontoret_main', 'light.kontoret_wled'];
  const now = Math.floor(Date.now() / 1000);
  const sensor = (suffix, value, attributes) => state('sensor.' + base + '_' + suffix, value, attributes);

  return [
    state('scene.neo_noir', iso(40), { friendly_name: 'Neo-noir', entity_id: lights }),
    state('scene.night_city', iso(300), { friendly_name: 'Night city', entity_id: lights }),
    state('scene.work_light', iso(900), { friendly_name: 'Work light', entity_id: lights }),
    state('light.kontoret_main', 'on', { friendly_name: 'Kontoret_main', brightness: 64 }),
    state('light.kontoret_wled', 'unavailable', { friendly_name: 'WLED' }),

    state(vacuumId, 'docked', { friendly_name: 'Ottoto', battery_level: 80 }),
    sensor('status', 'sleeping'),
    sensor('battery_level', 80),
    sensor('error', 'no_error', { description: 'No error' }),
    sensor('low_water_warning', 'no_warning'),
    sensor('clean_water_tank_status', 'installed'),
    sensor('dirty_water_tank_status', 'installed'),
    sensor('detergent_status', 'installed'),
    sensor('dust_bag_status', 'installed'),
    sensor('mop_pad', 'installed'),
    sensor('current_room', 'Dining Room'),
    sensor('main_brush_left', 85),
    sensor('side_brush_left', 78),
    sensor('filter_left', 70),
    sensor('wheel_dirty_left', 74),
    sensor('sensor_dirty_left', 0),
    state('binary_sensor.' + base + '_maintenance', 'on', { items: ['sensor'] }),
    state('select.' + base + '_room_7_name', 'Office'),
    state('select.' + base + '_room_8_name', 'Balcony'),
    sensor('cleaning_history', iso(26 * 60), {
      'today': { timestamp: now - 26 * 3600, cleaning_time: '67 min', cleaned_area: '35 m²', completed: false, blocked_rooms: { 8: 'Blocked by door' }, pet: true },
      'yesterday': { timestamp: now - 50 * 3600, cleaning_time: '87 min', cleaned_area: '42 m²', completed: true, blocked_rooms: { 8: 'Blocked by obstacle', 7: 'Blocked by threshold' }, pet: false }
    }),

    state('sensor.energi_data_service', PRICE_PROFILE[new Date().getHours()], {
      friendly_name: 'Energi Data Service', currency: 'DKK', unit: 'kWh', region_code: 'DK2',
      tomorrow_valid: true, raw_today: priceDay(0, 0), raw_tomorrow: priceDay(1, 0.15)
    }),

    state('media_player.living_room_tv', 'on', { friendly_name: 'Living room TV', app_id: 'org.jellyfin.androidtv', device_class: 'tv' }),
    state('media_player.jellyfin_living_room_tv', 'playing', {
      friendly_name: 'Living room TV (Jellyfin)', app_name: 'Jellyfin', media_title: 'Blade Runner 2049',
      media_duration: 9840, media_position: 3100, media_position_updated_at: iso(2)
    })
  ];
}

// call = [domain, service, data], exactly what live mode would POST to HA.
function applyAction(states, call) {
  const [domain, service, data] = call;
  const byId = (id) => states.find((s) => s.entity_id === id);
  const ids = [].concat(data.entity_id);

  if (domain === 'scene' && service === 'turn_on') {
    const scene = byId(ids[0]);
    scene.state = new Date().toISOString();
    scene.attributes.entity_id.forEach((id) => {
      const light = byId(id);
      if (light && light.state !== 'unavailable') {
        light.state = 'on';
        light.attributes.brightness = SCENE_BRIGHTNESS[scene.entity_id] || 128;
      }
    });
  } else if (domain === 'light' && service === 'turn_off') {
    ids.forEach((id) => {
      const light = byId(id);
      if (light) { light.state = 'off'; delete light.attributes.brightness; }
    });
  }
}

module.exports = { createStates, applyAction };
