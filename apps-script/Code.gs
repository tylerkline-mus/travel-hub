/**
 * Travel Hub — Google Apps Script backend
 * ---------------------------------------------------------------
 * Paste this whole file into Extensions → Apps Script on your
 * Travel Hub Google Sheet, run setup() once, then deploy as a
 * Web App (Execute as: Me, Who has access: Anyone).
 *
 * Script Properties (Project Settings → Script Properties):
 *   TOKEN       your passphrase (setup() creates one if missing)
 *   PLACES_KEY  your Google Maps Platform API key (optional but
 *               needed for place names, hours and addresses)
 */

const SHEETS = {
  Trips: ['id', 'name', 'destination', 'start', 'end', 'timezone', 'notes', 'created', 'updated'],
  Items: ['id', 'trip_id', 'kind', 'category', 'title', 'city', 'region', 'country', 'address',
          'lat', 'lng', 'place_id', 'maps_url', 'hours', 'website', 'day', 'start_time', 'end_time',
          'confirmation', 'status', 'source', 'notes', 'created', 'updated',
          'end_day', 'parent_id', 'seq', 'priority',
          'from_code', 'to_code', 'from_name', 'to_name', 'from_lat', 'from_lng', 'to_lat', 'to_lng', 'types',
          'summary',   // Google's one-line description ('-' = Google has none), fetched once by fillSummaries
          'blurb'],    // a one-line description Claude wrote (used when Google has none)
  Plan:  ['trip_id', 'day', 'item_id', 'order', 'note'],
  Log:   ['id', 'trip_id', 'item_id', 'place_id', 'title', 'lat', 'lng', 'logged_at', 'timezone',
          'origin', 'note', 'would_return', 'cost', 'currency', 'photo_url', 'created',
          'parent_id', 'day', 'seq', 'time', 'mode', 'address', 'city', 'maps_url', 'updated', 'rating', 'category',
          'here_lat', 'here_lng',    // where the phone actually was (so a wrong guess can be fixed from the app)
          'icon'],                   // a small line drawing Claude made from the stop's photo (JSON paths on a 48-unit square), drawn in the poster's key
  Routes: ['key', 'polyline', 'duration', 'distance', 'created'],
  // Photos, sounds and souvenirs kept with a logged stop. The files live in Drive (Travel Hub / <trip>), private to you.
  Artifacts: ['id', 'log_id', 'trip_id', 'kind', 'title', 'note', 'file_id', 'mime', 'duration', 'seq', 'created', 'updated'],
  // A chapter is a stretch of a trip (dates + places near where you stay then). It's a lens: items stay on the trip.
  Chapters: ['id', 'trip_id', 'name', 'start', 'end', 'radius_km', 'created', 'updated'],
  // Review links. token is the secret in the link; revoked = when it was turned off.
  Shares: ['id', 'token', 'trip_id', 'chapter_id', 'who', 'created', 'revoked'],
  // One answer per person per item: plan | nearby | pass | later
  Reactions: ['id', 'share_id', 'item_id', 'answer', 'created', 'updated'],
  // What someone with a review link sent in. Never written into Items until you keep it (asks are the exception: they become ideas).
  Inbox: ['id', 'share_id', 'trip_id', 'kind', 'text', 'title', 'note', 'category', 'city', 'address', 'lat', 'lng',
          'place_id', 'maps_url', 'website', 'image', 'types', 'hours', 'status', 'item_id', 'created', 'updated'],
};

// What a review link (someone you shared a chapter with) may do. Nothing here edits or deletes your rows.
const REVIEW_ACTIONS = {
  review: function (p, sh) { return reviewPayload(sh); },
  react: function (p, sh) { return reviewReact(p, sh); },
  suggest: function (p, sh) { return reviewSuggest(p, sh); },
};

// What a Google lookup is allowed to fill in on an existing item
const LOCATION_FIELDS = ['city', 'region', 'country', 'address', 'lat', 'lng', 'place_id', 'maps_url', 'hours', 'website', 'types'];

// How each travel mode is asked of the Google Routes API
const ROUTE_MODES = { walk: 'WALK', transit: 'TRANSIT', train: 'TRANSIT', car: 'DRIVE', tour: 'DRIVE', bike: 'BICYCLE' };

const PLACE_FIELDS = ['id', 'displayName', 'formattedAddress', 'location', 'regularOpeningHours',
  'websiteUri', 'googleMapsUri', 'primaryTypeDisplayName', 'addressComponents', 'utcOffsetMinutes', 'types'];

/* ---------------------------------------------------------------
 * One-time setup: creates the tabs and headers, keeps every cell
 * as plain text so dates and IDs never get auto-converted.
 * ------------------------------------------------------------- */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = SHEETS[name];
    const existing = sh.getLastColumn() > 0
      ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String)
      : [];
    // Add any missing headers to the right without disturbing existing ones
    const missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
    const finalHeaders = existing.filter(String).concat(missing);
    sh.getRange(1, 1, 1, finalHeaders.length).setValues([finalHeaders]).setFontWeight('bold');
    sh.getRange(1, 1, sh.getMaxRows(), finalHeaders.length).setNumberFormat('@');
    sh.setFrozenRows(1);
  });
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0) ss.deleteSheet(def);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) {
    const token = Utilities.getUuid().split('-')[0];
    props.setProperty('TOKEN', token);
    Logger.log('Created passphrase (TOKEN): ' + token);
  } else {
    Logger.log('Passphrase (TOKEN) already set: ' + props.getProperty('TOKEN'));
  }
  if (!props.getProperty('PLACES_KEY')) {
    Logger.log('No PLACES_KEY yet — Maps links will save, but without hours/address lookup.');
  }
}

/** Run this from the editor to check your Places key works. */
function testPlaces() {
  const r = resolveText('https://www.google.com/maps/place/Harpa/@64.1502,-21.9326,17z');
  Logger.log(JSON.stringify(r, null, 2));
}

/* ---------------------------------------------------------------
 * Web endpoints
 * ------------------------------------------------------------- */
function doGet(e) {
  return handle((e && e.parameter) || {});
}

function doPost(e) {
  let p = {};
  try { p = JSON.parse(e.postData.contents); } catch (err) { p = (e && e.parameter) || {}; }
  return handle(p);
}

function handle(p) {
  try {
    // A review link: its own key (reviewKey, never `share`, which the app uses to make links), and only the few things a review link may do
    if (p.reviewKey && !p.token) {
      const rfn = REVIEW_ACTIONS[p.action];
      if (!rfn) return json({ ok: false, error: 'Not available from a review link' });
      const sh = shareByToken(p.reviewKey);
      if (!sh) return json({ ok: false, error: 'This link has been turned off', gone: true });
      return json({ ok: true, data: rfn(p, sh) });
    }
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || String(p.token) !== token) return json({ ok: false, error: 'Wrong passphrase', got: receivedSummary(p) });
    const fn = ACTIONS[p.action];
    if (!fn) return json({ ok: false, error: 'Unknown action: ' + p.action });
    // Shortcuts cut a link off at "https://" when it sits inside another address, so they send it
    // Base64-encoded as b64 instead. Unpack it into text.
    if (p.b64 && !p.text) p.text = fromBase64(p.b64);
    const data = fn(p);
    if (p.format === 'text') {
      if (data && typeof data === 'object') {
        const where = data.trip_id ? ((readTable('Trips').filter(function (t) { return t.id === data.trip_id; })[0] || {}).name || 'your trip') : 'Someday';
        return ContentService.createTextOutput((data._duplicate ? 'Already saved: ' : 'Saved ') + (data.title || 'it') + ' to ' + where);
      }
      return ContentService.createTextOutput(String(data));
    }
    return json({ ok: true, data: data });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

/** For troubleshooting shortcuts: which fields arrived and how long each was (never the values). */
function receivedSummary(p) {
  return Object.keys(p || {}).map(function (k) { return k + '(' + String(p[k]).length + ')'; }).join(' ') || 'nothing';
}

function fromBase64(b) {
  // '+' turns into a space in web addresses; URL-safe Base64 uses - and _
  const clean = String(b).trim().replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
  try { return Utilities.newBlob(Utilities.base64Decode(clean)).getDataAsString(); } catch (e) { return ''; }
}

/** Turns what a shortcut sends as `trip` into a trip id: 'auto', 'Someday', a trip id, or a trip's name. Unknown → Someday. */
function resolveTripParam(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.toLowerCase() === 'someday') return '';
  if (s.toLowerCase() === 'auto') return currentOrNextTripId();
  const trips = readTable('Trips');
  const t = trips.filter(function (x) { return x.id === s; })[0] ||
            trips.filter(function (x) { return String(x.name).trim().toLowerCase() === s.toLowerCase(); })[0];
  return t ? t.id : '';
}

