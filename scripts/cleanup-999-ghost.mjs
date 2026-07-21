#!/usr/bin/env node
/**
 * Cleanup ghost DocReception 999-92781161 on UC-1105
 * - Delete the auto-created DocReception
 * - Delete its 103 physical pieces
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROJECT_ID = 'wms-mcl';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const AWB_1ST = '999-92781161';
const FLIGHT_ID = 'Vw6UGg3cK2MRbJtnkDO6'; // UC-1105

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

let TOKEN = '';

function str(fields, key) {
  return fields[key]?.stringValue || '';
}

async function main() {
  TOKEN = await getAccessToken();
  console.log(`=== Cleaning up ghost DocReception ${AWB_1ST} from UC-1105 ===\n`);

  // 1. Find DocReceptions with awb_number = 999-92781161 on UC-1105
  const url = `${BASE}:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'airfreight_doc_receptions' }],
        where: { compositeFilter: { op: 'AND', filters: [
          { fieldFilter: { field: { fieldPath: 'awb_number' }, op: 'EQUAL', value: { stringValue: AWB_1ST } } },
          { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: FLIGHT_ID } } },
        ] } },
        limit: 10,
      },
    }),
  });
  const data = await res.json();
  const drs = (data || []).filter(r => r.document).map(r => ({
    id: r.document.name.split('/').pop(),
    name: r.document.name,
    fields: r.document.fields || {},
  }));

  if (drs.length === 0) {
    console.log('No ghost DocReceptions found. Maybe already deleted?');
    return;
  }

  for (const dr of drs) {
    console.log(`DocReception: ${dr.id}`);
    console.log(`  awb_number: ${str(dr.fields, 'awb_number')}`);
    console.log(`  created_by: ${str(dr.fields, 'created_by')}`);
    console.log(`  status: ${str(dr.fields, 'status')}`);

    // 2. Find and delete physical pieces for this DocReception
    const ppRes = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'airfreight_physical_pieces' }],
          where: { fieldFilter: { field: { fieldPath: 'doc_reception_id' }, op: 'EQUAL', value: { stringValue: dr.id } } },
          limit: 500,
        },
      }),
    });
    const ppData = await ppRes.json();
    const pieces = (ppData || []).filter(r => r.document).map(r => r.document.name);

    console.log(`  Physical pieces found: ${pieces.length}`);

    // Delete pieces
    let deletedPieces = 0;
    for (const pName of pieces) {
      const delRes = await fetch(`https://firestore.googleapis.com/v1/${pName}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (delRes.ok) deletedPieces++;
      else console.error(`  ERROR deleting piece: ${delRes.status}`);
    }
    console.log(`  Deleted ${deletedPieces}/${pieces.length} pieces`);

    // 3. Delete the DocReception
    const delDr = await fetch(`https://firestore.googleapis.com/v1/${dr.name}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (delDr.ok) console.log('  DocReception DELETED');
    else console.error(`  ERROR deleting DocReception: ${delDr.status}`);
    console.log('');
  }

  console.log('=== DONE ===');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
