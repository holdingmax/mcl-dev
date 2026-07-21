#!/usr/bin/env node
/**
 * Data Audit Script (READ-ONLY)
 * Analyzes historical data issues without making any changes.
 * Uses Firebase CLI refresh token for auth.
 *
 * Run:  node scripts/data-audit.mjs
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
        docs.push({ id, fields: doc.fields || {} });
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

function strVal(fields, key) {
  const f = fields[key];
  if (!f) return '';
  return f.stringValue || '';
}

function boolVal(fields, key) {
  const f = fields[key];
  if (!f) return false;
  return f.booleanValue || false;
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

function numVal(fields, key) {
  const f = fields[key];
  if (!f) return 0;
  return f.doubleValue || f.integerValue || 0;
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

// ── Script B: bookings missing or outdated awb_numbers_normalized ──────

async function auditAwbIndex(bookings) {
  console.log('=== SCRIPT B: awb_numbers_normalized audit ===');
  let missing = 0, outdated = 0, ok = 0;
  const examples = [];

  for (const doc of bookings) {
    const correct = computeNormalized(doc.fields);
    const existingArr = arrVal(doc.fields, 'awb_numbers_normalized');
    const existing = existingArr.map(v => v.stringValue || '').filter(Boolean);

    if (existing.length === 0) {
      missing++;
      if (examples.length < 5) {
        examples.push({ id: doc.id, type: strVal(doc.fields, 'booking_type'), issue: 'MISSING', correct });
      }
    } else if (JSON.stringify([...existing].sort()) !== JSON.stringify([...correct].sort())) {
      outdated++;
      if (examples.length < 10) {
        examples.push({ id: doc.id, type: strVal(doc.fields, 'booking_type'), issue: 'OUTDATED', existing, correct });
      }
    } else {
      ok++;
    }
  }

  console.log(`  Total bookings: ${bookings.length}`);
  console.log(`  OK (indexed correctly): ${ok}`);
  console.log(`  Missing index: ${missing}`);
  console.log(`  Outdated index: ${outdated}`);
  console.log(`  NEED FIX: ${missing + outdated}`);
  if (examples.length > 0) {
    console.log('  Examples:');
    for (const ex of examples) {
      console.log(`    ${ex.id} [${ex.type}] ${ex.issue} -> should be [${ex.correct.join(', ')}]`);
    }
  }
  console.log('');
  return { total: bookings.length, missing, outdated, ok };
}

// ── Script A: physical_pieces with 1st leg instead of 2nd leg ──────────

async function auditPieceAwbs(docReceptions, pieces) {
  console.log('=== SCRIPT A: physical_pieces AWB number audit ===');

  const drMap = new Map();
  let drWith2ndLeg = 0;

  for (const d of docReceptions) {
    const awb = strVal(d.fields, 'awb_number');
    const awb2 = strVal(d.fields, 'awb_2nd_leg');
    drMap.set(d.id, { awb_number: awb, awb_2nd_leg: awb2 || null });
    if (awb2) drWith2ndLeg++;
  }

  let wrong = 0, correct = 0, nodr = 0;
  const wrongPieces = [];
  let totalWeightImpact = 0;

  for (const d of pieces) {
    const pieceAwb = strVal(d.fields, 'awb_number');
    const drId = strVal(d.fields, 'doc_reception_id');
    const dr = drMap.get(drId);

    if (!dr) {
      nodr++;
      continue;
    }

    if (dr.awb_2nd_leg) {
      if (pieceAwb === dr.awb_2nd_leg) {
        correct++;
      } else if (pieceAwb === dr.awb_number) {
        wrong++;
        const wt = Number(numVal(d.fields, 'weight_kg'));
        totalWeightImpact += wt;
        if (wrongPieces.length < 10) {
          wrongPieces.push({
            pieceId: d.id,
            drId,
            current: pieceAwb,
            shouldBe: dr.awb_2nd_leg,
            weight: wt,
            warehouse: strVal(d.fields, 'warehouse_number'),
          });
        }
      } else {
        correct++;
      }
    } else {
      correct++;
    }
  }

  console.log(`  Total pieces: ${pieces.length}`);
  console.log(`  Doc receptions with 2nd leg: ${drWith2ndLeg}`);
  console.log(`  Pieces correct: ${correct}`);
  console.log(`  Pieces with WRONG AWB (1st instead of 2nd): ${wrong}`);
  console.log(`  Weight impact (kg): ${totalWeightImpact.toFixed(2)}`);
  console.log(`  Pieces without matching doc_reception: ${nodr}`);
  if (wrongPieces.length > 0) {
    console.log('  Examples:');
    for (const p of wrongPieces) {
      console.log(`    piece=${p.pieceId} has="${p.current}" shouldBe="${p.shouldBe}" wt=${p.weight}kg wh=${p.warehouse}`);
    }
  }
  console.log('');
  return { total: pieces.length, correct, wrong, nodr, totalWeightImpact };
}

// ── Script C: orphaned doc_receptions ──────────────────────────────────

async function auditOrphans(bookings, docReceptions, pieces) {
  console.log('=== SCRIPT C: orphaned records ===');

  const bookingIds = new Set(bookings.map(b => b.id));
  const drIds = new Set(docReceptions.map(d => d.id));

  let orphanedDr = 0, validDr = 0, noBid = 0;
  const orphanExamples = [];

  for (const d of docReceptions) {
    const bid = strVal(d.fields, 'booking_id');
    if (!bid) {
      noBid++;
    } else if (!bookingIds.has(bid)) {
      orphanedDr++;
      if (orphanExamples.length < 10) {
        orphanExamples.push({
          drId: d.id,
          bookingId: bid,
          awb: strVal(d.fields, 'awb_2nd_leg') || strVal(d.fields, 'awb_number'),
          status: strVal(d.fields, 'status'),
        });
      }
    } else {
      validDr++;
    }
  }

  let orphanedPieces = 0;
  for (const d of pieces) {
    const drId = strVal(d.fields, 'doc_reception_id');
    if (drId && !drIds.has(drId)) {
      orphanedPieces++;
    }
  }

  console.log(`  Doc receptions total: ${docReceptions.length}`);
  console.log(`  Valid (booking exists): ${validDr}`);
  console.log(`  No booking_id: ${noBid}`);
  console.log(`  Orphaned (booking deleted): ${orphanedDr}`);
  if (orphanExamples.length > 0) {
    console.log('  Examples:');
    for (const o of orphanExamples) {
      console.log(`    dr=${o.drId} booking=${o.bookingId} awb=${o.awb} status=${o.status}`);
    }
  }
  console.log(`  Orphaned pieces (doc_reception deleted): ${orphanedPieces}`);
  console.log('');
  return { drTotal: docReceptions.length, validDr, noBid, orphanedDr, orphanedPieces };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('========================================');
  console.log('  MCL WMS - Data Audit (READ-ONLY)');
  console.log(`  Project: ${PROJECT_ID}`);
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log('========================================\n');

  console.log('Authenticating...');
  TOKEN = await getAccessToken();
  console.log('OK\n');

  console.log('Loading collections (this may take a moment)...');
  const [bookings, docReceptions, pieces] = await Promise.all([
    fetchCollection('airfreight_bookings'),
    fetchCollection('airfreight_doc_receptions'),
    fetchCollection('airfreight_physical_pieces'),
  ]);
  console.log(`  Loaded: ${bookings.length} bookings, ${docReceptions.length} doc_receptions, ${pieces.length} pieces\n`);

  const resultB = await auditAwbIndex(bookings);
  const resultA = await auditPieceAwbs(docReceptions, pieces);
  const resultC = await auditOrphans(bookings, docReceptions, pieces);

  console.log('========================================');
  console.log('  RESUMEN');
  console.log('========================================');
  console.log(`  Script B - Bookings sin index o desactualizado: ${resultB.missing + resultB.outdated} / ${resultB.total}`);
  console.log(`  Script A - Piezas con AWB incorrecto:           ${resultA.wrong} / ${resultA.total}  (${resultA.totalWeightImpact.toFixed(1)} kg)`);
  console.log(`  Script C - Doc receptions huerfanas:            ${resultC.orphanedDr}`);
  console.log(`  Script C - Piezas huerfanas:                    ${resultC.orphanedPieces}`);
  console.log('');

  if (resultB.missing + resultB.outdated === 0 && resultA.wrong === 0 && resultC.orphanedDr === 0 && resultC.orphanedPieces === 0) {
    console.log('  Todo limpio. No se necesitan correcciones.');
  } else {
    console.log('  Se encontraron datos que necesitan correccion.');
    console.log('  Revisa los resultados y confirma antes de ejecutar el fix.');
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