/** The trip happening now (a day either side counts), otherwise the next one coming up. '' if none. */
function currentOrNextTripId() {
  const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  const shift = function (d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return Utilities.formatDate(x, 'UTC', 'yyyy-MM-dd'); };
  const trips = readTable('Trips').filter(function (t) { return t.start; })
    .sort(function (a, b) { return a.start.localeCompare(b.start); });
  const now = trips.filter(function (t) { return shift(t.start, -1) <= today && today <= shift(t.end || t.start, 1); })[0];
  if (now) return now.id;
  const next = trips.filter(function (t) { return t.start > today; })[0];
  return next ? next.id : '';
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

const ACTIONS = {
  /** Everything the app needs on load. */
  bootstrap: function () {
    return {
      trips: readTable('Trips'),
      items: readTable('Items'),
      plan: readTable('Plan'),
      log: readTable('Log'),
      artifacts: hasTab('Artifacts') ? readTable('Artifacts') : [],
      chapters: hasTab('Chapters') ? readTable('Chapters') : [],
      shares: hasTab('Shares') ? readTable('Shares') : [],
      reactions: hasTab('Reactions') ? readTable('Reactions') : [],
      inbox: hasTab('Inbox') ? readTable('Inbox') : [],
      places: !!PropertiesService.getScriptProperties().getProperty('PLACES_KEY'),
    };
  },

  /** For the iPhone Shortcut: { "Trip name": "trip_id", ..., "Someday": "someday" } */
  tripMenu: function () {
    const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
    const trips = readTable('Trips')
      .filter(function (t) { return !t.end || t.end >= today; })
      .sort(function (a, b) { return String(a.start || '9999').localeCompare(String(b.start || '9999')); });
    const menu = {};
    trips.forEach(function (t) { menu[t.name] = t.id; });
    menu['Someday'] = 'someday';
    return menu;
  },

  /** Add an item from pasted text / a Maps link. Works from GET (Shortcut) or POST (app). */
  add: function (p) {
    return withLock(function () {
      const tripId = resolveTripParam(p.trip);
      const id = p.id ? String(p.id) : newId('it');
      const existing = findRow('Items', id);
      if (existing) return existing.obj; // idempotent for the offline queue

      const text = String(p.text || '').trim();
      // Nothing to save (e.g. a shortcut whose link didn't come through): say so instead of adding "Untitled"
      if (!text && !p.title && !p.from_code && !p.to_code) throw new Error('Nothing came through to save — no link or text. Got: ' + receivedSummary(p));
      const resolved = text ? resolveText(text) : {};
      const now = new Date().toISOString();
      const item = {
        id: id,
        trip_id: tripId,
        kind: p.kind || resolved.kind || 'idea',
        category: p.category || resolved.category || '',
        title: p.title || resolved.title || text || 'Untitled',
        city: resolved.city || '', region: resolved.region || '', country: resolved.country || '',
        address: resolved.address || '',
        lat: resolved.lat != null ? resolved.lat : '', lng: resolved.lng != null ? resolved.lng : '',
        place_id: resolved.place_id || '',
        maps_url: resolved.maps_url || '',
        hours: resolved.hours || '',
        website: resolved.website || '',
        types: resolved.types || '',
        day: p.day || '', start_time: p.start_time || '', end_time: p.end_time || '',
        end_day: p.end_day || '',
        parent_id: p.parent_id || '',
        seq: p.seq != null ? String(p.seq) : '',
        priority: p.priority || '',
        from_code: p.from_code || '', to_code: p.to_code || '',
        confirmation: p.confirmation || '',
        status: 'open',
        source: text,
        notes: p.notes || '',
        created: now, updated: now,
      };

      // A stop inside a tour takes the tour's day
      if (item.parent_id && !item.day) {
        const parent = findRow('Items', item.parent_id);
        if (parent) item.day = parent.obj.day || '';
      }

      // Same place already saved to this trip? Return it instead of a duplicate.
      // (Tour stops are allowed to repeat places saved elsewhere.)
      if (item.place_id && !item.parent_id) {
        const dupe = readTable('Items').filter(function (i) {
          return i.place_id === item.place_id && i.trip_id === tripId && !i.parent_id;
        })[0];
        if (dupe) { dupe._duplicate = true; return dupe; }
      }
      fillAirports(item, item);
      if (!p.title && !text && (item.from_code || item.to_code)) item.title = [item.from_code, item.to_code].filter(String).join(' → ');
      appendObj('Items', item);
      return item;
    });
  },

  /* ---------------- Travelogue ---------------- */

  /** Log a stop. Links to a planned item if one matches (by item, Google place, or within ~75 m). */
  addLog: function (p) {
    return withLock(function () {
      const id = p.id ? String(p.id) : newId('lg');
      const existing = findRow('Log', id);
      if (existing) return existing.obj;

      const tripId = String(p.trip || '');
      const now = new Date().toISOString();
      let item = null;
      if (p.item_id) { const f = findRow('Items', p.item_id); item = f ? f.obj : null; }

      let r = {};
      if (!item && p.place_id) {
        // a place picked from "Around you": the app already has its details
        r = { title: p.title, lat: num(p.lat), lng: num(p.lng), place_id: String(p.place_id),
              address: p.address || '', city: p.city || '', maps_url: p.maps_url || '' };
      } else if (item) {
        r = { title: item.title, lat: item.lat, lng: item.lng, place_id: item.place_id,
              address: item.address, maps_url: item.maps_url, city: item.city };
      } else if (p.text) {
        r = resolveText(String(p.text));
      }
      // A typed name logged with the phone's location keeps that location
      if ((r.lat === undefined || r.lat === '') && p.lat !== undefined && p.lat !== '') { r.lat = +p.lat; r.lng = +p.lng; }

      let origin = item ? 'planned' : 'found';
      if (!item) {
        const items = readTable('Items').filter(function (i) { return i.trip_id === tripId; });
        let match = r.place_id ? items.filter(function (i) { return i.place_id === r.place_id; })[0] : null;
        if (!match && r.lat !== undefined && r.lat !== '') {
          let best = null, bestD = 75;
          items.forEach(function (i) {
            if (i.lat === '' || i.lng === '') return;
            // a Google place you picked is that place: never swap it for a different saved place next door
            // (Melabúðin got logged as Brauð & Co, 35 m away, Oct 2026)
            if (r.place_id && i.place_id && i.place_id !== r.place_id) return;
            const d = metersBetween(+r.lat, +r.lng, +i.lat, +i.lng);
            if (d < bestD) { best = i; bestD = d; }
          });
          match = best;
        }
        if (match) { item = match; origin = 'planned'; }
      }

      const log = {
        id: id, trip_id: tripId, item_id: item ? item.id : '',
        parent_id: p.parent_id || '', day: p.day || '', seq: p.seq != null ? String(p.seq) : '',
        time: p.time || '', mode: p.mode || '',
        title: p.title || r.title || (item && item.title) || p.text || 'Somewhere',
        place_id: r.place_id || '', lat: r.lat != null ? r.lat : '', lng: r.lng != null ? r.lng : '',
        address: r.address || '', city: r.city || '', maps_url: r.maps_url || '',
        origin: origin, note: p.note || '', would_return: p.would_return || '',
        category: p.category || (item && item.category) || r.category || '',
        logged_at: p.logged_at || now, timezone: p.timezone || '', created: now, updated: now,
        here_lat: p.here_lat != null ? String(p.here_lat) : '', here_lng: p.here_lng != null ? String(p.here_lng) : '',
      };
      if (log.here_lat && headersOf(sheet('Log')).indexOf('here_lat') < 0) setup();   // old Sheet: add the new columns
      appendObj('Log', log);
      if (item && item.status !== 'done') updateRow('Items', item.id, { status: 'done', updated: now });
      return log;
    });
  },

  updateLog: function (p) {
    return withLock(function () {
      const patch = parsePatch(p.patch);
      patch.updated = new Date().toISOString();
      return updateRow('Log', p.id, patch);
    });
  },

  deleteLog: function (p) {
    return withLock(function () {
      const f = findRow('Log', p.id);
      if (!f) return { id: p.id };
      const itemId = f.obj.item_id;
      deleteRow('Log', p.id);
      // Its photos, sounds and souvenirs go too (files to the Drive trash, so they can still be recovered)
      if (hasTab('Artifacts')) readTable('Artifacts').filter(function (a) { return a.log_id === String(p.id); })
        .forEach(function (a) { trashFile(a.file_id); deleteRow('Artifacts', a.id); });
      // If nothing else logs that planned item, mark it open again
      if (itemId && !readTable('Log').some(function (l) { return l.item_id === itemId; })) {
        try { updateRow('Items', itemId, { status: 'open', updated: new Date().toISOString() }); } catch (e) {}
      }
      return { id: p.id };
    });
  },

  /** Keep a photo, sound or souvenir with a logged stop. The file (b64) goes to Drive; the row to Artifacts. */
  upload: function (p) {
    if (!hasTab('Artifacts')) setup();
    const id = String(p.id || newId('ar'));
    const existing = findRow('Artifacts', id);
    if (existing) return existing.obj;
    const kind = ['photo', 'sound', 'souvenir'].indexOf(p.kind) >= 0 ? p.kind : 'photo';
    const log = p.log_id ? findRow('Log', p.log_id) : null;
    const tripId = String(p.trip || (log && log.obj.trip_id) || '');
    let fileId = '', mime = String(p.mime || '');
    if (p.b64) {
      const bytes = Utilities.base64Decode(String(p.b64));
      const ext = /png/.test(mime) ? 'png' : /jpe?g/.test(mime) ? 'jpg' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /webm/.test(mime) ? 'webm' : /ogg/.test(mime) ? 'ogg' : 'bin';
      const when = (log && (log.obj.day || String(log.obj.logged_at).slice(0, 10))) || Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
      const name = [when, (log && log.obj.title) || p.title || 'Stop', kind === 'souvenir' ? (p.title || 'souvenir') : kind]
        .join(' · ').replace(/[\/:*?"<>|]/g, '-').slice(0, 120) + '.' + ext;
      const file = tripFolder(tripId).createFile(Utilities.newBlob(bytes, mime || 'application/octet-stream', name));
      fileId = file.getId();
    }
    const now = new Date().toISOString();
    const row = { id: id, log_id: String(p.log_id || ''), trip_id: tripId, kind: kind, title: p.title || '', note: p.note || '',
      file_id: fileId, mime: fileId ? mime : '', duration: p.duration || '', seq: p.seq != null ? String(p.seq) : '', created: now, updated: now };
    withLock(function () { if (!findRow('Artifacts', id)) appendObj('Artifacts', row); });
    return row;
  },

  /** A kept file, read back privately through the script: { mime, b64 }. */
  file: function (p) {
    const f = findRow('Artifacts', p.id);
    if (!f || !f.obj.file_id) throw new Error('No file for that');
    const blob = DriveApp.getFileById(f.obj.file_id).getBlob();
    return { mime: f.obj.mime || blob.getContentType(), b64: Utilities.base64Encode(blob.getBytes()) };
  },

  updateArtifact: function (p) {
    return withLock(function () {
      const patch = parsePatch(p.patch);
      ['file_id', 'mime', 'log_id', 'trip_id', 'kind'].forEach(function (k) { delete patch[k]; });
      patch.updated = new Date().toISOString();
      return updateRow('Artifacts', p.id, patch);
    });
  },

  deleteArtifact: function (p) {
    const f = findRow('Artifacts', p.id);
    if (!f) return { id: p.id };
    trashFile(f.obj.file_id);
    withLock(function () { deleteRow('Artifacts', p.id); });
    return { id: p.id };
  },

  /** Save a new order: ids in order → seq 0, 1, 2… */
  reorder: function (p) {
    return withLock(function () {
      const sheetName = p.sheet === 'Log' ? 'Log' : 'Items';
      const ids = Array.isArray(p.ids) ? p.ids : String(p.ids || '').split(',');
      ids.filter(String).forEach(function (id, i) {
        try { updateRow(sheetName, id, { seq: String(i) }); } catch (e) {}
      });
      return { ok: true };
    });
  },

  /** Routed lines between points, cached in the Routes tab so each leg is only paid for once. */
  routes: function (p) {
    const legs = Array.isArray(p.legs) ? p.legs : parsePatch(p.legs);
    const key = PropertiesService.getScriptProperties().getProperty('PLACES_KEY');
    const cache = {};
    readTable('Routes').forEach(function (r) { cache[r.key] = r; });
    const fresh = [];
    const out = (legs || []).map(function (leg) {
      const k = routeKey(leg);
      if (cache[k]) return { polyline: cache[k].polyline, duration: cache[k].duration, distance: cache[k].distance };
      if (!key) return null;
      try {
        const r = computeRoute(leg, key);
        if (r) { cache[k] = r; fresh.push({ key: k, polyline: r.polyline, duration: r.duration, distance: r.distance, created: new Date().toISOString() }); }
        return r;
      } catch (e) { return { error: String(e.message || e) }; }
    });
    if (fresh.length) withLock(function () { fresh.forEach(function (r) { appendObj('Routes', r); }); });
    return out;
  },

  /** Places right around a spot, closest first (the "Around you" list in I'm here). */
  nearby: function (p) {
    const key = PropertiesService.getScriptProperties().getProperty('PLACES_KEY');
    const lat = num(p.lat), lng = num(p.lng);
    if (!key || lat === '' || lng === '') return [];
    return placesNearby(lat, lng, Math.min(num(p.radius) || 80, 1500), key);
  },

  /** For the "I'm here" Shortcut: log to today's trip, in one request. Either a place shared from Google Maps
      (text=the link) or where the phone is (lat, lng). Stamped with the moment it arrives.
      GET ?action=here&token=…&format=text&(text=…|lat=…&lng=…)[&note=…][&trip=…] */
  here: function (p) {
    let lat = num(p.lat), lng = num(p.lng);
    // a shared Google Maps link: look the place up first
    let shared = null;
    if (p.text && /https?:\/\//.test(String(p.text))) {
      shared = resolveText(String(p.text));
      if (shared.lat !== undefined && shared.lat !== '') { lat = num(shared.lat); lng = num(shared.lng); }
    }
    if (lat === '' || lng === '') {
      if (!shared) throw new Error('No location came through');
      // say why, so a failure can be traced from the notification alone
      const why = shared.lookup_error ? 'lookup said: ' + shared.lookup_error
        : shared.expanded && shared.expanded !== String(p.text).match(/https?:\/\/\S+/)[0] ? 'it led to ' + String(shared.expanded).slice(0, 160)
        : 'the link didn’t open';
      throw new Error('Couldn’t find where that link points (' + why + ')');
    }
    // the trip happening today (a day either side counts, for travel days)
    let trip = null, day = '';
    readTable('Trips').forEach(function (t) {
      if (trip || !t.start) return;
      if (p.trip && t.id !== p.trip) return;
      const today = Utilities.formatDate(new Date(), t.timezone || 'UTC', 'yyyy-MM-dd');
      if (today >= shiftDay(t.start, -1) && today <= shiftDay(t.end || t.start, 1)) { trip = t; day = today; }
    });
    if (!trip) return 'No trip is happening today, so nothing was logged.';
    const tz = trip.timezone || 'UTC';
    const nowIso = new Date().toISOString(), time = Utilities.formatDate(new Date(), tz, 'HH:mm');

    // standing at (or sharing) something already saved to the trip?
    let item = null, best = shared ? 40 : 60;
    readTable('Items').forEach(function (i) {
      if (i.trip_id !== trip.id || i.kind === 'fixed' && /^(flight|stay)$/i.test(i.category)) return;
      if (shared && shared.place_id && i.place_id === shared.place_id) { item = i; best = -1; return; }
      if (best < 0 || i.lat === '' || i.lng === '') return;
      const d = metersBetween(lat, lng, +i.lat, +i.lng);
      if (d < best) { best = d; item = i; }
    });
    let place = shared && shared.title ? { place_id: shared.place_id || '', title: shared.title, lat: lat, lng: lng,
      address: shared.address || '', city: shared.city || '', maps_url: shared.maps_url || '', category: shared.category || '' } : null;
    // Places Google lists around you, closest first (the same name twice counts once)
    let around = [];
    if (!item && !place) {
      const key = PropertiesService.getScriptProperties().getProperty('PLACES_KEY');
      if (key) { try { around = placesNearby(lat, lng, 60, key); } catch (e) {} }
      const seen = {};
      around = around.filter(function (n) { const k = String(n.title).toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; });
    }
    // The shortcut sends back the one you chose from its list
    const PIN = '📍 ', JUST = PIN + 'Just this spot';
    let picked = String(p.pick || '').trim(), justHere = false;
    if (picked) {
      if (picked === JUST.trim() || picked === JUST) justHere = true;
      else {
        const want = picked.replace(/^📍\s*/, '');
        place = around.filter(function (n) { return n.title === want; })[0] || null;
      }
    }
    // A close call (two or more places about equally near) and the shortcut can ask: send it the list instead of guessing
    const closeCall = !item && !place && !picked && p.ask && around.length >= 2 && (around[1].dist - around[0].dist) < 25;
    if (!item && !place && !justHere && !closeCall) place = around[0] || null;
    // nothing listed here: name the spot by its street, else neighbourhood, else town (as the app's "Just this spot")
    let spot = null;
    if (!item && !place && !closeCall) spot = spotName(lat, lng);
    const title = item ? item.title : place ? place.title : spot ? spot.title : 'Somewhere';

    // a second tap at the same spot within half an hour doesn't log twice. Checked and written under one lock,
    // so taps that arrive together (a double or triple tap) can't each slip past the check.
    return withLock(function () {
    const today = readTable('Log').filter(function (l) { return l.trip_id === trip.id && l.day === day && !l.parent_id; });
    const last = today.sort(function (a, b) { return (+a.seq || 0) - (+b.seq || 0); }).slice(-1)[0];
    if (last && (Date.now() - new Date(last.logged_at).getTime()) < 30 * 60000 &&
        ((item && last.item_id === item.id) || (place && last.place_id === place.place_id) ||
         (last.lat !== '' && metersBetween(lat, lng, +last.lat, +last.lng) < 40))) {
      return 'Already logged ' + last.title + '.';
    }
    if (closeCall) {
      // one line per choice; every line starts with 📍 so the shortcut knows this is a list, not a result
      return around.slice(0, 6).map(function (n) { return PIN + n.title; }).concat([JUST]).join('\n');
    }

    const log = ACTIONS.addLog({
      trip: trip.id, day: day, seq: today.length, time: time, timezone: tz, logged_at: nowIso, note: p.note || '',
      item_id: item ? item.id : undefined,
      place_id: place ? place.place_id : undefined, title: place ? place.title : (item ? undefined : title),
      lat: place ? place.lat : lat, lng: place ? place.lng : lng,
      here_lat: shared ? undefined : lat, here_lng: shared ? undefined : lng,
      address: place ? place.address : '', city: place ? place.city : spot ? spot.city : '', maps_url: place ? place.maps_url : '',
      category: place ? place.category : '',
    });
    return 'Logged ' + log.title + ' (' + trip.name + ').';
    });
  },

  /** The one-tap shortcuts (On my way, Wandering, Back at the hotel), the same as the app's bottom bar.
      POST {action:'quick', token, format:'text', what:'onway'|'wander'|'home'}. Logs to the trip happening today;
      until 4am counts as last night, like the app. Returns a sentence for the shortcut's notification. */
  quick: function (p) {
    const what = String(p.what || '').toLowerCase().replace(/[^a-z]/g, '');
    const kind = /^(onway|onmyway|leaving|leave)$/.test(what) ? 'onway' : /^(wander|wandering)$/.test(what) ? 'wander'
      : /^(home|hotel|back|backathotel|stay)$/.test(what) ? 'home' : '';
    if (!kind) throw new Error('Unknown shortcut: ' + (p.what || 'nothing') + ' (use onway, wander or home)');
    const now = new Date();
    // the trip happening today (a day either side counts, for travel days)
    let trip = null, day = '', time = '';
    readTable('Trips').forEach(function (t) {
      if (trip || !t.start) return;
      if (p.trip && t.id !== p.trip) return;
      const tz = t.timezone || 'UTC', hm = Utilities.formatDate(now, tz, 'HH:mm');
      let d = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
      if (hm < '04:00') d = shiftDay(d, -1);   // until 4am it's still last night
      if (d >= shiftDay(t.start, -1) && d <= shiftDay(t.end || t.start, 1)) { trip = t; day = d; time = hm; }
    });
    if (!trip) return 'No trip is happening today, so nothing was logged.';
    const tz = trip.timezone || 'UTC', clock = quickClock(time);

    return withLock(function () {
      const seqOf = function (l) { return l.seq === '' || l.seq == null ? 9999 : +l.seq; };
      const isMarker = function (l) { return (l.category === 'Wandering' || l.category === 'Leaving') && (l.lat === '' || l.lat == null); };
      const logs = readTable('Log').filter(function (l) { return l.trip_id === trip.id && l.day === day && l.category !== 'Totals'; });
      const tops = logs.filter(function (l) { return !l.parent_id; }).sort(function (a, b) { return seqOf(a) - seqOf(b); });
      const last = tops[tops.length - 1];
      const recent = function (cat) {
        return logs.some(function (l) { return l.category === cat && (now - new Date(l.logged_at || l.created).getTime()) < 3 * 60000; });
      };
      const seqs = tops.map(seqOf).filter(function (x) { return x < 9999; });
      const seq = tops.length ? Math.max.apply(null, seqs.concat([-1])) + 1 : 0;
      const base = { trip: trip.id, day: day, seq: seq, time: time, timezone: tz, logged_at: now.toISOString() };

      if (kind === 'onway') {
        if (last && last.category === 'Leaving' && isMarker(last)) return 'Already on your way since ' + quickClock(last.time) + '.';
        if (recent('Leaving')) return 'Already got that.';
        const from = tops.slice().reverse().filter(function (l) { return !isMarker(l); })[0];
        ACTIONS.addLog(Object.assign(base, { title: 'On my way', category: 'Leaving' }));
        return 'Left ' + (from ? from.title : 'there') + ' at ' + clock + '.';
      }
      if (kind === 'wander') {
        if (last && last.category === 'Wandering' && isMarker(last)) return 'Already wandering since ' + quickClock(last.time) + '.';
        if (recent('Wandering')) return 'Already got that.';
        ACTIONS.addLog(Object.assign(base, { title: 'Out wandering', category: 'Wandering' }));
        return 'Out wandering from ' + clock + '.';
      }
      // home: tonight's stay, else last night's
      const stays = readTable('Items').filter(function (i) {
        return i.trip_id === trip.id && i.kind === 'fixed' && !i.parent_id && /^(stay|hotel|lodging|airbnb|hostel)$/i.test(i.category || '');
      });
      const night = function (d) {
        return stays.filter(function (i) { return i.day && i.day <= d && (i.end_day ? d < i.end_day : d === i.day); })[0];
      };
      const st = night(day) || night(shiftDay(day, -1));
      if (!st) return 'No stay is booked for tonight on ' + trip.name + ', so nothing was logged.';
      const lastStop = tops.slice().reverse().filter(function (l) { return !isMarker(l); })[0];
      if (lastStop && lastStop.item_id === st.id) return 'Already back at ' + st.title + '.';
      ACTIONS.addLog(Object.assign(base, { item_id: st.id, category: st.category || 'Stay' }));
      return 'Back at ' + st.title + ', ' + clock + '.';
    });
  },

  /** Preview a link without saving (used by the capture sheet). */
  resolve: function (p) { return resolveText(String(p.text || '')); },

  updateItem: function (p) {
    const patch = parsePatch(p.patch);
    // A pasted Maps link sets where this is (a tour's pickup, an event's venue) without renaming it.
    // Looked up before taking the Sheet's lock, so other saves don't wait on Google.
    if (patch._link) {
      const r = resolveText(String(patch._link));
      LOCATION_FIELDS.forEach(function (k) { if (r[k] != null && r[k] !== '') patch[k] = r[k]; });
      if (!r.place_id && r.maps_url) patch.maps_url = r.maps_url;
    }
    delete patch._link;
    return withLock(function () {
      patch.updated = new Date().toISOString();
      const cur = findRow('Items', p.id);
      if (cur && ('from_code' in patch || 'to_code' in patch)) fillAirports(Object.assign({}, cur.obj, patch), patch, cur.obj);
      return updateRow('Items', p.id, patch);
    });
  },

  deleteItem: function (p) {
    return withLock(function () {
      // Stops inside a deleted tour stay saved, just no longer nested
      const now = new Date().toISOString();
      readTable('Items').filter(function (i) { return i.parent_id === p.id; })
        .forEach(function (i) { updateRow('Items', i.id, { parent_id: '', updated: now }); });
      deleteRow('Items', p.id);
      return { id: p.id };
    });
  },

  /** Move many items at once (e.g. Someday → a new trip). */
  attach: function (p) {
    return withLock(function () {
      const ids = Array.isArray(p.ids) ? p.ids : String(p.ids || '').split(',');
      const tripId = p.trip_id === 'someday' ? '' : String(p.trip_id || '');
      const now = new Date().toISOString();
      return ids.filter(String).map(function (id) {
        return updateRow('Items', id, { trip_id: tripId, updated: now });
      });
    });
  },

  addTrip: function (p) {
    return withLock(function () {
      const t = parsePatch(p.trip);
      const now = new Date().toISOString();
      const trip = {
        id: t.id || newId('tr'),
        name: t.name || 'New trip',
        destination: t.destination || '',
        start: t.start || '', end: t.end || '',
        timezone: t.timezone || '',
        notes: t.notes || '',
        created: now, updated: now,
      };
      if (findRow('Trips', trip.id)) return findRow('Trips', trip.id).obj;
      appendObj('Trips', trip);
      return trip;
    });
  },

  updateTrip: function (p) {
    return withLock(function () {
      const patch = parsePatch(p.patch);
      patch.updated = new Date().toISOString();
      return updateRow('Trips', p.id, patch);
    });
  },

  /** Deleting a trip sends its items back to Someday rather than deleting them. */
  deleteTrip: function (p) {
    return withLock(function () {
      const now = new Date().toISOString();
      readTable('Items').filter(function (i) { return i.trip_id === p.id; })
        .forEach(function (i) { updateRow('Items', i.id, { trip_id: '', day: '', updated: now }); });
      deleteRow('Trips', p.id);
      return { id: p.id };
    });
  },

  /** Re-run the Google lookup for an item (e.g. to refresh hours). */
  refreshItem: function (p) {
    // Ask Google first, without holding the Sheet: a lookup takes seconds, and other saves shouldn't wait on it
    const row = findRow('Items', p.id);
    if (!row) throw new Error('Not found: ' + p.id);
    const src = row.obj.maps_url || row.obj.source || row.obj.title;
    const r = resolveText(src);
    return withLock(function () {
      if (!findRow('Items', p.id)) throw new Error('Not found: ' + p.id);
      const patch = { updated: new Date().toISOString() };
      LOCATION_FIELDS.forEach(function (k) { if (r[k] != null && r[k] !== '') patch[k] = r[k]; });
      return updateRow('Items', p.id, patch);
    });
  },

  /** Re-run the Google lookup for saved places missing newer details. A few at a time; call until remaining is 0. */
  refreshAll: function (p) {
    const tripId = p.trip === 'someday' ? '' : String(p.trip || '');
    const todo = readTable('Items').filter(function (i) {
      return i.trip_id === tripId && i.maps_url && !i.types && i.kind !== 'fixed';
    });
    const batch = todo.slice(0, 15);
    const updated = batch.map(function (i) {
      try {
        const r = resolveText(i.maps_url);
        const patch = { updated: new Date().toISOString(), types: r.types || '-' };
        LOCATION_FIELDS.forEach(function (k) { if (r[k] != null && r[k] !== '') patch[k] = r[k]; });
        return withLock(function () { return updateRow('Items', i.id, patch); });
      } catch (e) { return null; }
    }).filter(Boolean);
    return { updated: updated, remaining: todo.length - batch.length };
  },

  /** Google's one-line description for places that don't have one yet. A few at a time; call until remaining is 0.
   *  Asks Google for that one field only (it's a top-tier field, so it's kept separate from the everyday lookups). */
  fillSummaries: function (p) {
    const key = PropertiesService.getScriptProperties().getProperty('PLACES_KEY');
    if (!key) return { updated: [], remaining: 0 };
    // Without the column the answers couldn't be kept, and every sync would ask Google again
    if (headersOf(sheet('Items')).indexOf('summary') === -1) throw new Error('Run setup to add the summary column');
    const tripId = p.trip === 'someday' ? '' : String(p.trip || '');
    const todo = readTable('Items').filter(function (i) {
      return i.trip_id === tripId && i.kind === 'place' && i.place_id && !i.summary;
    });
    const batch = todo.slice(0, 15);
    const updated = batch.map(function (i) {
      let text = '-';
      try {
        const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(i.place_id), {
          headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'editorialSummary' }, muteHttpExceptions: true });
        if (res.getResponseCode() >= 400) return null;   // try again another time
        const j = JSON.parse(res.getContentText());
        if (j.editorialSummary && j.editorialSummary.text) text = j.editorialSummary.text;
      } catch (e) { return null; }
      return withLock(function () { return updateRow('Items', i.id, { summary: text }); });
    }).filter(Boolean);
    return { updated: updated, remaining: todo.length - updated.length };
  },

  /* ---------------- Chapters + review links ---------------- */

  addChapter: function (p) {
    return withLock(function () {
      const c = parsePatch(p.chapter);
      if (c.id && findRow('Chapters', c.id)) return findRow('Chapters', c.id).obj;
      const now = new Date().toISOString();
      const ch = { id: c.id || newId('ch'), trip_id: c.trip_id || '', name: c.name || 'Chapter', start: c.start || '', end: c.end || '',
                   radius_km: c.radius_km != null ? String(c.radius_km) : '', created: now, updated: now };
      appendObj('Chapters', ch);
      return ch;
    });
  },

  updateChapter: function (p) {
    return withLock(function () {
      const patch = parsePatch(p.patch);
      patch.updated = new Date().toISOString();
      return updateRow('Chapters', p.id, patch);
    });
  },

  /** Deleting a chapter turns off its review links. Items are never touched (a chapter is only a view). */
  deleteChapter: function (p) {
    return withLock(function () {
      const now = new Date().toISOString();
      readTable('Shares').filter(function (s) { return s.chapter_id === p.id && !s.revoked; })
        .forEach(function (s) { updateRow('Shares', s.id, { revoked: now }); });
      deleteRow('Chapters', p.id);
      return { id: p.id };
    });
  },

  addShare: function (p) {
    return withLock(function () {
      const s = parsePatch(p.share);
      if (s.id && findRow('Shares', s.id)) return findRow('Shares', s.id).obj;
      if (!s.token || String(s.token).length < 16) throw new Error('A review link needs a longer token');
      const sh = { id: s.id || newId('sh'), token: String(s.token), trip_id: s.trip_id || '', chapter_id: s.chapter_id || '',
                   who: s.who || '', created: new Date().toISOString(), revoked: '' };
      appendObj('Shares', sh);
      return sh;
    });
  },

  revokeShare: function (p) {
    return withLock(function () { return updateRow('Shares', p.id, { revoked: new Date().toISOString() }); });
  },

  /** Keep something from the review inbox: it becomes a place (or an idea for a non-Maps link) on the trip. */
  keepInbox: function (p) {
    return withLock(function () {
      const row = findRow('Inbox', p.id);
      if (!row) throw new Error('Not found: ' + p.id);
      const b = row.obj;
      if (b.item_id && findRow('Items', b.item_id)) return { inbox: b, item: findRow('Items', b.item_id).obj };
      const share = findRow('Shares', b.share_id);
      const who = share ? share.obj.who : '';
      const now = new Date().toISOString();
      const item = {
        id: p.item_id || newId('it'), trip_id: b.trip_id, kind: b.kind === 'place' ? 'place' : 'idea',
        category: b.category, title: b.title || b.text || 'Untitled', city: b.city, address: b.address,
        lat: b.lat, lng: b.lng, place_id: b.place_id, maps_url: b.maps_url, website: b.website, types: b.types, hours: b.hours,
        status: 'open', source: b.text,
        notes: [b.kind === 'link' && b.note ? b.note : '', who ? 'From ' + who + (b.kind !== 'link' && b.note ? ': ' + b.note : '') : b.note].filter(String).join('\n\n'),
        created: now, updated: now,
      };
      appendObj('Items', item);
      const inbox = updateRow('Inbox', b.id, { status: 'kept', item_id: item.id, updated: now });
      return { inbox: inbox, item: item };
    });
  },

  dismissInbox: function (p) {
    return withLock(function () { return updateRow('Inbox', p.id, { status: 'dismissed', updated: new Date().toISOString() }); });
  },
};

/* ---------------------------------------------------------------
 * Review links (a chapter shared with someone)
 * ------------------------------------------------------------- */
function shareByToken(token) {
  if (!hasTab('Shares') || !token || String(token).length < 16) return null;
  return readTable('Shares').filter(function (s) { return s.token === String(token) && !s.revoked; })[0] || null;
}

const isStayItem = function (i) { return i.kind === 'fixed' && /^(stay|hotel|lodging|airbnb|hostel)$/i.test(i.category || ''); };
const foldText = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); };

