// ═══ Performance Checker — ADMP Module ═══
// Checks build size, bundle analysis, and runtime performance indicators.

import { getCollectionCount, getRecentDocuments } from '../shared/firebase-client.mjs';

/**
 * Collect performance-related metrics from Firestore usage patterns.
 * Since we can't run Lighthouse from GitHub Actions against a live site,
 * we use Firestore activity as a proxy for performance health.
 */
export async function collectPerformanceMetrics() {
  const metrics = {};

  // 1. Query complexity indicators — collections with high read pressure
  const heavyCollections = [
    { name: 'airfreight_bookings', threshold: 5000 },
    { name: 'airfreight_flights', threshold: 2000 },
    { name: 'air_billing_charges', threshold: 10000 },
    { name: 'warehouse_receipts', threshold: 3000 },
    { name: 'warehouse_service_orders', threshold: 2000 },
  ];

  for (const col of heavyCollections) {
    try {
      const count = await getCollectionCount(col.name);
      metrics[`perf_${col.name}_count`] = count;
      metrics[`perf_${col.name}_over_threshold`] = count > col.threshold;
    } catch {
      metrics[`perf_${col.name}_count`] = -1;
    }
  }

  // 2. Activity rate — documents created in last 1h vs 24h (burst detection)
  try {
    const bookings1h = await getRecentDocuments('airfreight_bookings', 1);
    const bookings24h = await getRecentDocuments('airfreight_bookings', 24);
    metrics.bookings_1h = bookings1h.length;
    metrics.bookings_24h = bookings24h.length;
    metrics.bookings_burst_ratio = bookings24h.length > 0
      ? (bookings1h.length / (bookings24h.length / 24)).toFixed(2)
      : 0;
  } catch {
    metrics.bookings_1h = -1;
    metrics.bookings_24h = -1;
  }

  // 3. Pending billing charges (indicator of processing backlog)
  try {
    const pendingAir = await getCollectionCount('air_billing_charges', [['status', '==', 'pending']]);
    const pendingWS = await getCollectionCount('ws_billing_charges', [['status', '==', 'pending']]);
    metrics.pending_air_charges = pendingAir;
    metrics.pending_ws_charges = pendingWS;
    metrics.total_pending_charges = pendingAir + pendingWS;
  } catch {
    metrics.total_pending_charges = -1;
  }

  // 4. Listener pressure indicators — large collections that use onSnapshot
  // These collections have real-time listeners and their size affects client memory
  const listenerCollections = [
    'airfreight_bookings',
    'airfreight_flights',
    'warehouse_service_orders',
    'driver_queue',
  ];

  let totalListenerDocs = 0;
  for (const col of listenerCollections) {
    try {
      const count = await getCollectionCount(col);
      metrics[`listener_pressure_${col}`] = count;
      totalListenerDocs += count;
    } catch {
      // Already counted above, skip errors
    }
  }
  metrics.total_listener_docs = totalListenerDocs;

  // 5. Data growth rate (compare recent 24h creation vs total)
  try {
    const totalBookings = metrics.perf_airfreight_bookings_count || await getCollectionCount('airfreight_bookings');
    const recent = metrics.bookings_24h >= 0 ? metrics.bookings_24h : 0;
    metrics.daily_growth_rate_bookings = totalBookings > 0
      ? ((recent / totalBookings) * 100).toFixed(2)
      : 0;
  } catch {
    metrics.daily_growth_rate_bookings = -1;
  }

  return metrics;
}
