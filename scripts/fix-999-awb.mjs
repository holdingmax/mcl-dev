#!/usr/bin/env node
/**
 * Investigate and fix DocReception for AWB 999-92781161
 * - Should display as 045-22209961 (2nd leg)
 * - Update awb_2nd_leg on DocReception
 * - Update awb_number on physical pieces to use 2nd leg
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROJECT_ID = 'wms-mcl';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const AWB_1ST = '999-92781161';
const AWB_2ND = '045-22209961';

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

async function runQuery(collectionId, filters) {
  const url = `${BASE}:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: { compositeFilter: { op: 'AND', filters } },
        limit: 100,
      },
    }),
  });
  const data = await res.json();
  return (data || []).filter(r => r.document).map(r => ({
    id: r.document.name.split('/').pop(),
    name: r.document.name,
    fields: r.document.fields || {},
  }));
}

function str(fields, key) {
  return fields[key]?.stringValue || '';
}

async function patchDoc(docPath, fieldsToUpdate, fieldPaths) {
  const mask = fieldPaths.map(fp => `updateMask.fieldPaths=${fp}`).join('&');
  const res = await fetch(`https://firestore.googleapis.com/v1/${docPath}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fieldsToUpdate }),
  });
  return res;
}

async function main() {
  TOKEN = await getAccessToken();
  console.log(`=== Investigating AWB ${AWB_1ST} (should be ${AWB_2ND}) ===\n`);

  // 1. Find DocReceptions with awb_number = 999-92781161
  console.log('--- 1. DOC RECEPTIONS ---');
  const drs = await runQuery('airfreight_doc_receptions', [
    { fieldFilter: { field: { fieldPath: 'awb_number' }, op: 'EQUAL', value: { stringValue: AWB_1ST } } },
  ]);

  if (drs.length === 0) {
    console.log('  No DocReceptions found with awb_number = ' + AWB_1ST);
    return;
  }

  for (const dr of drs) {
    console.log(`  DocReception: ${dr.id}`);
    console.log(`    awb_number: ${str(dr.fields, 'awb_number')}`);
    console.log(`    awb_2nd_leg: ${str(dr.fields, 'awb_2nd_leg') || 'NULL/EMPTY'}`);
    console.log(`    flight_id: ${str(dr.fields, 'flight_id')}`);
    console.log(`    status: ${str(dr.fields, 'status')}`);
    console.log(`    created_by: ${str(dr.fields, 'created_by')}`);
    console.log('');
  }

  // 2. Find physical pieces with awb_number = 999-92781161
  console.log('--- 2. PHYSICAL PIECES with 1st leg AWB ---');
  const pieces = await runQuery('airfreight_physical_pieces', [
    { fieldFilter: { field: { fieldPath: 'awb_number' }, op: 'EQUAL', value: { stringValue: AWB_1ST } } },
  ]);
  console.log(`  Found ${pieces.length} pieces with awb_number = ${AWB_1ST}`);
  for (const p of pieces.slice(0, 5)) {
    console.log(`    piece=${p.id} dr=${str(p.fields, 'doc_reception_id')} awb=${str(p.fields, 'awb_number')}`);
  }
  if (pieces.length > 5) console.log(`    ... and ${pieces.length - 5} more`);
  console.log('');

  // 3. Fix: Update DocReception awb_2nd_leg
  console.log('--- 3. FIXING DocReceptions ---');
  for (const dr of drs) {
    const current2nd = str(dr.fields, 'awb_2nd_leg');
    if (current2nd === AWB_2ND) {
      console.log(`  ${dr.id}: awb_2nd_leg already correct, skipping.`);
      continue;
    }
    console.log(`  ${dr.id}: Setting awb_2nd_leg = ${AWB_2ND}`);
    const res = await patchDoc(dr.name, {
      awb_2nd_leg: { stringValue: AWB_2ND },
    }, ['awb_2nd_leg']);
    if (res.ok) console.log('    DONE');
    else console.error('    ERROR:', res.status, await res.text());
  }
  console.log('');

  // 4. Fix: Update physical pieces awb_number from 1st leg to 2nd leg
  console.log('--- 4. FIXING Physical Pieces ---');
  let fixed = 0;
  for (const p of pieces) {
    const res = await patchDoc(p.name, {
      awb_number: { stringValue: AWB_2ND },
    }, ['awb_number']);
    if (res.ok) fixed++;
    else console.error(`    ERROR on ${p.id}:`, res.status, await res.text());
  }
  console.log(`  Fixed ${fixed}/${pieces.length} pieces (awb_number → ${AWB_2ND})`);
  console.log('');
  console.log('=== DONE ===');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
