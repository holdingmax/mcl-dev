#!/usr/bin/env node
/**
 * Cleanup duplicate WS invoices for SO-260701-0001
 *
 * Problem: 5 invoices (WS-INV-0034..0038) created for the same SO due to race condition.
 * Fix: Keep the FIRST invoice (lowest number), delete the rest, ensure charges point to the kept one.
 *
 * Run:  node scripts/cleanup-ws-duplicate-invoices.mjs
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

async function patchDoc(docName, fieldsToUpdate) {
  const updateMask = Object.keys(fieldsToUpdate).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/${docName}?${updateMask}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fieldsToUpdate }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PATCH ${docName} failed: ${res.status} ${err}`);
  }
}

function strVal(fields, key) {
  return fields[key]?.stringValue || '';
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  TOKEN = await getAccessToken();
  console.log('✓ Auth OK\n');

  // 1. Fetch all WS invoices
  console.log('Fetching ws_invoices...');
  const allInvoices = await fetchCollection('ws_invoices');
  console.log(`  Total invoices: ${allInvoices.length}`);

  // 2. Group invoices by so_id to find duplicates
  const bySO = new Map();
  for (const inv of allInvoices) {
    const soId = strVal(inv.fields, 'so_id');
    if (!soId) continue;
    if (!bySO.has(soId)) bySO.set(soId, []);
    bySO.get(soId).push(inv);
  }

  // Find SOs with multiple invoices
  const duplicates = [];
  for (const [soId, invoices] of bySO) {
    if (invoices.length > 1) {
      // Sort by invoice_number to keep the first
      invoices.sort((a, b) => strVal(a.fields, 'invoice_number').localeCompare(strVal(b.fields, 'invoice_number')));
      duplicates.push({ soId, invoices });
    }
  }

  if (duplicates.length === 0) {
    console.log('\n✓ No duplicate invoices found. Nothing to clean.');
    return;
  }

  console.log(`\n⚠ Found ${duplicates.length} SO(s) with duplicate invoices:\n`);
  for (const { soId, invoices } of duplicates) {
    const soNum = strVal(invoices[0].fields, 'so_number');
    const client = strVal(invoices[0].fields, 'client_name');
    console.log(`  SO: ${soNum} (${soId}) — Client: ${client}`);
    console.log(`  KEEP:   ${strVal(invoices[0].fields, 'invoice_number')} (${invoices[0].id})`);
    for (let i = 1; i < invoices.length; i++) {
      console.log(`  DELETE: ${strVal(invoices[i].fields, 'invoice_number')} (${invoices[i].id})`);
    }
    console.log('');
  }

  // 3. Fetch billing charges to fix references
  console.log('Fetching ws_billing_charges...');
  const allCharges = await fetchCollection('ws_billing_charges');
  console.log(`  Total charges: ${allCharges.length}`);

  // 4. Process each duplicate group
  for (const { soId, invoices } of duplicates) {
    const keep = invoices[0];
    const keepId = keep.id;
    const keepNumber = strVal(keep.fields, 'invoice_number');
    const toDelete = invoices.slice(1);

    const soNum = strVal(keep.fields, 'so_number');
    console.log(`\n── Processing ${soNum} ──`);
    console.log(`  Keeping: ${keepNumber} (${keepId})`);

    // Delete duplicate invoices
    for (const dup of toDelete) {
      const dupNum = strVal(dup.fields, 'invoice_number');
      console.log(`  Deleting: ${dupNum} (${dup.id})...`);
      await deleteDocument(dup.name);
      console.log(`    ✓ Deleted ${dupNum}`);
    }

    // Fix charges that point to deleted invoices — ensure they point to the kept one
    const chargesForSO = allCharges.filter(c => strVal(c.fields, 'so_id') === soId && strVal(c.fields, 'status') === 'invoiced');
    const deletedIds = new Set(toDelete.map(d => d.id));

    for (const charge of chargesForSO) {
      const currentInvId = strVal(charge.fields, 'invoice_id');
      const currentInvNum = strVal(charge.fields, 'invoice_number');

      if (deletedIds.has(currentInvId) || currentInvId !== keepId) {
        console.log(`  Fixing charge ${charge.id}: ${currentInvNum} → ${keepNumber}`);
        await patchDoc(charge.name, {
          invoice_id: { stringValue: keepId },
          invoice_number: { stringValue: keepNumber },
        });
        console.log(`    ✓ Updated`);
      }
    }
  }

  // 5. Reset invoice sequence to avoid gaps (optional: set to max existing)
  const maxNum = Math.max(...allInvoices.map(inv => {
    const num = strVal(inv.fields, 'invoice_number');
    const match = num.match(/WS-INV-(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }));

  // After deleting duplicates, the max valid invoice number should be recalculated
  // The kept invoices are: all non-duplicate + first of each duplicate group
  const keptIds = new Set(duplicates.map(d => d.invoices[0].id));
  const deletedIds = new Set(duplicates.flatMap(d => d.invoices.slice(1).map(i => i.id)));
  const remainingInvoices = allInvoices.filter(i => !deletedIds.has(i.id));
  const maxRemaining = Math.max(...remainingInvoices.map(inv => {
    const num = strVal(inv.fields, 'invoice_number');
    const match = num.match(/WS-INV-(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }));

  console.log(`\n── Invoice sequence ──`);
  console.log(`  Current max invoice number: WS-INV-${String(maxNum).padStart(4, '0')}`);
  console.log(`  After cleanup max: WS-INV-${String(maxRemaining).padStart(4, '0')}`);
  console.log(`  (Sequence will remain at ${maxNum} to avoid number reuse — next invoice will be WS-INV-${String(maxNum + 1).padStart(4, '0')})`);

  console.log('\n✓ Cleanup complete!');
  console.log(`  Deleted ${duplicates.reduce((s, d) => s + d.invoices.length - 1, 0)} duplicate invoice(s)`);
  console.log(`  Kept ${duplicates.length} original invoice(s)`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
