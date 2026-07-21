#!/usr/bin/env node
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROJECT_ID = 'wms-mcl';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const DR_ID = 'OrhnYGk7MkEcUFyGVHMP';

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

async function main() {
  const TOKEN = await getAccessToken();

  // 1. Find and delete physical pieces
  const url = `${BASE}:runQuery`;
  const ppRes = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'airfreight_physical_pieces' }],
        where: { fieldFilter: { field: { fieldPath: 'doc_reception_id' }, op: 'EQUAL', value: { stringValue: DR_ID } } },
        limit: 500,
      },
    }),
  });
  const ppData = await ppRes.json();
  const pieces = (ppData || []).filter(r => r.document).map(r => r.document.name);
  console.log(`Found ${pieces.length} physical pieces to delete`);

  let deleted = 0;
  for (const pName of pieces) {
    const r = await fetch(`https://firestore.googleapis.com/v1/${pName}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (r.ok) deleted++;
    else console.error(`  ERROR: ${r.status}`);
  }
  console.log(`Deleted ${deleted}/${pieces.length} pieces`);

  // 2. Delete DocReception
  const drPath = `${BASE}/airfreight_doc_receptions/${DR_ID}`;
  const drRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/airfreight_doc_receptions/${DR_ID}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (drRes.ok) console.log(`DocReception ${DR_ID} DELETED`);
  else console.error(`ERROR deleting DR: ${drRes.status}`);

  console.log('\nDONE');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
