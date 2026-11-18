/* ES5 only, for Safari on first-generation iPad mini (iOS 9). */
(function () {
  'use strict';
  var busy = false;
  var current = null;
  var el = function (id) { return document.getElementById(id); };

  function text(id, value) { el(id).textContent = value; }
  function request(method, url, data, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.timeout = 10000;
    if (method === 'POST') {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('X-Night-City', '1');
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var value;
      try { value = JSON.parse(xhr.responseText || '{}'); } catch (e) { value = {}; }
      if (xhr.status >= 200 && xhr.status < 300) callback(null, value);
      else callback(value.error || ('Connection error (HTTP ' + xhr.status + ')'));
    };
    xhr.ontimeout = function () { callback('Request timed out'); };
    xhr.onerror = function () { callback('Cannot connect to the dashboard server'); };
    xhr.send(data ? JSON.stringify(data) : null);
  }

  function setDisabled(ids, disabled) {
    var i;
    for (i = 0; i < ids.length; i++) el(ids[i]).disabled = disabled;
  }

  function render(state) {
    current = state;
    text('mode', state.mode === 'demo' ? 'DEMO MODE' : 'LIVE SYSTEM');
    text('statusbar', state.mode === 'demo'
      ? 'Preview data only — no real devices are being controlled.'
      : 'Connected to Home Assistant. Device controls are live.');
    el('statusbar').className = 'statusbar';
    text('ha-status', 'ONLINE');

    var light = state.light;
    text('light-name', light.name);
    text('light-state', light.available ? (light.on ? 'ON / CONNECTED' : 'OFF / CONNECTED') : 'NOT AVAILABLE — CHECK ENTITY ID');
    el('light-dot').className = 'dot' + (light.available && light.on ? ' active' : '');
    var level = light.brightness !== null ? light.brightness : 25;
    el('brightness').value = level;
    text('brightness-value', light.brightness !== null ? level + '%' : '--%');
    setDisabled(['light-on', 'light-off', 'brightness'], !light.available);

    var scene = state.scene;
    text('scene-state', scene.available ? 'Saved in Home Assistant' : 'Scene not found — check entity ID');
    setDisabled(['scene-activate'], !scene.available);

    var vacuum = state.vacuum;
    text('vacuum-state', String(vacuum.state).toUpperCase().replace(/_/g, ' '));
    text('vacuum-battery', vacuum.battery === null ? 'NOT REPORTED' : vacuum.battery + '%');
    el('vacuum-dot').className = 'dot blue' + (vacuum.available ? ' active' : '');
    setDisabled(['vacuum-start', 'vacuum-pause', 'vacuum-dock'], !vacuum.available);

    var now = new Date();
    var hh = ('0' + now.getHours()).slice(-2);
    var mm = ('0' + now.getMinutes()).slice(-2);
    text('last-update', 'LAST SYNC ' + hh + ':' + mm);
  }

  function refresh() {
    if (busy) return;
    request('GET', '/api/state?nocache=' + new Date().getTime(), null, function (err, data) {
      if (err) {
        el('statusbar').className = 'statusbar error';
        text('statusbar', err);
        text('ha-status', 'OFFLINE');
      } else render(data);
    });
  }

  function action(name, extra) {
    if (busy) return;
    busy = true;
    var payload = extra || {};
    payload.action = name;
    text('statusbar', 'Sending command…');
    request('POST', '/api/action', payload, function (err) {
      busy = false;
      if (err) {
        el('statusbar').className = 'statusbar error';
        text('statusbar', err);
      } else {
        refresh();
      }
    });
  }

  el('light-on').onclick = function () { action('light.on'); };
  el('light-off').onclick = function () { action('light.off'); };
  el('brightness').oninput = function () { text('brightness-value', this.value + '%'); };
  el('brightness').onchange = function () { action('light.brightness', { brightness: Number(this.value) }); };
  el('scene-activate').onclick = function () { action('scene.activate'); };
  el('vacuum-start').onclick = function () { action('vacuum.start'); };
  el('vacuum-pause').onclick = function () { action('vacuum.pause'); };
  el('vacuum-dock').onclick = function () { action('vacuum.dock'); };

  function updateClock() {
    var now = new Date();
    text('clock', ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2));
  }
  updateClock();
  refresh();
  setInterval(refresh, 8000);
  setInterval(updateClock, 15000);
}());
