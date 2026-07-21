// ═══ Data Integrity Checker — AAID Module ═══
// Detects orphaned documents, broken references, and data inconsistencies.

import { getCollectionCount, getCollectionSample, getDocument } from '../shared/firebase-client.mjs';

/**
 * Run data integrity checks across all major collections.
 */
export async function checkDataIntegrity() {
  const results = {
    checks: [],
    orphans: [],
    inconsistencies: [],
    stats: {},
  };

  // 1. Bookings → Flights reference integrity
  try {
    const bookings = await getCollectionSample('airfreight_bookings', 30);
    let orphanCount = 0;
    let validRefs = 0;

    for (const booking of bookings) {
      if (booking.flight_id && booking.flight_id !== '') {
        const flight = await getDocument('airfreight_flights', booking.flight_id);
        if (!flight) {
          orphanCount++;
          results.orphans.push({
            type: 'booking_missing_flight',
            booking_id: booking.id,
            flight_id: booking.flight_id,
          });
        } else {
          validRefs++;
        }
      }
    }

    results.stats.booking_flight_refs_checked = bookings.length;
    results.stats.booking_valid_flight_refs = validRefs;
    results.stats.booking_orphan_flight_refs = orphanCount;

    results.checks.push({
      name: 'Booking→Flight references',
      status: orphanCount > 0 ? 'warning' : 'ok',
      detail: `${orphanCount} orphan refs out of ${bookings.length} sampled`,
    });
  } catch (err) {
    results.checks.push({ name: 'Booking→Flight references', status: 'error', detail: err.message });
  }

  // 2. Doc Receptions → Bookings reference integrity
  try {
    const docs = await getCollectionSample('airfreight_doc_receptions', 20);
    let orphanCount = 0;

    for (const doc of docs) {
      if (doc.booking_id && doc.booking_id !== '') {
        const booking = await getDocument('airfreight_bookings', doc.booking_id);
        if (!booking) {
          orphanCount++;
          results.orphans.push({
            type: 'doc_reception_missing_booking',
            doc_id: doc.id,
            booking_id: doc.booking_id,
          });
        }
      }
    }

    results.checks.push({
      name: 'DocReception→Booking references',
      status: orphanCount > 0 ? 'warning' : 'ok',
      detail: `${orphanCount} orphan refs out of ${docs.length} sampled`,
    });
  } catch (err) {
    results.checks.push({ name: 'DocReception→Booking references', status: 'error', detail: err.message });
  }

  // 3. Delivery Orders → WS Orders reference integrity
  try {
    const dos = await getCollectionSample('ws_delivery_orders', 20);
    let orphanCount = 0;

    for (const deliveryOrder of dos) {
      if (deliveryOrder.order_id && deliveryOrder.order_id !== '') {
        const order = await getDocument('warehouse_service_orders', deliveryOrder.order_id);
        if (!order) {
          orphanCount++;
          results.orphans.push({
            type: 'delivery_order_missing_ws_order',
            do_id: deliveryOrder.id,
            order_id: deliveryOrder.order_id,
          });
        }
      }
    }

    results.checks.push({
      name: 'DeliveryOrder→WSOrder references',
      status: orphanCount > 0 ? 'warning' : 'ok',
      detail: `${orphanCount} orphan refs out of ${dos.length} sampled`,
    });
  } catch (err) {
    results.checks.push({ name: 'DeliveryOrder→WSOrder references', status: 'error', detail: err.message });
  }

  // 4. Collection size sanity checks (detect unexpected drops)
  try {
    const counts = {};
    const criticalCollections = [
      'airfreight_bookings', 'airfreight_flights', 'warehouse_receipts',
      'warehouse_service_orders', 'air_billing_charges',
    ];

    for (const col of criticalCollections) {
      counts[col] = await getCollectionCount(col);
    }

    results.stats.collection_counts = counts;

    // Flag any collection with 0 documents (unexpected)
    for (const [col, count] of Object.entries(counts)) {
      if (count === 0) {
        results.inconsistencies.push({
          type: 'empty_collection',
          collection: col,
          detail: 'Collection has 0 documents — possible data loss or misconfiguration',
        });
      }
    }

    results.checks.push({
      name: 'Collection size sanity',
      status: results.inconsistencies.length > 0 ? 'critical' : 'ok',
      detail: `${Object.keys(counts).length} collections checked`,
    });
  } catch (err) {
    results.checks.push({ name: 'Collection size sanity', status: 'error', detail: err.message });
  }

  // 5. Duplicate detection — same AWB in multiple bookings
  try {
    const bookings = await getCollectionSample('airfreight_bookings', 50);
    const awbMap = new Map();

    for (const booking of bookings) {
      const awb = booking.awb_number || booking.awb;
      if (awb && awb !== '') {
        if (!awbMap.has(awb)) {
          awbMap.set(awb, []);
        }
        awbMap.get(awb).push(booking.id);
      }
    }

    let duplicateAwbs = 0;
    for (const [awb, ids] of awbMap) {
      if (ids.length > 1) {
        duplicateAwbs++;
        results.inconsistencies.push({
          type: 'duplicate_awb',
          awb,
          booking_ids: ids,
          detail: `AWB ${awb} found in ${ids.length} bookings`,
        });
      }
    }

    results.stats.duplicate_awbs_in_sample = duplicateAwbs;
    results.checks.push({
      name: 'Duplicate AWB detection',
      status: duplicateAwbs > 0 ? 'warning' : 'ok',
      detail: `${duplicateAwbs} duplicate AWBs in ${bookings.length} sampled bookings`,
    });
  } catch (err) {
    results.checks.push({ name: 'Duplicate AWB detection', status: 'error', detail: err.message });
  }

  
  // 6. Holds consistency: booking awb_lines[].holds vs airfreight_holds collection
  try {
    const holdBookings = await getCollectionSample('airfreight_bookings', 50)
    const holdsCol = await getCollectionSample('airfreight_holds', 200)

    // Build lookup from airfreight_holds collection
    const colHoldKeys = new Set()
    for (const h of holdsCol) {
      const key = `${h.booking_id}|${h.awb_number}|${h.bag}|${h.box}`
      colHoldKeys.add(key)
    }

    let bookingHoldsTotal = 0
    let missingFromCollection = 0
    let placeholderHolds = 0

    for (const b of holdBookings) {
      if (!b.awb_lines) continue
      for (const line of b.awb_lines) {
        const holds = line.holds || []
        for (const h of holds) {
          bookingHoldsTotal++
          const bag = (h.bag || '').toLowerCase().trim()
          if (bag === 'hold' || bag === '' || !bag) {
            placeholderHolds++
            continue
          }
          const key = `${b.id}|${line.awb_number || ''}|${h.bag}|${h.box}`
          if (!colHoldKeys.has(key)) {
            missingFromCollection++
            if (missingFromCollection <= 5) {
              results.inconsistencies.push({
                type: 'hold_missing_from_collection',
                booking_id: b.id,
                awb_number: line.awb_number || '',
                bag: h.bag,
                box: h.box,
                detail: `Hold in booking not found in airfreight_holds collection`,
              })
            }
          }
        }
      }
    }

    results.stats.holds_in_bookings = bookingHoldsTotal
    results.stats.holds_in_collection = holdsCol.length
    results.stats.holds_placeholder = placeholderHolds
    results.stats.holds_missing_from_collection = missingFromCollection

    const holdStatus = missingFromCollection > 10 ? 'critical' :
                       missingFromCollection > 0 ? 'warning' : 'ok'
    results.checks.push({
      name: 'Holds sync consistency',
      status: holdStatus,
      detail: `${bookingHoldsTotal} holds in bookings, ${holdsCol.length} in collection, ${missingFromCollection} missing, ${placeholderHolds} placeholders`,
    })
  } catch (err) {
    results.checks.push({ name: 'Holds sync consistency', status: 'error', detail: err.message })
  }

  // 7. Detect stale placeholder holds (bag="hold" in airfreight_holds collection)
  try {
    const allHolds = await getCollectionSample('airfreight_holds', 200)
    let stalePlaceholders = 0

    for (const h of allHolds) {
      const bag = (h.bag || '').toLowerCase().trim()
      const box = (h.box || '').toLowerCase().trim()
      if (bag === 'hold' || box === 'hold') {
        stalePlaceholders++
        if (stalePlaceholders <= 3) {
          results.inconsistencies.push({
            type: 'stale_placeholder_hold',
            doc_id: h.id,
            booking_id: h.booking_id || '',
            awb_number: h.awb_number || '',
            detail: 'Placeholder hold (bag/box="hold") in airfreight_holds collection',
          })
        }
      }
    }

    results.stats.holds_stale_placeholders = stalePlaceholders
    results.checks.push({
      name: 'Stale placeholder holds',
      status: stalePlaceholders > 5 ? 'warning' : 'ok',
      detail: `${stalePlaceholders} placeholder holds in airfreight_holds collection`,
    })
  } catch (err) {
    results.checks.push({ name: 'Stale placeholder holds', status: 'error', detail: err.message })
  }

  return results;
}
