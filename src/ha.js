'use strict';

// Base URL including port, e.g. http://10.0.0.169 or http://homeassistant.local:8123.
// Required in live mode; server.js refuses to start without it.
const HA_URL = (process.env.HA_URL || '').trim().replace(/\/+$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';

async function request(path, method, payload, accept, timeoutMs) {
  if (!HA_TOKEN) throw new Error('HA_TOKEN is missing. Create a long-lived access token.');

  const opts = {
    method: method || 'GET',
    headers: {
      Authorization: 'Bearer ' + HA_TOKEN,
      Accept: accept
    },
    signal: AbortSignal.timeout(timeoutMs)
  };
  if (payload) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(payload);
  }

  const response = await fetch(HA_URL + path, opts);
  if (!response.ok) {
    // Strip the query string: some HA URLs carry access tokens there.
    throw new Error('Home Assistant returned HTTP ' + response.status + ' for ' + path.split('?')[0]);
  }
  return response;
}

// JSON REST call.
async function ha(path, method, payload) {
  const response = await request(path, method, payload, 'application/json', 8000);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

// Binary GET (camera images, gzipped map data). Slower: the vacuum integration may fetch from the cloud.
async function haBinary(path) {
  const response = await request(path, 'GET', null, '*/*', 20000);
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream'
  };
}

module.exports = { ha, haBinary };
