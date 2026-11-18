'use strict';

const HA_URL = (process.env.HA_URL || 'http://10.0.0.169:8123').replace(/\/$/, '');
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
