/* ES5 only, for Safari on first-generation iPad mini (iOS 9). */
(function () {
  'use strict';
  var busy = false;
  var rendered = {};
  var photoRun = null;
  var media = null;
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function el(id) { return document.getElementById(id); }
  function text(id, value) { el(id).textContent = value; }
  // Toggles the is-hidden CSS rule (the CSP ignores inline style attributes in the HTML).
  function show(id, visible) {
    var node = el(id);
    var classes = (' ' + node.className + ' ').replace(/ is-hidden /g, ' ');
    node.className = (classes + (visible ? '' : ' is-hidden')).replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
  }
  function make(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = content;
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }
  function pad(n) { return ('0' + n).slice(-2); }
  function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function when(ms) {
    var d = new Date(ms);
    var today = new Date();
    var yesterday = new Date(today.getTime() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today ' + hm(d);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday ' + hm(d);
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + hm(d);
  }
  function duration(seconds) {
    var m = Math.round(seconds / 60);
    return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min';
  }
  // Rebuilding DOM every poll would eat taps on an old iPad, so only redraw what changed.
  function changed(key, data) {
    var json = JSON.stringify(data);
    if (rendered[key] === json) return false;
    rendered[key] = json;
    return true;
  }

  function request(method, url, data, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.timeout = 25000;
    if (method === 'POST') {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('X-Night-City', '1');
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var value;
      try { value = JSON.parse(xhr.responseText || '{}'); } catch (e) { value = {}; }
      if (xhr.status >= 200 && xhr.status < 300) callback(null, value);
      else if (xhr.status) callback(value.error || ('Connection error (HTTP ' + xhr.status + ')'));
    };
    xhr.ontimeout = function () { callback('Request timed out'); };
    xhr.onerror = function () { callback('Cannot connect to the dashboard server'); };
    xhr.send(data ? JSON.stringify(data) : null);
  }

  function setStatus(message, isError) {
    el('statusbar').className = 'statusbar' + (isError ? ' error' : '');
    text('statusbar', message);
  }

  // ---- Lights ---------------------------------------------------------------

  function renderLights(data) {
    if (!changed('lights', data)) return;
    var anyOn = false;
    var active = null;

    var box = clear(el('scenes'));
    data.scenes.forEach(function (scene) {
      if (scene.id === data.activeScene) active = scene;
      var button = make('button', scene.id === data.activeScene ? 'active' : '', scene.name.toUpperCase());
      button.type = 'button';
      button.disabled = !scene.available;
      button.onclick = function () { action('scene.activate', { scene: scene.id }); };
      box.appendChild(button);
    });
    if (!data.scenes.length) box.appendChild(make('p', 'secondary', 'No scenes found in Home Assistant.'));

    var list = clear(el('light-list'));
    data.lights.forEach(function (light) {
      if (light.on) anyOn = true;
      var row = make('div', 'info-pair');
      row.appendChild(make('span', null, light.name));
      var value = !light.available ? 'OFFLINE' : light.on ? 'ON' + (light.brightness !== null ? ' · ' + light.brightness + '%' : '') : 'OFF';
      row.appendChild(make('strong', light.available ? '' : 'muted', value));
      list.appendChild(row);
    });

    el('lights-off').disabled = !anyOn;
    el('light-dot').className = 'dot' + (anyOn ? ' active' : '');
    text('scene-note', active ? active.name + ' since ' + when(data.activeSince) : anyOn ? 'Pick a scene' : 'Lights are off');
  }

  // ---- Now playing ------------------------------------------------------------

  function renderMedia(m) {
    media = m;
    el('media-dot').className = 'dot blue' + (m.active ? ' active' : '');
    var art = el('media-art');
    if (!m.active) {
      text('media-title', 'Nothing playing');
      text('media-sub', 'The TV is off');
      text('media-meta', '');
      show('media-art', false);
      renderProgress();
      return;
    }
    var stateName = m.state === 'playing' ? 'Playing' : m.state === 'paused' ? 'Paused' : 'On';
    text('media-title', m.title || m.app || 'TV is on');
    text('media-sub', m.title ? (m.subtitle || '') : (m.app ? 'App open' : ''));
    text('media-meta', (m.title && m.app ? m.app + ' · ' : '') + stateName + ' · ' + m.device);

    if (m.artwork) {
      var src = '/api/media/artwork?entity=' + encodeURIComponent(m.id) + '&v=' + m.artwork;
      if (art.getAttribute('src') !== src) {
        art.onerror = function () { show('media-art', false); };
        art.src = src;
      }
      show('media-art', true);
    } else show('media-art', false);
    renderProgress();
  }

  // Runs every second so the bar moves between polls.
  function renderProgress() {
    var m = media;
    if (!m || !m.active || !m.duration || m.position === null) {
      show('media-progress', false);
      text('media-time', '');
      return;
    }
    var position = m.position;
    if (m.state === 'playing' && m.positionUpdatedAt) position += (new Date().getTime() - m.positionUpdatedAt) / 1000;
    position = Math.max(0, Math.min(position, m.duration));
    show('media-progress', true);
    el('media-progress-fill').style.width = (position / m.duration * 100).toFixed(1) + '%';
    text('media-time', duration(m.duration - position) + ' left');
  }

  // ---- Electricity ----------------------------------------------------------------

  var LEVEL_TEXT = { cheap: 'Cheap right now', normal: 'Normal price right now', expensive: 'Expensive right now' };

  function dayAndTime(ms) {
    var d = new Date(ms);
    var tomorrow = new Date(new Date().getTime() + 86400000);
    if (d.toDateString() === new Date().toDateString()) return 'today ' + hm(d);
    if (d.toDateString() === tomorrow.toDateString()) return 'tomorrow ' + hm(d);
    return DAYS[d.getDay()] + ' ' + hm(d);
  }
  function kr(price, unit) { return price.toFixed(2) + ' ' + unit; }
  function hoursText(minutes) {
    var h = minutes / 60;
    return (h === Math.round(h) ? h : h.toFixed(1)) + ' h';
  }

  function renderEnergy(e) {
    var visible = Boolean(e && e.available);
    show('energy-card', visible);
    if (!visible || !changed('energy', e)) return;

    text('energy-now', kr(e.current.price, e.unit));
    text('energy-level', LEVEL_TEXT[e.current.level]);
    el('energy-dot').className = 'dot' + (e.current.level === 'expensive' ? ' active' : '');

    var advice = clear(el('energy-advice'));
    e.appliances.forEach(function (a) {
      var row = make('div', 'advice-row');
      if (a.start === null) {
        row.appendChild(make('strong', null, a.name + ': not enough prices yet'));
      } else {
        row.appendChild(make('strong', null, a.name + ': ' + (a.startsNow ? 'start now' : 'start ' + dayAndTime(a.start))));
        var detail = hoursText(a.minutes) + ' program · avg ' + kr(a.average, e.unit);
        if (!a.startsNow && a.savingsPct > 0) detail += ' · ' + a.savingsPct + '% cheaper than now';
        row.appendChild(make('span', null, detail));
      }
      advice.appendChild(row);
    });
    text('energy-note', e.tomorrowAvailable ? '' : "Tomorrow's prices arrive around 13:00.");

    // Bar chart: zero baseline, one hue; the current slot is brighter. Tap a bar for its price.
    var chart = clear(el('energy-chart'));
    var axis = clear(el('energy-axis'));
    var max = 0;
    e.slots.forEach(function (s) { if (s.price > max) max = s.price; });
    var width = 100 / e.slots.length;
    var selected = null;
    e.slots.forEach(function (s, i) {
      var start = new Date(s.start);
      var col = make('div', 'chart-col' + (i === 0 ? ' now' : '') + (i > 0 && start.getHours() === 0 && start.getMinutes() === 0 ? ' midnight' : ''));
      col.style.width = width + '%';
      var bar = make('div', 'chart-bar');
      bar.style.height = Math.max(2, s.price / max * 100) + '%';
      col.appendChild(bar);
      col.onclick = function () {
        if (selected) selected.className = selected.className.replace(' picked', '');
        selected = col;
        col.className += ' picked';
        var end = new Date(s.start + e.slotMinutes * 60000);
        text('energy-readout', dayAndTime(s.start) + '–' + hm(end) + ' · ' + kr(s.price, e.unit) + ' · ' + s.level);
      };
      chart.appendChild(col);

      if (i === 0 || (start.getMinutes() === 0 && start.getHours() % 6 === 0)) {
        var label = make('span', null, i === 0 ? 'Now' : start.getHours() === 0 ? 'Tomorrow' : pad(start.getHours()));
        label.style.left = (i * width) + '%';
        axis.appendChild(label);
      }
    });
    text('energy-readout', 'Tap a bar to see its price.');
  }

  // ---- Vacuum -----------------------------------------------------------------

  function renderVacuum(v) {
    show('vacuum-card', Boolean(v));
    if (!v || !changed('vacuum', v)) return;

    text('vacuum-name', v.name.toUpperCase());
    text('vacuum-state', v.state + (v.detail ? ' · ' + v.detail : ''));
    text('vacuum-battery', v.battery === null ? 'NOT REPORTED' : v.battery + '%');
    el('vacuum-dot').className = 'dot blue' + (v.available ? ' active' : '');

    var attention = clear(el('vacuum-attention'));
    if (!v.attention.length) attention.appendChild(make('li', 'ok', 'All good ✓'));
    v.attention.forEach(function (item) { attention.appendChild(make('li', null, item)); });

    var station = clear(el('vacuum-station'));
    v.station.forEach(function (part) {
      station.appendChild(make('span', 'chip' + (part.ok ? '' : ' bad'), part.label + (part.ok ? ' ✓' : ': ' + part.state)));
    });

    var run = clear(el('vacuum-run'));
    var r = v.lastRun;
    if (!r) run.appendChild(make('p', 'run-line', 'No cleaning runs yet.'));
    else {
      run.appendChild(make('p', 'run-when', when(r.timestamp)));
      var stats = [];
      if (r.minutes) stats.push(r.minutes + ' min');
      if (r.area) stats.push(r.area + ' m²');
      run.appendChild(make('p', 'run-result ' + (r.completed ? 'ok' : 'warn'), (r.completed ? 'Finished' : "Didn't finish") + (stats.length ? ' · ' + stats.join(' · ') : '')));
      r.skipped.forEach(function (s) { run.appendChild(make('p', 'run-line', 'Skipped ' + s.room + ': ' + s.reason)); });
      r.oftenSkipped.forEach(function (s) {
        run.appendChild(make('p', 'run-line warn', s.room + ' was skipped in ' + s.count + ' of the last ' + s.of + ' runs'));
      });
    }

    var parts = clear(el('vacuum-parts'));
    v.consumables.forEach(function (c) {
      var row = make('div', 'part');
      row.appendChild(make('span', 'part-name', c.label));
      var cell = make('span');
      var bar = make('div', 'bar');
      var fill = make('div', 'bar-fill' + (c.percent < 15 ? ' low' : ''));
      fill.style.width = Math.max(0, Math.min(100, c.percent)) + '%';
      bar.appendChild(fill);
      cell.appendChild(bar);
      row.appendChild(cell);
      row.appendChild(make('span', 'part-pct' + (c.percent < 15 ? ' warn' : ''), c.percent + '%'));
      parts.appendChild(row);
    });

    // Photos belong to the latest run: only reload when there is a new run.
    var runKey = r ? r.timestamp : null;
    if (runKey !== photoRun) loadPhotos(runKey);
  }

  function loadPhotos(runKey) {
    request('GET', '/api/vacuum/photos?nocache=' + new Date().getTime(), null, function (err, data) {
      if (err) { show('photo-section', false); return; } // retried on the next poll
      photoRun = runKey;
      var strip = clear(el('photo-strip'));
      show('photo-section', data.photos.length > 0);
      text('photo-count', data.photos.length + (data.photos.length === 1 ? ' PHOTO' : ' PHOTOS'));
      data.photos.forEach(function (p) {
        var src = '/api/vacuum/photos/' + p.index + '?v=' + encodeURIComponent(data.version);
        var label = p.room || 'Pet';
        var button = make('button', 'photo');
        button.type = 'button';
        var img = make('img');
        img.src = src;
        img.alt = label;
        button.appendChild(img);
        button.appendChild(make('span', null, label));
        button.onclick = function () { openViewer(src, label); };
        strip.appendChild(button);
      });
    });
  }

  function openViewer(src, caption) {
    el('viewer-img').src = src;
    text('viewer-caption', caption + ' — tap to close');
    show('viewer', true);
  }
  el('viewer').onclick = function () { show('viewer', false); };

  // ---- Polling & actions --------------------------------------------------------

  function render(state) {
    text('mode', state.mode === 'demo' ? 'DEMO MODE' : 'LIVE SYSTEM');
    if (!busy) {
      setStatus(state.mode === 'demo'
        ? 'Preview data only — no real devices are being controlled.'
        : 'Connected to Home Assistant. Controls are live.', false);
    }
    renderLights(state.lights);
    renderMedia(state.media);
    renderEnergy(state.energy);
    renderVacuum(state.vacuum);
    text('last-update', 'LAST SYNC ' + hm(new Date()));
  }

  function refresh() {
    request('GET', '/api/state?nocache=' + new Date().getTime(), null, function (err, data) {
      if (err) setStatus(err, true);
      else render(data);
    });
  }

  function action(name, extra) {
    if (busy) return;
    busy = true;
    var payload = extra || {};
    payload.action = name;
    setStatus('Sending command…', false);
    request('POST', '/api/action', payload, function (err) {
      busy = false;
      if (err) setStatus(err, true);
      else refresh();
    });
  }

  el('lights-off').onclick = function () { action('lights.off'); };

  function updateClock() { text('clock', hm(new Date())); }
  updateClock();
  refresh();
  setInterval(refresh, 8000);
  setInterval(updateClock, 15000);
  setInterval(renderProgress, 1000);
}());
