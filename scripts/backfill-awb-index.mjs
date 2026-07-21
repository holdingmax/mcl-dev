#!/usr/bin/env node
/**
 * One-time backfill script: adds awb_numbers_normalized to existing airfreight_bookings
 * and awb_normalized to existing airfreight_doc_receptions.
 *
 * Run from project root:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/creds.json node scripts/backfill-awb-index.mjs
 *
 * Or locally with Firebase emulator / authenticated gcloud CLI.
 */

import { Firestore } from '@google-cloud/firestore';

const projectId = process.env.FIREBASE_PROJECT_ID || 'wms-mcl';
const db = new Firestore({ projectId });

function normalize(val) {
  return (val || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function computeNormalized(booking) {
  const set = new Set();
  if (booking.booking_type === 'simple') {
    if (booking.awb_1st_leg) set.add(normalize(booking.awb_1st_leg));
    if (booking.awb_2nd_leg) set.add(normalize(booking.awb_2nd_leg));
  } else {
    for (const line of booking.awb_lines || []) {
      if (line.awb_number) set.add(normalize(line.awb_number));
      if (line.awb_2nd_leg) set.add(normalize(line.awb_2nd_leg));
    }
  }
  set.delete('');
  return Array.from(set);
}

async function backfillBookings() {
  const snap = await db.collection('airfreight_bookings').get();
  let updated = 0, skipped = 0;
  const batch = [];

  for (const d of snap.docs) {
    const data = d.data();
    const normalized = computeNormalized(data);

    // Skip if already has the field with same values
    const existing = data.awb_numbers_normalized;
    if (existing && JSON.stringify(existing.sort()) === JSON.stringify(normalized.sort())) {
      skipped++;
      continue;
    }

    batch.push(d.ref.update({ awb_numbers_normalized: normalized }));
    updated++;

    // Firestore batch limit
    if (batch.length >= 400) {
      await Promise.all(batch);
      batch.length = 0;
      console.log(`  ... ${updated} bookings updated so far`);
    }
  }

  if (batch.length > 0) await Promise.all(batch);
  console.log(`Bookings: ${updated} updated, ${skipped} skipped (already indexed). Total: ${snap.size}`);
}

async function backfillDocReceptions() {
  const snap = await db.collection('airfreight_doc_receptions').get();
  let updated = 0, skipped = 0;
  const batch = [];

  for (const d of snap.docs) {
    const data = d.data();
    const awbNorm = normalize(data.awb_number) || normalize(data.awb_2nd_leg) || normalize(data.awb_1st_leg);

    if (data.awb_normalized === awbNorm) {
      skipped++;
      continue;
    }

    batch.push(d.ref.update({ awb_normalized: awbNorm }));
    updated++;

    if (batch.length >= 400) {
      await Promise.all(batch);
      batch.length = 0;
      console.log(`  ... ${updated} doc_receptions updated so far`);
    }
  }

  if (batch.length > 0) await Promise.all(batch);
  console.log(`Doc Receptions: ${updated} updated, ${skipped} skipped. Total: ${snap.size}`);
}

async function main() {
  console.log('=== AWB Index Backfill ===');
  console.log(`Project: ${projectId}`);
  console.log('');

  console.log('1/2 Backfilling airfreight_bookings...');
  await backfillBookings();
  console.log('');

  console.log('2/2 Backfilling airfreight_doc_receptions...');
  await backfillDocReceptions();
  console.log('');

  console.log('Done! You can now enable the awb_search_v2 feature flag.');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
