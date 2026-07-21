// Find the specific booking with AWB 369-98063011 by searching ALL ecommerce bookings
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
    } catch (e) {}
  }
  return null;
}

function refreshAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data).access_token); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function extractVal(field) {
  if (!field) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.integerValue !== undefined) return Number(field.integerValue);
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.timestampValue !== undefined) return field.timestampValue;
  if (field.nullValue !== undefined) return null;
  if (field.arrayValue) return (field.arrayValue.values || []).map(v => extractVal(v));
  if (field.mapValue) {
    const obj = {};
    for (const [k, v] of Object.entries(field.mapValue.fields || {})) obj[k] = extractVal(v);
    return obj;
  }
  return JSON.stringify(field);
}

function firestoreQuery(accessToken, sq) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(sq);
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: '/v1/projects/wms-mcl/databases/(default)/documents:runQuery',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function main() {
  const tokens = findFirebaseToken();
  const refreshToken = tokens?.refresh_token || tokens?.tokens?.refresh_token;
  if (!refreshToken) { console.error('No refresh token'); process.exit(1); }
  const accessToken = await refreshAccessToken(refreshToken);

  // Search ALL bookings for the AWB containing 98063011 or 98146355
  // We need to search by awb_1st_leg (for simple) and by mawb_number
  const targets = ['369-98063011', '369-98146355'];

  for (const awb of targets) {
    console.log(`\n=== Searching awb_1st_leg = ${awb} ===`);
    const r1 = await firestoreQuery(accessToken, {
      structuredQuery: {
        from: [{ collectionId: 'airfreight_bookings' }],
        where: { fieldFilter: { field: { fieldPath: 'awb_1st_leg' }, op: 'EQUAL', value: { stringValue: awb } } },
        limit: 5,
      }
    });
    if (Array.isArray(r1)) {
      const docs = r1.filter(r => r.document);
      console.log(`Found: ${docs.length}`);
      for (const r of docs) {
        const fields = r.document.fields || {};
        const data = {};
        for (const [k, v] of Object.entries(fields)) data[k] = extractVal(v);
        console.log(JSON.stringify({ id: r.document.name.split('/').pop(), type: data.booking_type, on_hand: data.on_hand, lfd: data.last_day_free, ready: data.ready_for_pickup, flight_id: data.flight_id, status: data.status }));
      }
    }

    console.log(`\n=== Searching mawb_number = ${awb} ===`);
    const r2 = await firestoreQuery(accessToken, {
      structuredQuery: {
        from: [{ collectionId: 'airfreight_bookings' }],
        where: { fieldFilter: { field: { fieldPath: 'mawb_number' }, op: 'EQUAL', value: { stringValue: awb } } },
        limit: 5,
      }
    });
    if (Array.isArray(r2)) {
      const docs = r2.filter(r => r.document);
      console.log(`Found: ${docs.length}`);
      for (const r of docs) {
        const fields = r.document.fields || {};
        const data = {};
        for (const [k, v] of Object.entries(fields)) data[k] = extractVal(v);
        console.log(`Booking: ${r.document.name.split('/').pop()}`);
        console.log(`  type: ${data.booking_type}, on_hand: ${data.on_hand}, lfd: ${data.last_day_free}`);
        console.log(`  ready: ${data.ready_for_pickup}, flight_id: ${data.flight_id}`);
        if (data.awb_lines && Array.isArray(data.awb_lines)) {
          for (const line of data.awb_lines) {
            console.log(`  line: awb=${line.awb_2nd_leg}, on_hand=${line.on_hand}, lfd=${line.last_day_free}, ready=${line.ready_for_pickup}, pcs=${line.pieces}`);
          }
        }
      }
    }
  }

  // Also search by the 2nd leg AWBs shown in screenshot
  const secondLegs = ['045-20348134', '045-20348252'];
  for (const awb of secondLegs) {
    console.log(`\n=== Searching awb_1st_leg = ${awb} (2nd leg as simple) ===`);
    const r = await firestoreQuery(accessToken, {
      structuredQuery: {
        from: [{ collectionId: 'airfreight_bookings' }],
        where: { fieldFilter: { field: { fieldPath: 'awb_1st_leg' }, op: 'EQUAL', value: { stringValue: awb } } },
        limit: 5,
      }
    });
    if (Array.isArray(r)) {
      const docs = r.filter(r => r.document);
      console.log(`Found: ${docs.length}`);
      for (const d of docs) {
        const fields = d.document.fields || {};
        const data = {};
        for (const [k, v] of Object.entries(fields)) data[k] = extractVal(v);
        console.log(JSON.stringify({ id: d.document.name.split('/').pop(), type: data.booking_type, on_hand: data.on_hand, lfd: data.last_day_free, ready: data.ready_for_pickup, flight_id: data.flight_id }));
      }
    }
  }

  // Search ALL ecommerce bookings and look for the AWB in awb_lines
  console.log('\n=== Searching ALL ecommerce bookings for AWB 98063 in awb_lines ===');
  let startAfter = null;
  let found = false;
  let batch = 0;
  while (!found && batch < 10) {
    batch++;
    const sq = {
      structuredQuery: {
        from: [{ collectionId: 'airfreight_bookings' }],
        where: { fieldFilter: { field: { fieldPath: 'booking_type' }, op: 'EQUAL', value: { stringValue: 'ecommerce' } } },
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        limit: 50,
      }
    };
    if (startAfter) {
      sq.structuredQuery.startAt = { values: [{ referenceValue: startAfter }], before: false };
    }
    const r = await firestoreQuery(accessToken, sq);
    if (!Array.isArray(r)) break;
    const docs = r.filter(r => r.document);
    if (docs.length === 0) break;
    console.log(`  Batch ${batch}: ${docs.length} docs`);

    for (const d of docs) {
      const fields = d.document.fields || {};
      const data = {};
      for (const [k, v] of Object.entries(fields)) data[k] = extractVal(v);
      if (data.awb_lines && Array.isArray(data.awb_lines)) {
        for (const line of data.awb_lines) {
          const awb2 = line.awb_2nd_leg || '';
          const awb1 = line.awb_1st_leg || '';
          if (awb2.includes('98063') || awb1.includes('98063') || awb2.includes('20348252') || awb2.includes('20348134')) {
            console.log(`  FOUND in booking ${d.document.name.split('/').pop()}:`);
            console.log(`    type: ${data.booking_type}, on_hand: ${data.on_hand}`);
            console.log(`    top-level lfd: ${data.last_day_free}`);
            console.log(`    top-level ready: ${data.ready_for_pickup}`);
            console.log(`    flight_id: ${data.flight_id}`);
            console.log(`    client: ${data.client_name}`);
            for (const l2 of data.awb_lines) {
              console.log(`    line: awb=${l2.awb_2nd_leg}, on_hand=${l2.on_hand}, lfd=${l2.last_day_free}, ready=${l2.ready_for_pickup}`);
            }
            found = true;
          }
        }
      }
    }
    startAfter = docs[docs.length - 1].document.name;
  }
  if (!found) console.log('  NOT FOUND in any ecommerce booking');

  console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