/** The trip's stays with a night inside the chapter (checking in on its last day doesn't count: that's the next leg). */
function chapterStays(items, ch) {
  return items.filter(function (i) {
    if (!isStayItem(i) || i.parent_id || !i.day) return false;
    const out = i.end_day || i.day;
    if (ch.start && ch.end && ch.start === ch.end) return i.day <= ch.end && out >= ch.start;
    return (!ch.end || i.day < ch.end) && (!ch.start || out > ch.start);
  });
}

/** Is an item part of a chapter? Dated things by date; undated places near where you stay then; undated notes and ideas always. */
function inChapter(i, ch, byId, stays) {
  if (i.parent_id && byId[i.parent_id]) return inChapter(byId[i.parent_id], ch, byId, stays);
  if (i.day) return (!ch.end || i.day <= ch.end) && (!ch.start || (i.end_day || i.day) >= ch.start);
  const r = (Number(ch.radius_km) || 25) * 1000;
  const lat = Number(i.lat), lng = Number(i.lng);
  const withCoords = stays.filter(function (s) { return s.lat !== '' && s.lng !== '' && !isNaN(Number(s.lat)); });
  if (i.lat !== '' && i.lng !== '' && !isNaN(lat) && !isNaN(lng) && withCoords.length) {
    return withCoords.some(function (s) { return metersBetween(lat, lng, Number(s.lat), Number(s.lng)) <= r; });
  }
  if (i.city) {
    const cities = stays.map(function (s) { return foldText(s.city); }).filter(String);
    return !cities.length || cities.indexOf(foldText(i.city)) !== -1;
  }
  return true;
}

