#!/usr/bin/env node
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROJECT_ID = 'wms-mcl';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function getRefreshToken() {
  const p = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
  const cfg = JSON.parse(readFileSync(p, 'utf-8'));
  return cfg.tokens.refresh_token;
}

async function getAccessToken() {
  const rt = getRefreshToken();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: rt,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }),
  });
  return (await res.json()).access_token;
}

function str(f, k) { return f[k]?.stringValue || ''; }

async function main() {
  const TOKEN = await getAccessToken();

  // Search all DocReceptions with awb_number containing 999
  const url = `${BASE}:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'airfreight_doc_receptions' }],
        where: { fieldFilter: { field: { fieldPath: 'awb_number' }, op: 'EQUAL', value: { stringValue: '999-92781161' } } },
        limit: 50,
      },
    }),
  });
  const data = await res.json();
  const docs = (data || []).filter(r => r.document);

  console.log(`Found ${docs.length} DocReceptions with awb_number = 999-92781161:\n`);
  for (const r of docs) {
    const f = r.document.fields || {};
    const id = r.document.name.split('/').pop();
    console.log(`  ID: ${id}`);
    console.log(`    awb_number: ${str(f, 'awb_number')}`);
    console.log(`    awb_2nd_leg: ${str(f, 'awb_2nd_leg') || 'NULL'}`);
    console.log(`    flight_id: ${str(f, 'flight_id')}`);
    console.log(`    flight_number: ${str(f, 'flight_number')}`);
    console.log(`    status: ${str(f, 'status')}`);
    console.log(`    created_by: ${str(f, 'created_by')}`);
    console.log(`    booking_id: ${str(f, 'booking_id')}`);
    console.log('');
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
