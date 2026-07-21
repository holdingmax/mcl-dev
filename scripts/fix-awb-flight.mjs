#!/usr/bin/env node
/**
 * Fix AWB 045-22209493: Update DocReception kpMNKE2oqyi51Fk257kA
 * to point to flight UC-1105 (Vw6UGg3cK2MRbJtnkDO6)
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROJECT_ID = 'wms-mcl';
const DR_ID = 'kpMNKE2oqyi51Fk257kA';
const NEW_FLIGHT_ID = 'Vw6UGg3cK2MRbJtnkDO6';
const DOC_PATH = `projects/${PROJECT_ID}/databases/(default)/documents/airfreight_doc_receptions/${DR_ID}`;

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
  const data = await res.json();
  return data.access_token;
}

async function main() {
  const TOKEN = await getAccessToken();

  // Read current doc
  const getRes = await fetch(`https://firestore.googleapis.com/v1/${DOC_PATH}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const doc = await getRes.json();
  const currentFlight = doc.fields?.flight_id?.stringValue;
  console.log(`DocReception ${DR_ID}`);
  console.log(`  Current flight_id: ${currentFlight}`);
  console.log(`  New flight_id:     ${NEW_FLIGHT_ID}`);

  // Patch flight_id
  const patchRes = await fetch(
    `https://firestore.googleapis.com/v1/${DOC_PATH}?updateMask.fieldPaths=flight_id`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: { flight_id: { stringValue: NEW_FLIGHT_ID } },
      }),
    },
  );

  if (patchRes.ok) {
    console.log('  DONE — flight_id updated to UC-1105');
  } else {
    const err = await patchRes.text();
    console.error('  ERROR:', patchRes.status, err);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