/** Only what's meant for both of you: Claude's notes, never yours. */
function sharedNote(i) {
  const n = String(i.notes || '');
  if (i.source === 'claude') return n.split(/\n\s*\n/)[0].trim();
  if (/^from:/.test(i.source || '')) return n.trim();   // their own idea: they wrote it
  const m = n.match(/(?:^|\n)Claude:\s*([\s\S]*)$/);
  return m ? m[1].trim() : '';
}

function reviewScope(sh) {
  const trip = readTable('Trips').filter(function (t) { return t.id === sh.trip_id; })[0];
  if (!trip) throw new Error('This trip is no longer there');
  const chapter = sh.chapter_id && hasTab('Chapters') ? readTable('Chapters').filter(function (c) { return c.id === sh.chapter_id; })[0] : null;
  const ch = chapter || { name: trip.name, start: trip.start, end: trip.end, radius_km: '' };
  const all = readTable('Items').filter(function (i) { return i.trip_id === trip.id; });
  const byId = {}; all.forEach(function (i) { byId[i.id] = i; });
  const stays = chapterStays(all, ch);
  const items = all.filter(function (i) {
    if (!inChapter(i, ch, byId, stays)) return false;
    // Claude's suggestions under your ideas stay yours until you keep them; under their own asks they're shared
    if (i.parent_id && byId[i.parent_id] && byId[i.parent_id].kind === 'idea') return /^from:/.test(byId[i.parent_id].source || '');
    return true;
  });
  return { trip: trip, ch: ch, items: items, byId: byId, stays: stays };
}

