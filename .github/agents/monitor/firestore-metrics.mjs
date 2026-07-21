// ═══ Firestore Metrics Collector — ADMP Module ═══
// Collects Firestore document counts and activity metrics for daily monitoring.

import { getCollectionCount, getRecentDocuments } from '../shared/firebase-client.mjs';

/**
 * Collect core Firestore metrics: collection sizes, recent activity, data health.
 */
export async function collectFirestoreMetrics() {
  const metrics = {};

  // 1. Total document counts per collection
  const collections = [
    'airfreight_bookings',
    'airfreight_flights',
    'airfreight_doc_receptions',
    'air_billing_charges',
    'warehouse_receipts',
    'billing_charges',
    'warehouse_service_orders',
    'ws_billing_charges',
    'ws_delivery_orders',
    'ws_delivery_tracking',
    'delivery_orders',
    'driver_queue',
  ];

  for (const col of collections) {
    try {
      metrics[`${col}_total`] = await getCollectionCount(col);
    } catch {
      metrics[`${col}_total`] = -1;
    }
  }

  // 2. Recent activity (last 24h)
  const activityCollections = [
    'airfreight_bookings',
    'airfreight_doc_receptions',
    'air_billing_charges',
    'warehouse_receipts',
    'warehouse_service_orders',
  ];

  for (const col of activityCollections) {
    try {
      const docs = await getRecentDocuments(col, 24);
      metrics[`${col}_24h`] = docs.length;
    } catch {
      metrics[`${col}_24h`] = -1;
    }
  }

  // 3. Billing status breakdown
  // NOTE: Only count pending charges from 2026-05-01 onwards (invoice issuance start date).
  // Charges before that date were not invoiced through this system.
  // Payments are tracked externally — air_charges_paid is NOT collected.
  try {
    metrics.air_charges_pending = await getCollectionCount('air_billing_charges', [
      ['status', '==', 'pending'],
      ['created_at', '>=', '2026-05-01T00:00:00.000Z'],
    ]);
    metrics.air_charges_invoiced = await getCollectionCount('air_billing_charges', [['status', '==', 'invoiced']]);
  } catch {
    metrics.air_charges_pending = -1;
  }

  // 4. Warehouse Services status breakdown
  try {
    metrics.ws_orders_active = await getCollectionCount('warehouse_service_orders', [['status', '==', 'active']]);
    metrics.ws_orders_completed = await getCollectionCount('warehouse_service_orders', [['status', '==', 'completed']]);
  } catch {
    metrics.ws_orders_active = -1;
  }

  // 5. Data health indicators
  try {
    // Bookings without flight assignment
    metrics.bookings_no_flight = await getCollectionCount('airfreight_bookings', [['flight_id', '==', '']]);
  } catch {
    metrics.bookings_no_flight = -1;
  }

  try {
    // Doc receptions without booking match
    metrics.doc_receptions_unmatched = await getCollectionCount('airfreight_doc_receptions', [['booking_id', '==', '']]);
  } catch {
    metrics.doc_receptions_unmatched = -1;
  }

  metrics.collected_at = new Date().toISOString();
  return metrics;
}
