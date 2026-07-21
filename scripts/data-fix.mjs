#!/usr/bin/env node
/**
 * Data Fix Script — Corrects historical data issues found by data-audit.mjs
 * - Script B: Rebuild awb_numbers_normalized on bookings
 * - Script A: Fix physical_pieces.awb_number (1st leg -> 2nd leg)
 * - Script C: Delete orphaned pieces (no matching doc_reception)
 *
 * Run:  node scripts/data-fix.mjs
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROJECT_ID = 'wms-mcl';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ── Auth ──────────────────────────────────────────────────────────────────

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
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Firestore REST helpers ────────────────────────────────────────────────

let TOKEN = '';

async function fetchCollection(collName) {
  const docs = [];
  let pageToken = '';
  while (true) {
    const url = `${BASE}/${collName}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const data = await res.json();
    if (data.documents) {
      for (const doc of data.documents) {
        const id = doc.name.split('/').pop();
        docs.push({ id, name: doc.name, fields: doc.fields || {} });
      }
    }
    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
    } else {
      break;
    }
  }
  return docs;
}

async function patchDoc(docName, fieldsToUpdate) {
  const updateMask = Object.keys(fieldsToUpdate).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/${docName}?${updateMask}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: fieldsToUpdate }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PATCH ${docName} failed: ${res.status} ${err}`);
  }
}

async function deleteDocument(docName) {
  const res = await fetch(`https://firestore.googleapis.com/v1/${docName}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DELETE ${docName} failed: ${res.status} ${err}`);
  }
}

function strVal(fields, key) {
  const f = fields[key];
  if (!f) return '';
  return f.stringValue || '';
}

function arrVal(fields, key) {
  const f = fields[key];
  if (!f || !f.arrayValue || !f.arrayValue.values) return [];
  return f.arrayValue.values;
}

function mapFields(mapVal) {
  if (!mapVal || !mapVal.mapValue || !mapVal.mapValue.fields) return {};
  return mapVal.mapValue.fields;
}

function normalize(val) {
  return (val || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function computeNormalized(fields) {
  const set = new Set();
  const bookingType = strVal(fields, 'booking_type');
  if (bookingType === 'simple') {
    const a1 = strVal(fields, 'awb_1st_leg');
    const a2 = strVal(fields, 'awb_2nd_leg');
    if (a1) set.add(normalize(a1));
    if (a2) set.add(normalize(a2));
  } else {
    const lines = arrVal(fields, 'awb_lines');
    for (const lineVal of lines) {
      const lf = mapFields(lineVal);
      const an = strVal(lf, 'awb_number');
      const a2 = strVal(lf, 'awb_2nd_leg');
      if (an) set.add(normalize(an));
      if (a2) set.add(normalize(a2));
    }
  }
  set.delete('');
  return Array.from(set);
}

// ── Script B: Fix awb_numbers_normalized ───────────────────────────────

async function fixAwbIndex(bookings) {
  console.log('=== FIX B: Rebuilding awb_numbers_normalized ===');
  let fixed = 0, skipped = 0, errors = 0;

  for (const doc of bookings) {
    const correct = computeNormalized(doc.fields);
    const existingArr = arrVal(doc.fields, 'awb_numbers_normalized');
    const existing = existingArr.map(v => v.stringValue || '').filter(Boolean);

    if (existing.length > 0 && JSON.stringify([...existing].sort()) === JSON.stringify([...correct].sort())) {
      skipped++;
      continue;
    }

    try {
      await patchDoc(doc.name, {
        awb_numbers_normalized: {
          arrayValue: {
            values: correct.map(v => ({ stringValue: v })),
          },
        },
      });
      fixed++;
      console.log(`  Fixed: ${doc.id} -> [${correct.join(', ')}]`);
    } catch (err) {
      errors++;
      console.error(`  ERROR: ${doc.id}: ${err.message}`);
    }
  }

  console.log(`  Result: ${fixed} fixed, ${skipped} skipped, ${errors} errors`);
  console.log('');
  return fixed;
}

// ── Script A: Fix physical_pieces.awb_number ──────────────────────────

async function fixPieceAwbs(docReceptions, pieces) {
  console.log('=== FIX A: Correcting physical_pieces AWB numbers ===');

  const drMap = new Map();
  for (const d of docReceptions) {
    const awb = strVal(d.fields, 'awb_number');
    const awb2 = strVal(d.fields, 'awb_2nd_leg');
    drMap.set(d.id, { awb_number: awb, awb_2nd_leg: awb2 || null });
  }

  let fixed = 0, skipped = 0, errors = 0;

  for (const d of pieces) {
    const pieceAwb = strVal(d.fields, 'awb_number');
    const drId = strVal(d.fields, 'doc_reception_id');
    const dr = drMap.get(drId);

    if (!dr || !dr.awb_2nd_leg) { skipped++; continue; }
    if (pieceAwb === dr.awb_2nd_leg) { skipped++; continue; }
    if (pieceAwb !== dr.awb_number) { skipped++; continue; }

    try {
      await patchDoc(d.name, {
        awb_number: { stringValue: dr.awb_2nd_leg },
      });
      fixed++;
      if (fixed <= 20) {
        console.log(`  Fixed: piece ${d.id} "${pieceAwb}" -> "${dr.awb_2nd_leg}"`);
      } else if (fixed % 100 === 0) {
        console.log(`  ... ${fixed} pieces fixed so far`);
      }
    } catch (err) {
      errors++;
      console.error(`  ERROR: piece ${d.id}: ${err.message}`);
    }
  }

  console.log(`  Result: ${fixed} fixed, ${skipped} skipped, ${errors} errors`);
  console.log('');
  return fixed;
}

// ── Script C: Delete orphaned pieces ──────────────────────────────────

async function fixOrphans(docReceptions, pieces) {
  console.log('=== FIX C: Deleting orphaned pieces ===');

  const drIds = new Set(docReceptions.map(d => d.id));
  let deleted = 0, skipped = 0, errors = 0;

  for (const d of pieces) {
    const drId = strVal(d.fields, 'doc_reception_id');
    if (!drId || drIds.has(drId)) { skipped++; continue; }

    try {
      await deleteDocument(d.name);
      deleted++;
      if (deleted <= 20) {
        console.log(`  Deleted: piece ${d.id} (orphan of dr ${drId})`);
      } else if (deleted % 100 === 0) {
        console.log(`  ... ${deleted} orphaned pieces deleted so far`);
      }
    } catch (err) {
      errors++;
      console.error(`  ERROR: piece ${d.id}: ${err.message}`);
    }
  }

  console.log(`  Result: ${deleted} deleted, ${skipped} skipped, ${errors} errors`);
  console.log('');
  return deleted;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('========================================');
  console.log('  MCL WMS - Data Fix');
  console.log(`  Project: ${PROJECT_ID}`);
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log('========================================\n');

  console.log('Authenticating...');
  TOKEN = await getAccessToken();
  console.log('OK\n');

  console.log('Loading collections...');
  const [bookings, docReceptions, pieces] = await Promise.all([
    fetchCollection('airfreight_bookings'),
    fetchCollection('airfreight_doc_receptions'),
    fetchCollection('airfreight_physical_pieces'),
  ]);
  console.log(`  Loaded: ${bookings.length} bookings, ${docReceptions.length} doc_receptions, ${pieces.length} pieces\n`);

  const fixedB = await fixAwbIndex(bookings);
  const fixedA = await fixPieceAwbs(docReceptions, pieces);
  const fixedC = await fixOrphans(docReceptions, pieces);

  console.log('========================================');
  console.log('  RESULTADO');
  console.log('========================================');
  console.log(`  Script B: ${fixedB} bookings reindexados`);
  console.log(`  Script A: ${fixedA} piezas corregidas`);
  console.log(`  Script C: ${fixedC} piezas huerfanas eliminadas`);
  console.log('\n  Hecho.');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