function reviewPayload(sh) {
  const S = reviewScope(sh);
  const keep = ['id', 'kind', 'category', 'title', 'city', 'address', 'lat', 'lng', 'place_id', 'maps_url', 'website', 'hours',
                'day', 'end_day', 'start_time', 'end_time', 'priority', 'parent_id', 'seq', 'status', 'from_code', 'to_code', 'types',
                'summary', 'blurb'];
  const items = S.items.map(function (i) {
    const o = {}; keep.forEach(function (k) { o[k] = i[k]; });
    o.note = sharedNote(i);
    o.mine = /^from:/.test(i.source || '');
    return o;
  });
  const reactions = {};
  if (hasTab('Reactions')) readTable('Reactions').forEach(function (r) { if (r.share_id === sh.id) reactions[r.item_id] = r.answer; });
  const added = hasTab('Inbox') ? readTable('Inbox').filter(function (b) { return b.share_id === sh.id; }).map(function (b) {
    const it = b.item_id ? S.byId[b.item_id] : null;
    return { id: b.id, kind: b.kind, title: b.title, text: b.text, status: b.status, item_id: b.item_id, created: b.created,
             answered: it && it.kind === 'idea' ? it.status === 'answered' : false,
             reply: it && it.kind === 'idea' ? sharedNote(it).replace(/^[\s\S]*?(?:^|\n)Claude:\s*/, '') : '' };
  }) : [];
  return {
    who: sh.who, trip: { name: S.trip.name, timezone: S.trip.timezone },
    chapter: { name: S.ch.name, start: S.ch.start || S.trip.start, end: S.ch.end || S.trip.end },
    items: items, reactions: reactions, added: added,
  };
}

