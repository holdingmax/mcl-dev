const https = require('https');

const projectId = process.env.FIREBASE_PROJECT_ID;
const apiKey = process.env.FIREBASE_API_KEY;

function queryFirestore(collectionId, filters, orderBy, limit) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: filters ? { compositeFilter: { op: 'AND', filters } } : undefined,
        orderBy: orderBy || [],
        limit: limit || 50
      }
    });

    const options = {
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Parse error: ' + data.slice(0, 500)));
        }
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
  if (field.integerValue !== undefined) return field.integerValue;
  if (field.timestampValue !== undefined) return field.timestampValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.arrayValue) return JSON.stringify(field.arrayValue);
  if (field.mapValue) return JSON.stringify(field.mapValue);
  return JSON.stringify(field);
}

function extractDoc(doc) {
  const fields = doc.fields || {};
  const result = {};
  for (const [k, v] of Object.entries(fields)) {
    result[k] = extractVal(v);
  }
  return result;
}

async function main() {
  console.log('=== 1. AUDIT LOG: flight_number contains 0543 ===\n');

  // Query for LA-0543
  const audit1 = await queryFirestore('_sheet_sync_flight_audit', [
    { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: 'LA-0543' } } }
  ], [{ field: { fieldPath: 'created_at' }, direction: 'DESCENDING' }], 30);

  let auditDocs = [];
  if (Array.isArray(audit1)) {
    for (const r of audit1) {
      if (r.document) {
        const d = extractDoc(r.document);
        auditDocs.push(d);
        console.log(JSON.stringify({
          type: d.type, fn: d.fn, flight_id: d.flight_id,
          flight_number: d.flight_number, etd: d.etd,
          old_etd: d.old_etd, new_etd: d.new_etd,
          trigger_awb: d.trigger_awb, candidates_count: d.candidates_count,
          monthKey: d.monthKey, step: d.step, reason: d.reason,
          created_at: d.created_at
        }, null, 0));
      }
    }
    if (auditDocs.length === 0) console.log('No docs found for LA-0543');
  }

  // Also try normalized version
  console.log('\n=== 2. AUDIT LOG: normalized LA0543 (no hyphen) ===\n');
  const audit2 = await queryFirestore('_sheet_sync_flight_audit', [
    { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: 'LA0543' } } }
  ], [{ field: { fieldPath: 'created_at' }, direction: 'DESCENDING' }], 20);

  if (Array.isArray(audit2)) {
    for (const r of audit2) {
      if (r.document) {
        const d = extractDoc(r.document);
        console.log(JSON.stringify({
          type: d.type, fn: d.fn, flight_id: d.flight_id,
          etd: d.etd, trigger_awb: d.trigger_awb, created_at: d.created_at
        }, null, 0));
      }
    }
  }

  // Check the flight itself
  console.log('\n=== 3. FLIGHTS: LA-0543 in airfreight_flights ===\n');
  const flights = await queryFirestore('airfreight_flights', [
    { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: 'LA-0543' } } }
  ], [], 20);

  if (Array.isArray(flights)) {
    for (const r of flights) {
      if (r.document) {
        const d = extractDoc(r.document);
        const docId = r.document.name.split('/').pop();
        console.log(JSON.stringify({
          doc_id: docId, flight_number: d.flight_number, airline: d.airline,
          flight_datetime: d.flight_datetime, cutoff_datetime: d.cutoff_datetime,
          destinations: d.destinations, status: d.status, flight_status: d.flight_status,
          created_by: d.created_by, created_at: d.created_at
        }, null, 0));
      }
    }
  }

  // Check recent sync runs
  console.log('\n=== 4. RECENT SYNC RUNS (last 10) ===\n');
  const runs = await queryFirestore('_sheet_sync_runs', [],
    [{ field: { fieldPath: 'run_at' }, direction: 'DESCENDING' }], 10);

  if (Array.isArray(runs)) {
    for (const r of runs) {
      if (r.document) {
        const d = extractDoc(r.document);
        console.log(JSON.stringify({
          client_id: d.client_id, run_at: d.run_at, status: d.status,
          rows_checked: d.rows_checked, changes_detected: d.changes_detected,
          new_awbs: d.new_awbs, changed_awbs: d.changed_awbs,
          duration_ms: d.duration_ms
        }, null, 0));
      }
    }
  }
}

main().catch(e => console.error('Error:', e.message));
