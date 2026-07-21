const https = require('https');
const path = require('path');
const fs = require('fs');

const os = require('os');
const locations = [
  path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'configstore', 'firebase-tools.json'),
  path.join(process.env.APPDATA || '', 'configstore', 'firebase-tools.json'),
];
let config;
for (const loc of locations) { try { if (fs.existsSync(loc)) { config = JSON.parse(fs.readFileSync(loc, 'utf-8')); break; } } catch(e) {} }
if (!config) { console.error('No Firebase config found'); process.exit(1); }
const rt = config.tokens?.refresh_token || config.user?.tokens?.refresh_token;

function post(hostname, reqPath, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, method: 'POST', headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
function get(hostname, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, method: 'GET', headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject); req.end();
  });
}

function val(field) {
  if (!field) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.integerValue !== undefined) return Number(field.integerValue);
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.timestampValue !== undefined) return field.timestampValue;
  if (field.nullValue !== undefined) return null;
  if (field.arrayValue) return (field.arrayValue.values || []).map(v => val(v));
  if (field.mapValue) { const o = {}; for (const [k, v] of Object.entries(field.mapValue.fields || {})) o[k] = val(v); return o; }
  return JSON.stringify(field);
}

function parseFields(fields) {
  const o = {};
  for (const [k, v] of Object.entries(fields || {})) o[k] = val(v);
  return o;
}

(async () => {
  const tokenBody = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' }).toString();
  const tokenRes = await post('oauth2.googleapis.com', '/token', tokenBody, { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody) });
  const at = tokenRes.access_token;
  const auth = { 'Authorization': 'Bearer ' + at };
  const base = '/v1/projects/wms-mcl/databases/(default)/documents';

  // 1. Doc reception from URL
  console.log('=== 1. Doc Reception obOZ4gOAd1BDnyKTqmV4 ===');
  const dr = await get('firestore.googleapis.com', base + '/airfreight_doc_receptions/obOZ4gOAd1BDnyKTqmV4', auth);
  if (!dr.fields) { console.log('NOT FOUND:', JSON.stringify(dr).slice(0, 300)); process.exit(0); }
  const drData = parseFields(dr.fields);
  console.log(JSON.stringify(drData, null, 2));

  // 2. Booking linked
  const bid = drData.booking_id;
  console.log('\n=== 2. Booking', bid, '===');
  if (bid) {
    const bk = await get('firestore.googleapis.com', base + '/airfreight_bookings/' + bid, auth);
    if (bk.fields) {
      const bData = parseFields(bk.fields);
      console.log('  booking_type:', bData.booking_type);
      console.log('  flight_id:', bData.flight_id);
      console.log('  status:', bData.status);
      console.log('  on_hand:', bData.on_hand);
      console.log('  client_name:', bData.client_name);
      if (bData.awb_lines) {
        console.log('  awb_lines:');
        for (const l of bData.awb_lines) {
          console.log('    ' + l.awb_2nd_leg + ': on_hand=' + l.on_hand + ' ws=' + l.warehouse_status + ' ts=' + l.transport_status + ' lfd=' + l.last_day_free);
        }
      }
    } else {
      console.log('  NOT FOUND');
    }
  } else {
    console.log('  No booking_id!');
  }

  // 3. Flight linked (from doc reception)
  const fid = drData.flight_id;
  console.log('\n=== 3. Flight from DR:', fid, '===');
  if (fid) {
    const fl = await get('firestore.googleapis.com', base + '/airfreight_flights/' + fid, auth);
    if (fl.fields) {
      const fData = parseFields(fl.fields);
      console.log('  flight_number:', fData.flight_number, ', airline:', fData.airline, ', dt:', fData.flight_datetime, ', status:', fData.status || fData.flight_status);
    } else {
      console.log('  NOT FOUND');
    }
  } else {
    console.log('  No flight_id on DR!');
  }

  // 4. Physical pieces
  console.log('\n=== 4. Physical Pieces ===');
  const ppBody = JSON.stringify({ structuredQuery: { from: [{ collectionId: 'airfreight_physical_pieces' }], where: { fieldFilter: { field: { fieldPath: 'doc_reception_id' }, op: 'EQUAL', value: { stringValue: 'obOZ4gOAd1BDnyKTqmV4' } } }, limit: 20 } });
  const ppRes = await post('firestore.googleapis.com', base + ':runQuery', ppBody, { ...auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ppBody) });
  const ppDocs = (Array.isArray(ppRes) ? ppRes : []).filter(r => r.document);
  console.log('  Found:', ppDocs.length);
  for (const p of ppDocs) {
    const pd = parseFields(p.document.fields);
    console.log('  ', pd.pieces, 'pcs', pd.weight, 'kg uld=' + pd.uld_id, 'status=' + pd.status);
  }

  console.log('\nDone.');
})().catch(e => console.error('Fatal:', e));
