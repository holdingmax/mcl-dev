#!/usr/bin/env node
/**
 * Fix AWB 045-22209961:
 * 1. Delete ghost DocReception on UC-1105 + its pieces
 * 2. Set on_hand=false on booking line [3] (999-92781161) so buildup stops auto-creating
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROJECT_ID = 'wms-mcl';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const BOOKING_ID = 'A8Z14m7jFEnxtMfxJVyz';
const FLIGHT_ID_UC1105 = 'Vw6UGg3cK2MRbJtnkDO6';

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

let TOKEN = '';

function str(f, k) { return f[k]?.stringValue || ''; }

async function main() {
  TOKEN = await getAccessToken();

  // 1. Find ghost DocReception(s) for 045-22209961 on UC-1105
  console.log('--- 1. Finding ghost DocReceptions on UC-1105 ---');
  const qRes = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'airfreight_doc_receptions' }],
        where: { compositeFilter: { op: 'AND', filters: [
          { fieldFilter: { field: { fieldPath: 'awb_2nd_leg' }, op: 'EQUAL', value: { stringValue: '045-22209961' } } },
          { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: FLIGHT_ID_UC1105 } } },
        ] } },
        limit: 10,
      },
    }),
  });
  const qData = await qRes.json();
  const ghosts = (qData || []).filter(r => r.document).map(r => ({
    id: r.document.name.split('/').pop(),
    name: r.document.name,
    fields: r.document.fields || {},
  }));

  // Also check by awb_number (in case awb_2nd_leg is null)
  const qRes2 = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'airfreight_doc_receptions' }],
        where: { compositeFilter: { op: 'AND', filters: [
          { fieldFilter: { field: { fieldPath: 'awb_number' }, op: 'EQUAL', value: { stringValue: '999-92781161' } } },
          { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: FLIGHT_ID_UC1105 } } },
        ] } },
        limit: 10,
      },
    }),
  });
  const qData2 = await qRes2.json();
  const ghosts2 = (qData2 || []).filter(r => r.document).map(r => ({
    id: r.document.name.split('/').pop(),
    name: r.document.name,
    fields: r.document.fields || {},
  }));

  const allGhosts = [...new Map([...ghosts, ...ghosts2].map(g => [g.id, g])).values()];
  console.log(`  Found ${allGhosts.length} ghost(s)`);

  for (const g of allGhosts) {
    console.log(`  Ghost: ${g.id} awb=${str(g.fields, 'awb_number')} 2nd=${str(g.fields, 'awb_2nd_leg')}`);

    // Delete pieces
    const ppRes = await fetch(`${BASE}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'airfreight_physical_pieces' }],
          where: { fieldFilter: { field: { fieldPath: 'doc_reception_id' }, op: 'EQUAL', value: { stringValue: g.id } } },
          limit: 500,
        },
      }),
    });
    const ppData = await ppRes.json();
    const pieces = (ppData || []).filter(r => r.document).map(r => r.document.name);
    let del = 0;
    for (const p of pieces) {
      const r = await fetch(`https://firestore.googleapis.com/v1/${p}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
      if (r.ok) del++;
    }
    console.log(`    Deleted ${del}/${pieces.length} pieces`);

    // Delete DocReception
    const drDel = await fetch(`https://firestore.googleapis.com/v1/${g.name}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
    console.log(`    DocReception deleted: ${drDel.ok}`);
  }

  // 2. Update booking: set on_hand=false on line [3] (999-92781161)
  console.log('\n--- 2. Updating booking line on_hand=false ---');
  const bkRes = await fetch(`https://firestore.googleapis.com/v1/${BASE.replace(BASE,'')}/projects/${PROJECT_ID}/databases/(default)/documents/airfreight_bookings/${BOOKING_ID}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const bkDoc = await bkRes.json();
  const lines = bkDoc.fields?.awb_lines?.arrayValue?.values || [];

  // Find the line with awb_number = 999-92781161
  let targetIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const lf = lines[i]?.mapValue?.fields || {};
    if (str(lf, 'awb_number') === '999-92781161') {
      targetIdx = i;
      break;
    }
  }

  if (targetIdx === -1) {
    console.log('  Line 999-92781161 not found in booking!');
    return;
  }

  console.log(`  Found at index ${targetIdx}, setting on_hand=false`);
  lines[targetIdx].mapValue.fields.on_hand = { booleanValue: false };

  const patchRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/airfreight_bookings/${BOOKING_ID}?updateMask.fieldPaths=awb_lines`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: { awb_lines: { arrayValue: { values: lines } } },
      }),
    },
  );

  if (patchRes.ok) console.log('  Booking updated — on_hand=false');
  else console.error('  ERROR:', patchRes.status, await patchRes.text());

  console.log('\nDONE — Ghost deleted and booking line disabled for UC-1105 buildup');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