function reviewReact(p, sh) {
  const answer = String(p.answer || '');
  if (['plan', 'nearby', 'pass', 'later', ''].indexOf(answer) === -1) throw new Error('Unknown answer');
  const S = reviewScope(sh);
  if (!S.items.some(function (i) { return i.id === p.item_id; })) throw new Error('That isn’t part of this link');
  return withLock(function () {
    const now = new Date().toISOString();
    const cur = readTable('Reactions').filter(function (r) { return r.share_id === sh.id && r.item_id === p.item_id; })[0];
    if (cur) return updateRow('Reactions', cur.id, { answer: answer, updated: now });
    const row = { id: newId('re'), share_id: sh.id, item_id: String(p.item_id), answer: answer, created: now, updated: now };
    appendObj('Reactions', row);
    return row;
  });
}

/** A link or an idea from a review link. A place you already have counts as a boost; everything else waits in your inbox. */
function reviewSuggest(p, sh) {
  const text = String(p.text || '').trim().slice(0, 2000);
  if (!text) throw new Error('Nothing to send');
  const id = /^ib_[a-z0-9]{6,20}$/.test(String(p.id || '')) ? String(p.id) : newId('ib');
  const prior = findRow('Inbox', id);
  if (prior) return prior.obj;   // sent twice from the phone's queue
  const now = new Date().toISOString();
  const url = (text.match(/https?:\/\/[^\s<>"]+/) || [])[0];
  const note = text.replace(/https?:\/\/\S+/g, '').trim();
  const row = { id: id, share_id: sh.id, trip_id: sh.trip_id, text: text, note: url ? note : '', status: 'new', created: now, updated: now };

  if (!url) {
    // An idea: it goes straight onto the trip with Ask Claude on, marked as theirs
    return withLock(function () {
      const idea = { id: newId('it'), trip_id: sh.trip_id, kind: 'idea', title: text, status: 'ask',
                     source: 'from:' + (sh.who || 'review'), notes: '', created: now, updated: now };
      appendObj('Items', idea);
      Object.assign(row, { kind: 'ask', title: text, status: 'asked', item_id: idea.id });
      appendObj('Inbox', row);
      return row;
    });
  }

  if (isMapsUrl(url)) {
    const r = resolveText(text);
    ['title', 'category', 'city', 'address', 'lat', 'lng', 'place_id', 'maps_url', 'website', 'types', 'hours']
      .forEach(function (k) { if (r[k] != null) row[k] = r[k]; });
    row.kind = 'place';
    if (r.title && note === r.title) row.note = '';
    return withLock(function () {
      const lat = Number(row.lat), lng = Number(row.lng);
      const twin = readTable('Items').filter(function (i) {
        if (i.trip_id !== sh.trip_id || i.parent_id) return false;
        if (row.place_id && i.place_id === row.place_id) return true;
        return row.lat !== undefined && row.lat !== '' && i.lat !== '' && !isNaN(lat) &&
          metersBetween(lat, lng, Number(i.lat), Number(i.lng)) < 40 && foldText(i.title).slice(0, 4) === foldText(row.title).slice(0, 4);
      })[0];
      const sent = readTable('Inbox').filter(function (b) {
        return b.share_id === sh.id && b.status !== 'dismissed' && ((row.place_id && b.place_id === row.place_id) || (twin && b.item_id === twin.id));
      })[0];
      if (sent) return sent;   // already sent this one
      if (twin) { row.status = 'boost'; row.item_id = twin.id; row.title = twin.title; }
      appendObj('Inbox', row);
      return row;
    });
  }

  const pv = linkPreview(url);
  Object.assign(row, { kind: 'link', title: pv.title || note || url.replace(/^https?:\/\/(www\.)?/, '').split(/[\/?#]/)[0],
                       website: url, image: pv.image || '', category: pv.site || '' });
  row.note = [note, pv.description].filter(String).join('\n\n').slice(0, 600);
  return withLock(function () { appendObj('Inbox', row); return row; });
}

/** Title, description and picture a page offers for link previews (Open Graph), else its <title>. */
function linkPreview(url) {
  const out = { title: '', description: '', image: '', site: '' };
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } });
    if (res.getResponseCode() >= 400) return out;
    const html = res.getContentText().slice(0, 300000);
    const metas = html.match(/<meta\b[^>]*>/gi) || [];
    const meta = function (names) {
      for (let k = 0; k < metas.length; k++) {
        const tag = metas[k];
        const nm = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (nm && names.indexOf(nm.toLowerCase()) !== -1) {
          const c = tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i);
          if (c && c[1].trim()) return decodeEntities(c[1].trim());
        }
      }
      return '';
    };
    out.title = meta(['og:title', 'twitter:title']) || decodeEntities(((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '').trim());
    out.description = meta(['og:description', 'twitter:description', 'description']).slice(0, 400);
    out.image = meta(['og:image', 'twitter:image']);
    out.site = meta(['og:site_name']);
  } catch (e) {}
  return out;
}

function decodeEntities(s) {
  return String(s).replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/* ---------------------------------------------------------------
 * Google Maps link → place
 * ------------------------------------------------------------- */
function resolveText(text) {
  text = String(text || '').trim();
  const urlMatch = text.match(/https?:\/\/[^\s<>"]+/);
  const lines = text.split(/\n/).map(function (s) { return s.trim(); }).filter(String);
  const nonUrl = lines.filter(function (l) { return !/^https?:\/\//.test(l); })
    .map(function (l) { return l.replace(/https?:\/\/\S+/g, '').trim(); }).filter(String);

  if (!urlMatch) return { kind: 'idea', title: text };

  const url = urlMatch[0];
  if (!isMapsUrl(url)) {
    // A blog post, menu, article… keep it as an idea with the link
    return { kind: 'idea', title: nonUrl[0] || url, website: url };
  }

  const full = expandUrl(url);
  const parsed = parseMapsUrl(full);
  const out = {
    kind: 'place',
    title: parsed.name || nonUrl[0] || parsed.query || 'Saved place',
    lat: parsed.lat, lng: parsed.lng,
    maps_url: url,
    expanded: full,
  };

  const key = PropertiesService.getScriptProperties().getProperty('PLACES_KEY');
  if (!key) return out;

  let place = null;
  try {
    if (parsed.placeId) place = placeDetails(parsed.placeId, key);
    if (!place) {
      const q = parsed.name || parsed.query || nonUrl.join(', ');
      if (q) place = textSearch(q, parsed.lat, parsed.lng, key);
    }
  } catch (err) {
    out.lookup_error = String(err.message || err);
  }
  return place ? Object.assign(out, fromPlace(place, url)) : out;
}

function isMapsUrl(u) {
  return /(^https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|(www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/i.test(u);
}

function expandUrl(url) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    if (!/maps\.app\.goo\.gl|goo\.gl|g\.co/i.test(cur)) break;
    const res = UrlFetchApp.fetch(cur, { followRedirects: false, muteHttpExceptions: true });
    const h = res.getAllHeaders();
    let loc = h['Location'] || h['location'];
    if (Array.isArray(loc)) loc = loc[0];
    if (!loc) {
      // No redirect header: the address is in the page (a meta refresh, a link, or script)
      const body = res.getContentText().replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      const m = body.match(/https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)[^"'\s<>\\]*/);
      if (m) cur = m[0];
      break;
    }
    cur = /^\//.test(loc) ? cur.replace(/^(https?:\/\/[^\/]+).*$/, '$1') + loc : loc;
  }
  return cur;
}

function parseMapsUrl(u) {
  const r = {};
  let m;
  if ((m = u.match(/\/maps\/place\/([^\/@?]+)/))) r.name = safeDecode(m[1]);
  if ((m = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/))) { r.lat = +m[1]; r.lng = +m[2]; }
  else if ((m = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/))) { r.lat = +m[1]; r.lng = +m[2]; }
  const q = getParam(u, 'q') || getParam(u, 'query');
  if (q) {
    const cm = q.match(/^\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)\s*$/);
    if (cm) { r.lat = +cm[1]; r.lng = +cm[2]; } else r.query = q;
  }
  const pid = getParam(u, 'query_place_id') || getParam(u, 'place_id');
  if (pid) r.placeId = pid;
  return r;
}

function getParam(u, k) {
  const m = u.match(new RegExp('[?&]' + k + '=([^&#]+)'));
  return m ? safeDecode(m[1]) : '';
}

function safeDecode(s) {
  try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s).replace(/\+/g, ' '); }
}

/* ---------------------------------------------------------------
 * Airports: code (e.g. KEF) → name + location, looked up once
 * ------------------------------------------------------------- */
function fillAirports(o, patch, before) {
  ['from', 'to'].forEach(function (side) {
    const code = String(o[side + '_code'] || '').trim().toUpperCase();
    patch[side + '_code'] = code;
    if (!code) { patch[side + '_name'] = ''; patch[side + '_lat'] = ''; patch[side + '_lng'] = ''; return; }
    if (before && before[side + '_code'] === code && before[side + '_lat'] !== '') return;
    const a = airportLookup(code);
    if (a) { patch[side + '_name'] = a.name; patch[side + '_lat'] = a.lat; patch[side + '_lng'] = a.lng; }
  });
}

function airportLookup(code) {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty('AP_' + code);
  if (cached) return JSON.parse(cached);
  const key = props.getProperty('PLACES_KEY');
  if (!key) return null;
  try {
    const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ textQuery: code + ' airport', includedType: 'airport', pageSize: 1 }),
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.displayName,places.location' },
      muteHttpExceptions: true,
    });
    const pl = (JSON.parse(res.getContentText()).places || [])[0];
    if (!pl || !pl.location) return null;
    const a = { name: (pl.displayName && pl.displayName.text) || code, lat: pl.location.latitude, lng: pl.location.longitude };
    props.setProperty('AP_' + code, JSON.stringify(a));
    return a;
  } catch (e) { return null; }
}

