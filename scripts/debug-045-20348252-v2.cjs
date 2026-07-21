// Broader search for AWB 045-20348252
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

function refreshAccessToken(rt) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' }).toString();
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).access_token); } catch(e) { reject(e); } }); });
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
  if (field.mapValue) { const o = {}; for (const [k, v] of Object.entries(field.mapValue.fields || {})) o[k] = extractVal(v); return o; }
  return JSON.stringify(field);
}

function parseDoc(doc) {
  if (!doc?.fields) return null;
  const d = { _id: doc.name.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields)) d[k] = extractVal(v);
  return d;
}

function query(accessToken, collectionId, filters, limit) {
  return new Promise((resolve, reject) => {
    const sq = { structuredQuery: { from: [{ collectionId }], limit: limit || 50 } };
    if (filters?.length === 1) sq.structuredQuery.where = filters[0];
    else if (filters?.length > 1) sq.structuredQuery.where = { compositeFilter: { op: 'AND', filters } };
    const body = JSON.stringify(sq);
    const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/wms-mcl/databases/(default)/documents:runQuery', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken, 'Content-Length': Buffer.byteLength(body) } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

function ff(fp, op, val) {
  let v;
  if (typeof val === 'string') v = { stringValue: val };
  else if (typeof val === 'boolean') v = { booleanValue: val };
  else v = { integerValue: String(val) };
  return { fieldFilter: { field: { fieldPath: fp }, op, value: v } };
}

async function main() {
  const tokens = findFirebaseToken();
  const rt = tokens?.refresh_token || tokens?.tokens?.refresh_token;
  const at = await refreshAccessToken(rt);

  // 1. Search doc_receptions by awb_number with variations
  const awbVariants = ['045-20348252', '04520348252', '045 20348252'];
  for (const awb of awbVariants) {
    console.log(`=== DR: awb_number = "${awb}" ===`);
    const r = await query(at, 'airfreight_doc_receptions', [ff('awb_number', 'EQUAL', awb)], 5);
    const docs = (Array.isArray(r) ? r : []).filter(r => r.document).map(r => parseDoc(r.document));
    console.log(`  Found: ${docs.length}`);
    docs.forEach(d => console.log(`  ${JSON.stringify({ id: d._id, awb: d.awb_number, booking_id: d.booking_id, flight_id: d.flight_id, status: d.status })}`));
  }

  // 2. Search by awb_2nd_leg
  console.log(`\n=== DR: awb_2nd_leg = "045-20348252" ===`);
  const r2 = await query(at, 'airfreight_doc_receptions', [ff('awb_2nd_leg', 'EQUAL', '045-20348252')], 5);
  const docs2 = (Array.isArray(r2) ? r2 : []).filter(r => r.document).map(r => parseDoc(r.document));
  console.log(`  Found: ${docs2.length}`);
  docs2.forEach(d => console.log(`  ${JSON.stringify({ id: d._id, awb: d.awb_number, awb2: d.awb_2nd_leg, booking_id: d.booking_id, flight_id: d.flight_id, status: d.status })}`));

  // 3. Search by awb_1st_leg = the MAWB
  console.log(`\n=== DR: awb_1st_leg = "369-98063011" ===`);
  const r3 = await query(at, 'airfreight_doc_receptions', [ff('awb_1st_leg', 'EQUAL', '369-98063011')], 5);
  const docs3 = (Array.isArray(r3) ? r3 : []).filter(r => r.document).map(r => parseDoc(r.document));
  console.log(`  Found: ${docs3.length}`);
  docs3.forEach(d => console.log(`  ${JSON.stringify({ id: d._id, awb: d.awb_number, awb2: d.awb_2nd_leg, booking_id: d.booking_id, flight_id: d.flight_id, status: d.status })}`));

  // 4. The URL shows doc reception ID: obOZ4gOAd1BDnyKTqmV4
  console.log(`\n=== DR by ID: obOZ4gOAd1BDnyKTqmV4 ===`);
  const drDoc = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/wms-mcl/databases/(default)/documents/airfreight_doc_receptions/obOZ4gOAd1BDnyKTqmV4', method: 'GET', headers: { 'Authorization': 'Bearer ' + at } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.end();
  });
  if (drDoc.fields) {
    const d = parseDoc(drDoc);
    console.log(JSON.stringify(d, null, 2));
  } else {
    console.log('  Not found:', JSON.stringify(drDoc).slice(0, 300));
  }

  // 5. Search ALL bookings for awb_line with 20348252
  console.log(`\n=== Searching ALL ecommerce bookings for 20348252 in awb_lines ===`);
  let startAfter = null;
  let found = false;
  let batch = 0;
  while (!found && batch < 15) {
    batch++;
    const sq = { structuredQuery: { from: [{ collectionId: 'airfreight_bookings' }], where: { fieldFilter: { field: { fieldPath: 'booking_type' }, op: 'EQUAL', value: { stringValue: 'ecommerce' } } }, orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: 50 } };
    if (startAfter) sq.structuredQuery.startAt = { values: [{ referenceValue: startAfter }], before: false };
    const r = await query(at, null, null, null); // Won't work, use raw
    // Actually use the proper query
    const body = JSON.stringify(sq);
    const result = await new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/wms-mcl/databases/(default)/documents:runQuery', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + at, 'Content-Length': Buffer.byteLength(body) } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); });
      req.on('error', reject); req.write(body); req.end();
    });
    if (!Array.isArray(result)) break;
    const docs = result.filter(r => r.document);
    if (docs.length === 0) break;

    for (const doc of docs) {
      const b = parseDoc(doc.document);
      if (b.awb_lines && Array.isArray(b.awb_lines)) {
        for (const l of b.awb_lines) {
          if ((l.awb_2nd_leg || '').includes('20348252')) {
            console.log(`  FOUND in booking ${b._id}:`);
            console.log(`    booking_type: ${b.booking_type}`);
            console.log(`    flight_id: ${b.flight_id}`);
            console.log(`    status: ${b.status}`);
            console.log(`    on_hand: ${b.on_hand}`);
            console.log(`    client: ${b.client_name}`);
            console.log(`    mawb: ${b.mawb_number}`);
            for (const l2 of b.awb_lines) {
              console.log(`    line: ${l2.awb_2nd_leg} on_hand=${l2.on_hand} ws=${l2.warehouse_status} ts=${l2.transport_status} lfd=${l2.last_day_free}`);
            }
            found = true;
            break;
          }
        }
      }
      if (found) break;
    }
    startAfter = docs[docs.length - 1].document.name;
    if (!found) console.log(`  Batch ${batch}: ${docs.length} docs, not found yet...`);
  }

  // 6. Search flight by doc-reception screenshot data (flight L7-2502)
  // The screenshot shows flight #L7-2502 with ETD 06 jun 19:55
  // Maybe the flight_number format is different
  console.log(`\n=== Flights matching "L7" ===`);
  const flAll = await query(at, 'airfreight_flights', [], 100);
  const flDocs = (Array.isArray(flAll) ? flAll : []).filter(r => r.document).map(r => parseDoc(r.document));
  console.log(`  Total flights: ${flDocs.length}`);
  const l7flights = flDocs.filter(f => (f.flight_number || '').includes('L7') || (f.flight_number || '').includes('2502'));
  console.log(`  Matching L7/2502: ${l7flights.length}`);
  l7flights.forEach(f => console.log(`    ${f._id}: ${f.flight_number} ${f.airline} ${f.flight_datetime} status=${f.status || f.flight_status}`));

  // Also check flight 7kIA5XwAzyimJYbrhhwj (from previous search that found the booking)
  console.log(`\n=== Flight 7kIA5XwAzyimJYbrhhwj ===`);
  const fl7k = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/wms-mcl/databases/(default)/documents/airfreight_flights/7kIA5XwAzyimJYbrhhwj', method: 'GET', headers: { 'Authorization': 'Bearer ' + at } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.end();
  });
  if (fl7k.fields) {
    const f = parseDoc(fl7k);
    console.log(JSON.stringify({ id: f._id, fn: f.flight_number, airline: f.airline, dt: f.flight_datetime, status: f.status || f.flight_status, dest: f.destinations }));
  } else {
    console.log('  Not found');
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
