// Query Firestore using Firebase CLI stored credentials (already authenticated)
const { execSync } = require('child_process');
const https = require('https');

// Get access token from Firebase CLI
function getAccessToken() {
  const result = execSync('npx firebase login:ci --no-localhost 2>&1 || true', { encoding: 'utf-8' });
  // Try getting token from stored credentials
  const tokenResult = execSync('npx firebase --token 2>&1 || true', { encoding: 'utf-8' });
  return tokenResult.trim();
}

// Use Firebase CLI's stored refresh token
const os = require('os');
const path = require('path');
const fs = require('fs');

function findFirebaseToken() {
  // Firebase CLI stores config in different locations
  const locations = [
    path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'configstore', 'firebase-tools.json'),
    path.join(process.env.APPDATA || '', 'configstore', 'firebase-tools.json'),
  ];
  for (const loc of locations) {
    try {
      if (fs.existsSync(loc)) {
        console.log('Found Firebase config at:', loc);
        const config = JSON.parse(fs.readFileSync(loc, 'utf-8'));
        if (config.tokens && config.tokens.access_token) {
          return config.tokens;
        }
        if (config.user && config.user.tokens) {
          return config.user.tokens;
        }
        // Try to find refresh_token anywhere
        const str = JSON.stringify(config);
        if (str.includes('refresh_token')) {
          console.log('Config keys:', Object.keys(config));
          if (config.tokens) console.log('Tokens keys:', Object.keys(config.tokens));
          if (config.user) console.log('User keys:', Object.keys(config.user));
        }
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
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
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
    const sq = {
      structuredQuery: {
        from: [{ collectionId }],
        limit: limitN || 30,
      }
    };
    if (filters && filters.length > 0) {
      sq.structuredQuery.where = {
        compositeFilter: { op: 'AND', filters }
      };
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
  if (field.arrayValue) {
    return (field.arrayValue.values || []).map(v => extractVal(v));
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
    for (const [k, v] of Object.entries(fields)) {
      doc[k] = extractVal(v);
    }
    docs.push(doc);
  }
  return docs;
}

function ff(fieldPath, op, value) {
  const val = typeof value === 'string' ? { stringValue: value } : { integerValue: String(value) };
  return { fieldFilter: { field: { fieldPath }, op, value: val } };
}

async function main() {
  const tokens = findFirebaseToken();
  if (!tokens) {
    console.error('No Firebase credentials found. Run: npx firebase login');
    process.exit(1);
  }

  let refreshToken = null;
  if (tokens.refresh_token) refreshToken = tokens.refresh_token;
  else if (tokens.tokens && tokens.tokens.refresh_token) refreshToken = tokens.tokens.refresh_token;

  if (!refreshToken) {
    console.log('Token structure:', JSON.stringify(tokens).slice(0, 500));
    console.error('No refresh_token found');
    process.exit(1);
  }

  console.log('Refreshing access token...');
  const accessToken = await refreshAccessToken(refreshToken);
  console.log('Got access token.\n');

  // === 1. Audit log for LA-0543 ===
  console.log('=== 1. AUDIT: flight_number = LA-0543 ===\n');
  const audit1 = parseDocs(await firestoreQuery(accessToken, '_sheet_sync_flight_audit',
    [ff('flight_number', 'EQUAL', 'LA-0543')], [], 30));
  console.log(`Found: ${audit1.length} docs`);
  audit1.forEach(d => console.log(JSON.stringify({
    type: d.type, fn: d.fn, flight_id: d.flight_id, etd: d.etd,
    old_etd: d.old_etd, new_etd: d.new_etd, trigger_awb: d.trigger_awb,
    candidates_count: d.candidates_count, monthKey: d.monthKey, step: d.step,
    reason: d.reason, created_at: d.created_at
  })));

  // === 2. Step2 events (any flight) ===
  console.log('\n=== 2. AUDIT: step2_fallback events ===\n');
  const audit2 = parseDocs(await firestoreQuery(accessToken, '_sheet_sync_flight_audit',
    [ff('type', 'EQUAL', 'step2_fallback')], [], 20));
  console.log(`Found: ${audit2.length} docs`);
  audit2.forEach(d => console.log(JSON.stringify({
    flight_number: d.flight_number, flight_id: d.flight_id, etd: d.etd,
    old_etd: d.old_etd, new_etd: d.new_etd, trigger_awb: d.trigger_awb,
    monthKey: d.monthKey, fn: d.fn, created_at: d.created_at
  })));

  // === 2b. step2_etd_blocked ===
  console.log('\n=== 2b. AUDIT: step2_etd_blocked events ===\n');
  const audit2b = parseDocs(await firestoreQuery(accessToken, '_sheet_sync_flight_audit',
    [ff('type', 'EQUAL', 'step2_etd_blocked')], [], 20));
  console.log(`Found: ${audit2b.length} docs`);
  audit2b.forEach(d => console.log(JSON.stringify({
    flight_number: d.flight_number, flight_id: d.flight_id,
    current_etd: d.current_etd, requested_etd: d.requested_etd,
    trigger_awb: d.trigger_awb, reason: d.reason, fn: d.fn, created_at: d.created_at
  })));

  // === 2c. firestore_dedup_hit ===
  console.log('\n=== 2c. AUDIT: firestore_dedup_hit events ===\n');
  const audit2c = parseDocs(await firestoreQuery(accessToken, '_sheet_sync_flight_audit',
    [ff('type', 'EQUAL', 'firestore_dedup_hit')], [], 20));
  console.log(`Found: ${audit2c.length} docs`);
  audit2c.forEach(d => console.log(JSON.stringify({
    flight_number: d.flight_number, flight_id: d.flight_id, etd: d.etd,
    trigger_awb: d.trigger_awb, fn: d.fn, created_at: d.created_at
  })));

  // === 3. LA-0543 flights ===
  console.log('\n=== 3. FLIGHTS: LA-0543 ===\n');
  const flights = parseDocs(await firestoreQuery(accessToken, 'airfreight_flights',
    [ff('flight_number', 'EQUAL', 'LA-0543')], [], 10));
  console.log(`Found: ${flights.length} flights`);
  flights.forEach(d => console.log(JSON.stringify({
    id: d._id, flight_number: d.flight_number, airline: d.airline,
    flight_datetime: d.flight_datetime, cutoff_datetime: d.cutoff_datetime,
    destinations: d.destinations, status: d.status, flight_status: d.flight_status,
    created_by: d.created_by, created_at: d.created_at
  })));

  // === 4. flight_created events (recent) ===
  console.log('\n=== 4. AUDIT: recent flight_created ===\n');
  const audit4 = parseDocs(await firestoreQuery(accessToken, '_sheet_sync_flight_audit',
    [ff('type', 'EQUAL', 'flight_created')], [], 20));
  console.log(`Found: ${audit4.length} docs`);
  audit4.forEach(d => console.log(JSON.stringify({
    flight_number: d.flight_number, flight_id: d.flight_id, etd: d.etd,
    airline: d.airline, dest: d.destinations || d.dest,
    trigger_awb: d.trigger_awb, step: d.step, monthKey: d.monthKey,
    fn: d.fn, created_at: d.created_at
  })));

  // === 5. Recent sync runs ===
  console.log('\n=== 5. SYNC RUNS (recent) ===\n');
  const runs = parseDocs(await firestoreQuery(accessToken, '_sheet_sync_runs',
    [], [{ field: { fieldPath: 'run_at' }, direction: 'DESCENDING' }], 8));
  console.log(`Found: ${runs.length} runs`);
  runs.forEach(d => console.log(JSON.stringify({
    client_id: d.client_id, run_at: d.run_at, status: d.status,
    rows_checked: d.rows_checked, changes_detected: d.changes_detected,
    new_awbs: d.new_awbs, changed_awbs: d.changed_awbs, duration_ms: d.duration_ms
  })));

  console.log('\nDone.');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