/** Run from the editor to check airport lookups. */
function testAirport() { Logger.log(JSON.stringify(airportLookup('KEF'))); }

function textSearch(query, lat, lng, key) {
  const body = { textQuery: query, pageSize: 1 };
  if (lat != null && lng != null) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 500 } };
  }
  const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': PLACE_FIELDS.map(function (f) { return 'places.' + f; }).join(','),
    },
    muteHttpExceptions: true,
  });
  const j = JSON.parse(res.getContentText());
  if (j.error) throw new Error('Places: ' + j.error.message);
  return (j.places || [])[0] || null;
}

/** Name a spot by its street, else its neighbourhood, else the town. Google's own reverse geocoder first
    (built into Apps Script, no key), then OpenStreetMap. Null if both fail. */
function spotName(lat, lng) {
  try {
    const g = Maps.newGeocoder().setLanguage('en').reverseGeocode(+lat, +lng);
    if (g && g.status === 'OK' && g.results && g.results.length) {
      const pick = function (types) {
        for (let r = 0; r < g.results.length; r++) {
          const c = (g.results[r].address_components || []).filter(function (x) {
            return types.some(function (t) { return x.types.indexOf(t) >= 0; });
          })[0];
          if (c) return c.long_name;
        }
        return '';
      };
      const city = pick(['locality', 'postal_town', 'administrative_area_level_3']);
      const title = pick(['route']) || pick(['neighborhood']) || pick(['sublocality', 'sublocality_level_1']) || city;
      if (title) return { title: title, city: city };
    }
  } catch (e) {}
  try {
    const res = UrlFetchApp.fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=en&lat=' +
      (+lat).toFixed(5) + '&lon=' + (+lng).toFixed(5), { muteHttpExceptions: true, headers: { 'User-Agent': 'TravelHub/1.0 (personal trip log)' } });
    if (res.getResponseCode() !== 200) return null;
    const a = JSON.parse(res.getContentText()).address || {};
    const city = a.city || a.town || a.village || a.municipality || '';
    const title = a.road || a.pedestrian || a.footway || a.path || a.square || a.neighbourhood || a.quarter || a.suburb || city;
    return title ? { title: title, city: city } : null;
  } catch (e) { return null; }
}

/** Run this once from the editor to check spot naming: it logs what a tap at (lat, lng) would be called. */
function testSpotName() {
  Logger.log(JSON.stringify(spotName(38.2376, -85.5503)));
}

