#!/usr/bin/env node
/**
 * Investigate AWB history — find what happened to a specific AWB
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROJECT_ID = 'wms-mcl';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const AWB_TARGET = '045-22209493'
const AWB_NORM = AWB_TARGET.replace(/[^A-Z0-9]/gi, '').toUpperCase()

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

async function runQuery(collectionId, structuredQuery) {
  const url = `${BASE}:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        ...structuredQuery,
      },
    }),
  });
  const data = await res.json();
  return (data || []).filter(r => r.document).map(r => ({
    id: r.document.name.split('/').pop(),
    name: r.document.name,
    fields: r.document.fields || {},
    createTime: r.document.createTime,
    updateTime: r.document.updateTime,
  }));
}

async function fetchCollection(collName) {
  const docs = [];
  let pageToken = '';
  while (true) {
    const url = `${BASE}/${collName}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const data = await res.json();
    if (data.documents) {
      for (const doc of data.documents) {
        docs.push({ id: doc.name.split('/').pop(), name: doc.name, fields: doc.fields || {}, createTime: doc.createTime, updateTime: doc.updateTime });
      }
    }
    if (data.nextPageToken) pageToken = data.nextPageToken;
    else break;
  }
  return docs;
}

function str(fields, key) {
  const f = fields[key];
  return f?.stringValue || '';
}
function num(fields, key) {
  const f = fields[key];
  return f?.doubleValue || f?.integerValue || 0;
}
function bool(fields, key) {
  const f = fields[key];
  return f?.booleanValue || false;
}
function arr(fields, key) {
  const f = fields[key];
  if (!f?.arrayValue?.values) return [];
  return f.arrayValue.values;
}
function mapF(v) {
  return v?.mapValue?.fields || {};
}

async function main() {
  console.log(`=== Investigating AWB ${AWB_TARGET} (${AWB_NORM}) ===\n`);
  TOKEN = await getAccessToken();

  // 1. Find bookings containing this AWB
  console.log('--- 1. BOOKINGS ---');
  const allBookings = await fetchCollection('airfreight_bookings');
  const matchingBookings = [];
  for (const b of allBookings) {
    const lines = arr(b.fields, 'awb_lines');
    for (let i = 0; i < lines.length; i++) {
      const lf = mapF(lines[i]);
      const awbNum = str(lf, 'awb_number');
      const awb2nd = str(lf, 'awb_2nd_leg');
      if (awbNum.replace(/[^A-Z0-9]/gi, '').toUpperCase() === AWB_NORM ||
          awb2nd.replace(/[^A-Z0-9]/gi, '').toUpperCase() === AWB_NORM) {
        matchingBookings.push({ bookingId: b.id, flightId: str(b.fields, 'flight_id'), awbIndex: i, line: lf, booking: b });
        const dispatched = bool(lf, 'dispatched');
        const onHand = bool(lf, 'on_hand');
        const whStatus = str(lf, 'warehouse_status');
        console.log(`  Booking: ${b.id}`);
        console.log(`    Flight ID: ${str(b.fields, 'flight_id')}`);
        console.log(`    Client: ${str(b.fields, 'client_name')}`);
        console.log(`    AWB Index: ${i}`);
        console.log(`    1st Leg: ${awbNum}`);
        console.log(`    2nd Leg: ${awb2nd}`);
        console.log(`    Pieces: ${num(lf, 'pieces')}, CW: ${num(lf, 'chargeable_weight')}`);
        console.log(`    On Hand: ${onHand}, Dispatched: ${dispatched}, WH Status: ${whStatus}`);
        console.log(`    Booking updated: ${b.updateTime}`);
        // Check audit log on line
        const auditLog = arr(lf, 'audit_log');
        if (auditLog.length > 0) {
          console.log(`    Audit log (${auditLog.length} entries):`);
          for (const entry of auditLog) {
            const ef = mapF(entry);
            console.log(`      ${str(ef, 'timestamp')} | ${str(ef, 'action')} | ${str(ef, 'user')} | ${str(ef, 'details')}`);
          }
        }
        // Check change_log on booking
        const changeLog = arr(b.fields, 'change_log');
        if (changeLog.length > 0) {
          console.log(`    Change log (${changeLog.length} entries):`);
          for (const entry of changeLog.slice(-10)) {
            const ef = mapF(entry);
            console.log(`      ${str(ef, 'timestamp')} | ${str(ef, 'action')} | ${str(ef, 'user')} | ${str(ef, 'details')}`);
          }
        }
        console.log('');
      }
    }
  }

  if (matchingBookings.length === 0) {
    console.log('  NO BOOKINGS FOUND for this AWB!\n');
  }

  // 2. Find the flight
  console.log('--- 2. FLIGHTS ---');
  for (const mb of matchingBookings) {
    if (!mb.flightId) continue;
    const flights = await runQuery('airfreight_flights', {
      where: { compositeFilter: { op: 'AND', filters: [] } },
      limit: 300,
    });
    const flight = flights.find(f => f.id === mb.flightId);
    if (flight) {
      console.log(`  Flight: ${flight.id}`);
      console.log(`    Number: ${str(flight.fields, 'flight_number')}`);
      console.log(`    Airline: ${str(flight.fields, 'airline')}`);
      console.log(`    DateTime: ${str(flight.fields, 'flight_datetime')}`);
      console.log(`    Status: ${str(flight.fields, 'status')}`);
      console.log('');
    }
  }

  // 3. Find doc_receptions for this AWB
  console.log('--- 3. DOC RECEPTIONS ---');
  const allDr = await fetchCollection('airfreight_doc_receptions');
  const matchingDr = allDr.filter(d => {
    const awb = str(d.fields, 'awb_number').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const awb2 = str(d.fields, 'awb_2nd_leg').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return awb === AWB_NORM || awb2 === AWB_NORM;
  });
  if (matchingDr.length === 0) {
    console.log('  NO DOC RECEPTIONS FOUND!\n');
  }
  for (const dr of matchingDr) {
    console.log(`  DocReception: ${dr.id}`);
    console.log(`    AWB: ${str(dr.fields, 'awb_number')}`);
    console.log(`    2nd Leg: ${str(dr.fields, 'awb_2nd_leg')}`);
    console.log(`    Flight ID: ${str(dr.fields, 'flight_id')}`);
    console.log(`    Booking ID: ${str(dr.fields, 'booking_id')}`);
    console.log(`    Status: ${str(dr.fields, 'status')}`);
    console.log(`    Pieces: ${num(dr.fields, 'pieces')}`);
    console.log(`    Created: ${dr.createTime}`);
    console.log(`    Updated: ${dr.updateTime}`);
    console.log(`    Force closed: ${bool(dr.fields, 'force_closed')}`);
    console.log('');
  }

  // 4. Find physical pieces for this AWB
  console.log('--- 4. PHYSICAL PIECES ---');
  const allPieces = await fetchCollection('airfreight_physical_pieces');
  const matchingPieces = allPieces.filter(p => {
    const awb = str(p.fields, 'awb_number').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return awb === AWB_NORM;
  });
  // Also check pieces linked to matching doc_receptions
  const drIds = new Set(matchingDr.map(d => d.id));
  const piecesByDr = allPieces.filter(p => drIds.has(str(p.fields, 'doc_reception_id')));
  const allMatchPieces = [...new Map([...matchingPieces, ...piecesByDr].map(p => [p.id, p])).values()];

  if (allMatchPieces.length === 0) {
    console.log('  NO PIECES FOUND!\n');
  } else {
    let inUld = 0, noUld = 0;
    for (const p of allMatchPieces) {
      const uldId = str(p.fields, 'uld_id');
      if (uldId) inUld++;
      else noUld++;
    }
    console.log(`  Total pieces: ${allMatchPieces.length} (in ULD: ${inUld}, no ULD: ${noUld})`);
    // Show first 10
    for (const p of allMatchPieces.slice(0, 15)) {
      const uldId = str(p.fields, 'uld_id');
      console.log(`    piece=${p.id} awb=${str(p.fields, 'awb_number')} dr=${str(p.fields, 'doc_reception_id')} uld=${uldId || 'NONE'} wt=${num(p.fields, 'weight_kg')}kg wh=${str(p.fields, 'warehouse_number')} updated=${p.updateTime}`);
    }
    if (allMatchPieces.length > 15) console.log(`    ... and ${allMatchPieces.length - 15} more`);
    console.log('');
  }

  // 5. Check sheet sync alerts for this AWB
  console.log('--- 5. SHEET SYNC ALERTS ---');
  const allAlerts = await fetchCollection('_sheet_sync_alerts');
  const matchingAlerts = allAlerts.filter(a => {
    const a1 = str(a.fields, 'awb_1st').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const a2 = str(a.fields, 'awb_2nd').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return a1 === AWB_NORM || a2 === AWB_NORM;
  });
  if (matchingAlerts.length === 0) {
    console.log('  No alerts found.\n');
  } else {
    console.log(`  ${matchingAlerts.length} alerts found:`);
    for (const a of matchingAlerts) {
      const diffs = arr(a.fields, 'diffs');
      const diffSummary = diffs.map(d => {
        const df = mapF(d);
        return `${str(df, 'field')}: "${str(df, 'sysVal')}" -> "${str(df, 'exVal')}"`
      }).join(', ')
      console.log(`    ${a.createTime} | type=${str(a.fields, 'alert_type')} | status=${str(a.fields, 'status')} | flight=${str(a.fields, 'flight_number')} | ${str(a.fields, 'message') || diffSummary}`);
    }
    console.log('');
  }

  // 6. Check sheet sync runs (recent)
  console.log('--- 6. RECENT SYNC RUNS ---');
  const allRuns = await fetchCollection('_sheet_sync_runs');
  const recentRuns = allRuns
    .filter(r => str(r.fields, 'status') !== '')
    .sort((a, b) => (b.createTime || '').localeCompare(a.createTime || ''))
    .slice(0, 5);
  for (const r of recentRuns) {
    console.log(`  ${r.createTime} | client=${str(r.fields, 'client_id')} | status=${str(r.fields, 'status')} | changes=${num(r.fields, 'changes_applied')} | alerts=${num(r.fields, 'alerts_generated')} | rows=${num(r.fields, 'rows_checked')}`);
  }
  console.log('');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
