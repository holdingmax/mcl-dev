// Query bookings with LFD to debug pickup KPI
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');

function findFirebaseToken() {
  const locations = [
    path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'configstore', 'firebase-tools.json'),
    path.join(process.env.APPDATA || '', 'configstore', 'firebase-tools.json'),
  ];
  for (const loc of locations) {
    try {
      if (fs.existsSync(loc)) {
        const config = JSON.parse(fs.readFileSync(loc, 'utf-8'));
        if (config.tokens) return config.tokens;
        if (config.user && config.user.tokens) return config.user.tokens;
        return config;
      }
    } catch (e) { /* skip */ }
  }
  return null;
}

function refreshAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }).toString();
    const options = {
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error('No access_token: ' + data.slice(0, 200)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function firestoreQuery(accessToken, collectionId, filters, orderByFields, limitN) {
  return new Promise((resolve, reject) => {
    const sq = { structuredQuery: { from: [{ collectionId }], limit: limitN || 50 } };
    if (filters && filters.length > 0) {
      sq.structuredQuery.where = { compositeFilter: { op: 'AND', filters } };
    }
    if (orderByFields && orderByFields.length > 0) {
      sq.structuredQuery.orderBy = orderByFields;
    }
    const body = JSON.stringify(sq);
    const options = {
      hostname: 'firestore.googleapis.com',
      path: '/v1/projects/wms-mcl/databases/(default)/documents:runQuery',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + accessToken,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Parse: ' + data.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractVal(field) {
  if (!field) return '';
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.integerValue !== undefined) return Number(field.integerValue);
  if (field.timestampValue !== undefined) return field.timestampValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.arrayValue) return (field.arrayValue.values || []).map(v => extractVal(v));
  if (field.mapValue) {
    const obj = {};
    for (const [k, v] of Object.entries(field.mapValue.fields || {})) obj[k] = extractVal(v);
    return obj;
  }
  return JSON.stringify(field);
}

function parseDocs(results) {
  const docs = [];
  if (!Array.isArray(results)) return docs;
  for (const r of results) {
    if (!r.document) continue;
    const fields = r.document.fields || {};
    const doc = { _id: r.document.name.split('/').pop() };
    for (const [k, v] of Object.entries(fields)) doc[k] = extractVal(v);
    docs.push(doc);
  }
  return docs;
}

function ff(fieldPath, op, value) {
  if (typeof value === 'string') return { fieldFilter: { field: { fieldPath }, op, value: { stringValue: value } } };
  if (typeof value === 'boolean') return { fieldFilter: { field: { fieldPath }, op, value: { booleanValue: value } } };
  return { fieldFilter: { field: { fieldPath }, op, value: { integerValue: String(value) } } };
}

async function main() {
  const tokens = findFirebaseToken();
  let refreshToken = tokens?.refresh_token || tokens?.tokens?.refresh_token;
  if (!refreshToken) { console.error('No refresh token'); process.exit(1); }

  const accessToken = await refreshAccessToken(refreshToken);
  console.log('Got access token.\n');

  // 1. Query bookings with last_day_free set (any value)
  console.log('=== 1. Bookings with last_day_free <= 2026-06-03 ===\n');
  const lfdBookings = parseDocs(await firestoreQuery(accessToken, 'airfreight_bookings',
    [ff('last_day_free', 'LESS_THAN_OR_EQUAL', '2026-06-03')], [], 20));
  console.log(`Found: ${lfdBookings.length}`);
  lfdBookings.forEach(d => console.log(JSON.stringify({
    id: d._id, awb: d.awb_1st_leg, client: d.client_name, booking_type: d.booking_type,
    on_hand: d.on_hand, last_day_free: d.last_day_free, ready_for_pickup: d.ready_for_pickup,
    flight_id: d.flight_id, status: d.status,
  })));

  // 2. Query bookings with ready_for_pickup set
  console.log('\n=== 2. Bookings with ready_for_pickup <= 2026-06-03 ===\n');
  const readyBookings = parseDocs(await firestoreQuery(accessToken, 'airfreight_bookings',
    [ff('ready_for_pickup', 'LESS_THAN_OR_EQUAL', '2026-06-03')], [], 20));
  console.log(`Found: ${readyBookings.length}`);
  readyBookings.forEach(d => console.log(JSON.stringify({
    id: d._id, awb: d.awb_1st_leg, client: d.client_name, booking_type: d.booking_type,
    on_hand: d.on_hand, last_day_free: d.last_day_free, ready_for_pickup: d.ready_for_pickup,
    flight_id: d.flight_id, status: d.status,
  })));

  // 3. Look specifically for booking with AWB containing 8252 or 98063011
  console.log('\n=== 3. All ecommerce/mawb bookings (check awb_lines) ===\n');
  const mawbBookings = parseDocs(await firestoreQuery(accessToken, 'airfreight_bookings',
    [ff('booking_type', 'EQUAL', 'ecommerce')], [], 30));
  console.log(`Found: ${mawbBookings.length} ecommerce bookings`);
  for (const d of mawbBookings) {
    if (d.awb_lines && Array.isArray(d.awb_lines)) {
      for (const line of d.awb_lines) {
        if (line.last_day_free || line.ready_for_pickup) {
          console.log(JSON.stringify({
            booking_id: d._id, booking_type: d.booking_type,
            line_awb: line.awb_2nd_leg, line_on_hand: line.on_hand,
            line_lfd: line.last_day_free, line_ready: line.ready_for_pickup,
            booking_lfd: d.last_day_free, booking_on_hand: d.on_hand,
          }));
        }
      }
    }
  }

  // 4. Check mawb type too
  console.log('\n=== 4. All mawb bookings (check awb_lines) ===\n');
  const mawb2 = parseDocs(await firestoreQuery(accessToken, 'airfreight_bookings',
    [ff('booking_type', 'EQUAL', 'mawb')], [], 30));
  console.log(`Found: ${mawb2.length} mawb bookings`);
  for (const d of mawb2) {
    if (d.awb_lines && Array.isArray(d.awb_lines)) {
      for (const line of d.awb_lines) {
        if (line.last_day_free || line.ready_for_pickup) {
          console.log(JSON.stringify({
            booking_id: d._id, booking_type: d.booking_type,
            line_awb: line.awb_2nd_leg, line_on_hand: line.on_hand,
            line_lfd: line.last_day_free, line_ready: line.ready_for_pickup,
            booking_lfd: d.last_day_free, booking_on_hand: d.on_hand,
          }));
        }
      }
    }
  }

  // 5. Check simple bookings that have on_hand field
  console.log('\n=== 5. Simple bookings with on_hand=false ===\n');
  const simpleNoHand = parseDocs(await firestoreQuery(accessToken, 'airfreight_bookings',
    [ff('booking_type', 'EQUAL', 'simple'), ff('on_hand', 'EQUAL', false)], [], 20));
  console.log(`Found: ${simpleNoHand.length}`);
  simpleNoHand.forEach(d => console.log(JSON.stringify({
    id: d._id, awb: d.awb_1st_leg, on_hand: d.on_hand, lfd: d.last_day_free, ready: d.ready_for_pickup,
  })));

  // 6. ALL bookings with any LFD (no on_hand filter) to see if on_hand is the issue
  console.log('\n=== 6. ALL bookings with LFD (no on_hand filter) ===\n');
  const allLfd = parseDocs(await firestoreQuery(accessToken, 'airfreight_bookings',
    [ff('last_day_free', 'GREATER_THAN_OR_EQUAL', '2026-06-01')], [], 20));
  console.log(`Found: ${allLfd.length}`);
  allLfd.forEach(d => console.log(JSON.stringify({
    id: d._id, awb: d.awb_1st_leg, booking_type: d.booking_type,
    on_hand: d.on_hand, lfd: d.last_day_free, ready: d.ready_for_pickup, status: d.status,
  })));

  console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
