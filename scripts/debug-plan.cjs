// Debug: read airfreight_plans document directly to see what's stored
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

function getDoc(accessToken, docPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/wms-mcl/databases/(default)/documents/${docPath}`,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + accessToken },
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

function listDocs(accessToken, collectionPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/wms-mcl/databases/(default)/documents/${collectionPath}?pageSize=50`,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + accessToken },
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.end();
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

function parseDocFields(fields) {
  if (!fields) return {};
  const doc = {};
  for (const [k, v] of Object.entries(fields)) doc[k] = extractVal(v);
  return doc;
}

async function main() {
  const tokens = findFirebaseToken();
  const refreshToken = tokens?.refresh_token || tokens?.tokens?.refresh_token;
  if (!refreshToken) { console.error('No refresh token'); process.exit(1); }
  const accessToken = await refreshAccessToken(refreshToken);

  // 1. List ALL documents in airfreight_plans
  console.log('=== ALL airfreight_plans documents ===\n');
  const list = await listDocs(accessToken, 'airfreight_plans');
  if (list.documents) {
    for (const doc of list.documents) {
      const id = doc.name.split('/').pop();
      const data = parseDocFields(doc.fields);
      console.log(`--- Plan: ${id} ---`);
      console.log(`  date: ${data.date}`);
      console.log(`  created_by: ${data.created_by}`);
      console.log(`  updated_at: ${data.updated_at}`);
      console.log(`  manual_flights: ${JSON.stringify(data.manual_flights)}`);
      console.log(`  flight_plans keys: ${data.flight_plans ? Object.keys(data.flight_plans).join(', ') : 'none'}`);
      console.log('');
    }
  } else {
    console.log('No documents found. Response:', JSON.stringify(list).slice(0, 500));
  }

  // 2. Specifically get 2026-06-02 plan
  console.log('\n=== Specific: airfreight_plans/2026-06-02 ===\n');
  const plan0602 = await getDoc(accessToken, 'airfreight_plans/2026-06-02');
  if (plan0602.fields) {
    const data = parseDocFields(plan0602.fields);
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log('Not found or error:', JSON.stringify(plan0602).slice(0, 500));
  }

  // 3. Get tomorrow's plan
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  console.log(`\n=== Specific: airfreight_plans/${tomorrowStr} ===\n`);
  const planTomorrow = await getDoc(accessToken, `airfreight_plans/${tomorrowStr}`);
  if (planTomorrow.fields) {
    const data = parseDocFields(planTomorrow.fields);
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log('Not found or error:', JSON.stringify(planTomorrow).slice(0, 500));
  }

  // 4. Now check the specific booking with AWB 369-98063011
  console.log('\n=== Searching for booking with AWB 369-98063011 ===\n');
  // Try awb_1st_leg search
  const searchBody = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'airfreight_bookings' }],
      where: { fieldFilter: { field: { fieldPath: 'awb_1st_leg' }, op: 'EQUAL', value: { stringValue: '369-98063011' } } },
      limit: 5,
    }
  });
  const searchResult = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: '/v1/projects/wms-mcl/databases/(default)/documents:runQuery',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken, 'Content-Length': Buffer.byteLength(searchBody) },
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(searchBody); req.end();
  });

  if (Array.isArray(searchResult)) {
    for (const r of searchResult) {
      if (r.document) {
        const id = r.document.name.split('/').pop();
        const data = parseDocFields(r.document.fields);
        console.log(`Found booking ${id}:`);
        console.log(`  booking_type: ${data.booking_type}`);
        console.log(`  on_hand: ${data.on_hand}`);
        console.log(`  last_day_free: ${data.last_day_free}`);
        console.log(`  ready_for_pickup: ${data.ready_for_pickup}`);
        console.log(`  flight_id: ${data.flight_id}`);
        console.log(`  client_name: ${data.client_name}`);
        console.log(`  status: ${data.status}`);
        if (data.awb_lines) {
          console.log(`  awb_lines (${data.awb_lines.length}):`);
          for (const line of data.awb_lines) {
            console.log(`    - awb: ${line.awb_2nd_leg || line.awb_1st_leg}, on_hand: ${line.on_hand}, lfd: ${line.last_day_free}, ready: ${line.ready_for_pickup}`);
          }
        }
      }
    }
    if (!searchResult.some(r => r.document)) {
      console.log('No booking found with awb_1st_leg = 369-98063011');

      // Try searching in awb_lines (can't query inside array, so search by mawb_number)
      console.log('\nSearching by mawb_number containing 98063...');
      // Actually let's just search recent bookings for Express Line
      const searchBody2 = JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'airfreight_bookings' }],
          where: { fieldFilter: { field: { fieldPath: 'client_name' }, op: 'EQUAL', value: { stringValue: 'Express Line' } } },
          limit: 20,
        }
      });
      const sr2 = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'firestore.googleapis.com',
          path: '/v1/projects/wms-mcl/databases/(default)/documents:runQuery',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken, 'Content-Length': Buffer.byteLength(searchBody2) },
        }, res => {
          let data = ''; res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        });
        req.on('error', reject); req.write(searchBody2); req.end();
      });

      if (Array.isArray(sr2)) {
        for (const r of sr2) {
          if (r.document) {
            const id = r.document.name.split('/').pop();
            const data = parseDocFields(r.document.fields);
            const hasTarget = data.awb_lines?.some(l =>
              (l.awb_2nd_leg || '').includes('98063') || (l.awb_1st_leg || '').includes('98063')
            );
            const hasLfd = data.last_day_free || data.awb_lines?.some(l => l.last_day_free);

            console.log(`  Booking ${id}: type=${data.booking_type}, on_hand=${data.on_hand}, lfd=${data.last_day_free}, hasTarget=${hasTarget}, hasLfd=${hasLfd}`);
            if (hasTarget || hasLfd) {
              console.log(`    MATCH! Full details:`);
              console.log(`    booking_type: ${data.booking_type}`);
              console.log(`    on_hand: ${data.on_hand}`);
              console.log(`    last_day_free: ${data.last_day_free}`);
              console.log(`    ready_for_pickup: ${data.ready_for_pickup}`);
              if (data.awb_lines) {
                for (const line of data.awb_lines) {
                  console.log(`    - awb: ${line.awb_2nd_leg}, on_hand: ${line.on_hand}, lfd: ${line.last_day_free}, ready: ${line.ready_for_pickup}, pcs: ${line.pieces}`);
                }
              }
            }
          }
        }
      }
    }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