function placesNearby(lat, lng, radius, key) {
  const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: radius } },
      maxResultCount: 8, rankPreference: 'DISTANCE',
      excludedTypes: ['parking', 'atm', 'bus_stop'],   // Nearby Search only accepts Table A types (no route / street_address)
    }),
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': ['id', 'displayName', 'formattedAddress', 'location', 'primaryTypeDisplayName', 'googleMapsUri', 'addressComponents']
        .map(function (f) { return 'places.' + f; }).join(','),
    },
    muteHttpExceptions: true,
  });
  const j = JSON.parse(res.getContentText());
  if (j.error) throw new Error('Places: ' + j.error.message);
  return (j.places || []).map(function (pl) {
    const f = fromPlace(pl, '');
    return { place_id: f.place_id, title: f.title || 'Unnamed place', category: f.category, address: f.address, city: f.city,
             lat: f.lat, lng: f.lng, maps_url: f.maps_url, dist: Math.round(metersBetween(lat, lng, f.lat, f.lng)) };
  });
}

function num(v) {
  if (v === undefined || v === null || v === '') return '';
  const n = parseFloat(String(v).replace(',', '.'));
  return isFinite(n) ? n : '';
}
/** "23:05" → "11:05pm" (as the app writes times). */
function quickClock(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return String(t || '');
  const h = +m[1], mm = +m[2];
  return ((h % 12) || 12) + (mm ? ':' + m[2] : '') + (h < 12 ? 'am' : 'pm');
}
function shiftDay(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}
function testNearby() { Logger.log(JSON.stringify(ACTIONS.nearby({ lat: 64.1471, lng: -21.9359 }), null, 2)); }

function placeDetails(placeId, key) {
  const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId), {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PLACE_FIELDS.join(',') },
    muteHttpExceptions: true,
  });
  const j = JSON.parse(res.getContentText());
  return j.error ? null : j;
}

function fromPlace(pl, originalUrl) {
  const comp = function (types) {
    const c = (pl.addressComponents || []).filter(function (a) {
      return (a.types || []).some(function (t) { return types.indexOf(t) !== -1; });
    })[0];
    return c ? (c.longText || '') : '';
  };
  const oh = pl.regularOpeningHours;
  return {
    title: (pl.displayName && pl.displayName.text) || undefined,
    place_id: pl.id || '',
    address: pl.formattedAddress || '',
    lat: pl.location ? pl.location.latitude : undefined,
    lng: pl.location ? pl.location.longitude : undefined,
    maps_url: pl.googleMapsUri || originalUrl,
    website: pl.websiteUri || '',
    category: (pl.primaryTypeDisplayName && pl.primaryTypeDisplayName.text) || '',
    city: comp(['locality', 'postal_town']) || comp(['administrative_area_level_2']),
    region: comp(['administrative_area_level_1']),
    country: comp(['country']),
    types: (pl.types || []).filter(function (t) { return t !== 'point_of_interest' && t !== 'establishment'; }).join(','),
    hours: oh ? JSON.stringify({ weekday: oh.weekdayDescriptions || [], periods: oh.periods || [],
                                 utcOffset: pl.utcOffsetMinutes }) : '',
  };
}

/* ---------------------------------------------------------------
 * Routing + distance
 * ------------------------------------------------------------- */
function routeKey(leg) {
  const f = function (n) { return Number(n).toFixed(5); };
  return f(leg.from[0]) + ',' + f(leg.from[1]) + '>' + f(leg.to[0]) + ',' + f(leg.to[1]) + '|' + (leg.mode || 'walk');
}

function computeRoute(leg, key) {
  const body = {
    origin: { location: { latLng: { latitude: +leg.from[0], longitude: +leg.from[1] } } },
    destination: { location: { latLng: { latitude: +leg.to[0], longitude: +leg.to[1] } } },
    travelMode: ROUTE_MODES[leg.mode] || 'WALK',
  };
  const res = UrlFetchApp.fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.duration,routes.distanceMeters',
    },
    muteHttpExceptions: true,
  });
  const j = JSON.parse(res.getContentText() || '{}');
  if (j.error) throw new Error('Routes: ' + j.error.message);
  const r = (j.routes || [])[0];
  if (!r || !r.polyline) return null;
  return { polyline: r.polyline.encodedPolyline, duration: r.duration || '', distance: String(r.distanceMeters || '') };
}

/** Run from the editor to check the Routes API is enabled on your key. */
function testRoutes() {
  const key = PropertiesService.getScriptProperties().getProperty('PLACES_KEY');
  const r = computeRoute({ from: [64.1503, -21.9325], to: [64.1417, -21.9266], mode: 'walk' }, key);
  Logger.log(r ? 'Routes OK — ' + r.distance + ' m, ' + r.duration : 'No route returned');
}

function metersBetween(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = function (d) { return d * Math.PI / 180; };
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------------------------------------------------------------
 * Sheet helpers
 * ------------------------------------------------------------- */
function hasTab(name) { return !!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }

/** Drive: Travel Hub / <trip name>, made on first use and remembered in Script Properties. */
function tripFolder(tripId) {
  const props = PropertiesService.getScriptProperties();
  const get = function (key, make) {
    const fid = props.getProperty(key);
    if (fid) { try { const f = DriveApp.getFolderById(fid); if (!f.isTrashed()) return f; } catch (e) {} }
    const f = make(); props.setProperty(key, f.getId()); return f;
  };
  const root = get('FOLDER_root', function () { return DriveApp.createFolder('Travel Hub'); });
  if (!tripId) return root;
  const trip = readTable('Trips').filter(function (t) { return t.id === tripId; })[0];
  return get('FOLDER_' + tripId, function () { return root.createFolder((trip && trip.name) || tripId); });
}

function trashFile(fileId) {
  if (!fileId) return;
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {}
}

/** Run once from the editor after pasting: asks for Drive permission and makes the Travel Hub folder. */
function testDrive() { Logger.log('Travel Hub folder: ' + tripFolder('').getUrl()); }

function sheet(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '" — run setup()');
  return sh;
}

function headersOf(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function norm(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}

function readTable(name) {
  const sh = sheet(name);
  if (sh.getLastRow() < 2) return [];
  const values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  const hdr = values.shift().map(String);
  return values
    .filter(function (r) { return r.some(function (c) { return c !== ''; }); })
    .map(function (r) {
      const o = {};
      hdr.forEach(function (h, i) { if (h) o[h] = norm(r[i]); });
      return o;
    });
}

function appendObj(name, obj) {
  const sh = sheet(name);
  const hdr = headersOf(sh);
  const row = hdr.map(function (h) { return obj[h] !== undefined && obj[h] !== null ? String(obj[h]) : ''; });
  const r = sh.getLastRow() + 1;
  const range = sh.getRange(r, 1, 1, hdr.length);
  range.setNumberFormat('@');
  range.setValues([row]);
}

function findRow(name, id) {
  if (!id) return null;
  const sh = sheet(name);
  if (sh.getLastRow() < 2) return null;
  const hdr = headersOf(sh);
  const idCol = hdr.indexOf('id');
  const ids = sh.getRange(2, idCol + 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) {
      const rowNum = i + 2;
      const vals = sh.getRange(rowNum, 1, 1, hdr.length).getValues()[0];
      const obj = {};
      hdr.forEach(function (h, k) { if (h) obj[h] = norm(vals[k]); });
      return { sh: sh, hdr: hdr, rowNum: rowNum, obj: obj };
    }
  }
  return null;
}

function updateRow(name, id, patch) {
  const f = findRow(name, id);
  if (!f) throw new Error('Not found: ' + id);
  const obj = Object.assign({}, f.obj);
  Object.keys(patch).forEach(function (k) { if (k !== 'id' && f.hdr.indexOf(k) !== -1) obj[k] = patch[k]; });
  const row = f.hdr.map(function (h) { return obj[h] !== undefined && obj[h] !== null ? String(obj[h]) : ''; });
  f.sh.getRange(f.rowNum, 1, 1, f.hdr.length).setValues([row]);
  return obj;
}

function deleteRow(name, id) {
  const f = findRow(name, id);
  if (f) f.sh.deleteRow(f.rowNum);
}

function parsePatch(x) {
  if (!x) return {};
  if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return {}; } }
  return x;
}

function newId(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

let LOCK_HELD = false;
function withLock(fn) {
  if (LOCK_HELD) return fn();   // already inside a locked step (e.g. here → addLog)
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  LOCK_HELD = true;
  try { return fn(); } finally { LOCK_HELD = false; lock.releaseLock(); }
}
