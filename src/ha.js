'use strict';

// Base URL including port, e.g. http://10.0.0.169 or http://homeassistant.local:8123.
// Required in live mode; server.js refuses to start without it.
const HA_URL = (process.env.HA_URL || '').trim().replace(/\/+$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';

async function ha(path, method, payload) {
  if (!HA_TOKEN) throw new Error('HA_TOKEN is missing. Create a long-lived access token.');

  const opts = {
    method: method || 'GET',
    headers: {
      Authorization: 'Bearer ' + HA_TOKEN,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(8000)
  };
  if (payload) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(payload);
  }

  const response = await fetch(HA_URL + path, opts);
  if (!response.ok) {
    throw new Error('Home Assistant returned HTTP ' + response.status + ' for ' + path);
  }
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

module.exports = { ha };
