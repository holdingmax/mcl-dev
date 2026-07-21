// Trace the full data chain for AWB 045-20348252
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

function parseDoc(doc) {
  if (!doc || !doc.fields) return null;
  const data = { _id: doc.name.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields)) data[k] = extractVal(v);
  return data;
}

function firestoreQuery(accessToken, collectionId, filters, limit) {
  return new Promise((resolve, reject) => {
    const sq = { structuredQuery: { from: [{ collectionId }], limit: limit || 50 } };
    if (filters && filters.length > 0) {
      if (filters.length === 1) {
        sq.structuredQuery.where = filters[0];
      } else {
        sq.structuredQuery.where = { compositeFilter: { op: 'AND', filters } };
      }
    }
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

function ff(fieldPath, op, value) {
  let val;
  if (typeof value === 'string') val = { stringValue: value };
  else if (typeof value === 'boolean') val = { booleanValue: value };
  else val = { integerValue: String(value) };
  return { fieldFilter: { field: { fieldPath }, op, value: val } };
}

async function main() {
  const tokens = findFirebaseToken();
  const refreshToken = tokens?.refresh_token || tokens?.tokens?.refresh_token;
  if (!refreshToken) { console.error('No refresh token'); process.exit(1); }
  const accessToken = await refreshAccessToken(refreshToken);

  const AWB = '045-20348252';
  const MAWB = '369-98063011';

  // === 1. Doc Reception for this AWB ===
  console.log(`=== 1. DOC RECEPTIONS for AWB ${AWB} ===\n`);
  const dr1 = await firestoreQuery(accessToken, 'airfreight_doc_receptions', [ff('awb_number', 'EQUAL', AWB)], 10);
  const drDocs = (Array.isArray(dr1) ? dr1 : []).filter(r => r.document).map(r => parseDoc(r.document));
  console.log(`Found: ${drDocs.length}`);
  for (const d of drDocs) {
    console.log(JSON.stringify({
      id: d._id, awb: d.awb_number, booking_id: d.booking_id, flight_id: d.flight_id,
      status: d.status, client: d.client_name, pieces: d.pieces, weight: d.weight,
      chw: d.chargeable_weight, created_at: d.created_at, awb_1st_leg: d.awb_1st_leg,
      awb_2nd_leg: d.awb_2nd_leg, uld_type: d.uld_type
    }, null, 2));
  }

  // === 2. The booking that contains this AWB line ===
  console.log(`\n=== 2. BOOKING containing AWB ${AWB} (from previous search: bfIeh09YUOyuU7ZfeNR4) ===\n`);
  const bookingDoc = await getDoc(accessToken, 'airfreight_bookings/bfIeh09YUOyuU7ZfeNR4');
  if (bookingDoc.fields) {
    const b = parseDoc(bookingDoc);
    console.log(JSON.stringify({
      id: b._id, booking_type: b.booking_type, client_name: b.client_name,
      flight_id: b.flight_id, status: b.status, on_hand: b.on_hand,
      mawb_number: b.mawb_number,
    }, null, 2));
    if (b.awb_lines && Array.isArray(b.awb_lines)) {
      console.log(`\n  awb_lines (${b.awb_lines.length}):`);
      for (const l of b.awb_lines) {
        console.log(`    ${l.awb_2nd_leg}: on_hand=${l.on_hand}, lfd=${l.last_day_free}, ready=${l.ready_for_pickup}, warehouse_status=${l.warehouse_status}, transport_status=${l.transport_status}`);
      }
    }
  } else {
    console.log('Not found at bfIeh09YUOyuU7ZfeNR4, searching...');
  }

  // === 3. The flight L7-2502 ===
  console.log(`\n=== 3. FLIGHT L7-2502 ===\n`);
  const fl1 = await firestoreQuery(accessToken, 'airfreight_flights', [ff('flight_number', 'EQUAL', 'L7-2502')], 5);
  const flDocs = (Array.isArray(fl1) ? fl1 : []).filter(r => r.document).map(r => parseDoc(r.document));
  console.log(`Found: ${flDocs.length}`);
  for (const f of flDocs) {
    console.log(JSON.stringify({
      id: f._id, flight_number: f.flight_number, airline: f.airline,
      flight_datetime: f.flight_datetime, destinations: f.destinations,
      status: f.status, flight_status: f.flight_status
    }, null, 2));
  }

  // === 4. Flight by ID from booking's flight_id ===
  if (bookingDoc.fields) {
    const b = parseDoc(bookingDoc);
    if (b.flight_id) {
      console.log(`\n=== 4. FLIGHT by booking's flight_id: ${b.flight_id} ===\n`);
      const flDoc = await getDoc(accessToken, `airfreight_flights/${b.flight_id}`);
      if (flDoc.fields) {
        const f = parseDoc(flDoc);
        console.log(JSON.stringify({
          id: f._id, flight_number: f.flight_number, airline: f.airline,
          flight_datetime: f.flight_datetime, destinations: f.destinations,
          status: f.status, flight_status: f.flight_status
        }, null, 2));
      } else {
        console.log('Flight not found!', JSON.stringify(flDoc).slice(0, 200));
      }
    }
  }

  // === 5. Physical pieces for this doc reception ===
  if (drDocs.length > 0) {
    for (const dr of drDocs) {
      console.log(`\n=== 5. PHYSICAL PIECES for doc_reception ${dr._id} ===\n`);
      const pp = await firestoreQuery(accessToken, 'airfreight_physical_pieces', [ff('doc_reception_id', 'EQUAL', dr._id)], 20);
      const ppDocs = (Array.isArray(pp) ? pp : []).filter(r => r.document).map(r => parseDoc(r.document));
      console.log(`Found: ${ppDocs.length}`);
      for (const p of ppDocs) {
        console.log(JSON.stringify({
          id: p._id, pieces: p.pieces, weight: p.weight, uld_id: p.uld_id,
          status: p.status, location: p.location, created_at: p.created_at
        }));
      }
    }
  }

  // === 6. Check doc_reception's booking_id link ===
  if (drDocs.length > 0) {
    for (const dr of drDocs) {
      console.log(`\n=== 6. DOC RECEPTION ${dr._id} booking_id = ${dr.booking_id} ===`);
      if (dr.booking_id) {
        const bDoc = await getDoc(accessToken, `airfreight_bookings/${dr.booking_id}`);
        if (bDoc.fields) {
          const b2 = parseDoc(bDoc);
          console.log(`  Booking exists: type=${b2.booking_type}, flight_id=${b2.flight_id}, status=${b2.status}`);
          // Check if the awb_line for this AWB exists in the booking
          if (b2.awb_lines && Array.isArray(b2.awb_lines)) {
            const matchLine = b2.awb_lines.find(l => l.awb_2nd_leg === AWB);
            if (matchLine) {
              console.log(`  AWB line found: on_hand=${matchLine.on_hand}, warehouse_status=${matchLine.warehouse_status}`);
            } else {
              console.log(`  *** AWB line ${AWB} NOT FOUND in this booking's awb_lines!`);
              console.log(`  Available lines: ${b2.awb_lines.map(l => l.awb_2nd_leg).join(', ')}`);
            }
          }
        } else {
          console.log(`  *** Booking ${dr.booking_id} NOT FOUND!`);
        }
      } else {
        console.log(`  *** No booking_id on doc reception!`);
      }
    }
  }

  // === 7. Audit trail for this AWB ===
  console.log(`\n=== 7. AUDIT for AWB ${AWB} ===\n`);
  const audit = await firestoreQuery(accessToken, '_sheet_sync_flight_audit', [ff('trigger_awb', 'EQUAL', AWB)], 20);
  const auditDocs = (Array.isArray(audit) ? audit : []).filter(r => r.document).map(r => parseDoc(r.document));
  console.log(`Found: ${auditDocs.length}`);
  for (const a of auditDocs) {
    console.log(JSON.stringify({ type: a.type, flight_number: a.flight_number, flight_id: a.flight_id, step: a.step, reason: a.reason, created_at: a.created_at }));
  }

  // === 8. Check if cleanup script touched this ===
  console.log(`\n=== 8. AUDIT for MAWB ${MAWB} ===\n`);
  const audit2 = await firestoreQuery(accessToken, '_sheet_sync_flight_audit', [ff('trigger_awb', 'EQUAL', MAWB)], 20);
  const auditDocs2 = (Array.isArray(audit2) ? audit2 : []).filter(r => r.document).map(r => parseDoc(r.document));
  console.log(`Found: ${auditDocs2.length}`);
  for (const a of auditDocs2) {
    console.log(JSON.stringify({ type: a.type, flight_number: a.flight_number, flight_id: a.flight_id, step: a.step, reason: a.reason, created_at: a.created_at }));
  }

  // === 9. Check doc_reception flight_id vs booking flight_id ===
  console.log('\n=== 9. CROSS-CHECK: doc_reception.flight_id vs booking.flight_id ===\n');
  for (const dr of drDocs) {
    const bData = parseDoc(bookingDoc);
    console.log(`  doc_reception.flight_id = ${dr.flight_id}`);
    console.log(`  booking.flight_id = ${bData?.flight_id}`);
    console.log(`  MATCH: ${dr.flight_id === bData?.flight_id}`);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
