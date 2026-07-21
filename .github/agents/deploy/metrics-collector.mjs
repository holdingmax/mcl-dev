// ═══ Metrics Collector for Deploy Agent ═══

import { getCollectionCount, getRecentDocuments, getCollectionSample, initFirebase } from '../shared/firebase-client.mjs';

export async function collectMetrics() {
  const db = initFirebase();
  const now = new Date();
  const raw = {};
  const summary = [];

  // 1. Collection sizes (proxy for Firestore reads pressure)
  const collections = [
    'airfreight_bookings', 'airfreight_flights', 'airfreight_doc_receptions',
    'air_billing_charges', 'delivery_orders', 'warehouse_receipts',
    'billing_charges', 'warehouse_service_orders', 'ws_billing_charges',
    'ws_delivery_orders', 'ws_delivery_tracking', 'driver_queue',
  ];

  for (const col of collections) {
    try {
      const count = await getCollectionCount(col);
      raw[`count_${col}`] = count;
      summary.push({ name: `${col} count`, value: count, status: 'ok' });
    } catch (err) {
      raw[`count_${col}`] = -1;
      summary.push({ name: `${col} count`, value: 'ERROR', status: 'error' });
    }
  }

  // 2. Recent activity (last 24h)
  const recentBookings = await safeCount('airfreight_bookings', 24);
  const recentDocs = await safeCount('airfreight_doc_receptions', 24);
  const recentCharges = await safeCount('air_billing_charges', 24);
  const recentWRs = await safeCount('warehouse_receipts', 24);

  raw.recent_bookings_24h = recentBookings;
  raw.recent_doc_receptions_24h = recentDocs;
  raw.recent_charges_24h = recentCharges;
  raw.recent_wrs_24h = recentWRs;

  summary.push(
    { name: 'Bookings (24h)', value: recentBookings, status: 'ok' },
    { name: 'Doc Receptions (24h)', value: recentDocs, status: 'ok' },
    { name: 'Air Charges (24h)', value: recentCharges, status: 'ok' },
    { name: 'WRs (24h)', value: recentWRs, status: 'ok' },
  );

  // 3. Billing consistency check (sample)
  try {
    const pendingCharges = await getCollectionCount('air_billing_charges', [['status', '==', 'pending']]);
    const invoicedCharges = await getCollectionCount('air_billing_charges', [['status', '==', 'invoiced']]);
    raw.air_charges_pending = pendingCharges;
    raw.air_charges_invoiced = invoicedCharges;
    summary.push(
      { name: 'Air charges pending', value: pendingCharges, status: pendingCharges > 5000 ? 'warning' : 'ok' },
      { name: 'Air charges invoiced', value: invoicedCharges, status: 'ok' },
    );
  } catch { /* ignore */ }

  // 4. Feature flags state
  try {
    const { getFeatureFlags } = await import('../shared/firebase-client.mjs');
    const flags = await getFeatureFlags();
    raw.feature_flags = flags;
    summary.push({ name: 'Feature flags', value: JSON.stringify(flags).substring(0, 80), status: 'ok' });
  } catch { /* ignore */ }

  // 5. Error indicators
  try {
    // Check for orphaned documents (bookings without flight_id)
    const orphanBookings = await getCollectionCount('airfreight_bookings', [['flight_id', '==', '']]);
    raw.orphan_bookings_no_flight = orphanBookings;
    summary.push({
      name: 'Bookings sin flight',
      value: orphanBookings,
      status: orphanBookings > 50 ? 'warning' : 'ok',
    });
  } catch { /* ignore */ }

  raw.collected_at = now.toISOString();
  return { raw, summary };
}

async function safeCount(collection, hours) {
  try {
    const docs = await getRecentDocuments(collection, hours);
    return docs.length;
  } catch {
    return -1;
  }
}
