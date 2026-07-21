// ═══ Billing Validator — AAID Module ═══
// Cross-validates billing charges against source documents.

import { getCollectionCount, getCollectionSample, getChargesForFlight, getChargesForWR } from '../shared/firebase-client.mjs';

/**
 * Run billing integrity checks across air and warehouse services.
 */
export async function validateBilling() {
  const results = {
    checks: [],
    mismatches: [],
    warnings: [],
    stats: {},
  };

  // 1. Air billing: verify charges exist for recent flights
  try {
    const flights = await getCollectionSample('airfreight_flights', 20);
    let flightsWithCharges = 0;
    let flightsWithoutCharges = 0;
    let totalCharges = 0;

    for (const flight of flights) {
      const charges = await getChargesForFlight(flight.id);
      if (charges.length > 0) {
        flightsWithCharges++;
        totalCharges += charges.length;

        // Verify no duplicate charges for same booking+type
        const chargeKeys = charges.map(c => `${c.booking_id}_${c.charge_type}`);
        const uniqueKeys = new Set(chargeKeys);
        if (uniqueKeys.size < chargeKeys.length) {
          results.mismatches.push({
            type: 'duplicate_charge',
            entity: 'air_billing',
            flight_id: flight.id,
            detail: `${chargeKeys.length - uniqueKeys.size} duplicate charge(s) detected`,
          });
        }
      } else {
        flightsWithoutCharges++;
      }
    }

    results.stats.flights_sampled = flights.length;
    results.stats.flights_with_charges = flightsWithCharges;
    results.stats.flights_without_charges = flightsWithoutCharges;
    results.stats.total_air_charges_sampled = totalCharges;

    results.checks.push({
      name: 'Air billing coverage',
      status: flightsWithoutCharges > flights.length * 0.5 ? 'warning' : 'ok',
      detail: `${flightsWithCharges}/${flights.length} sampled flights have charges`,
    });
  } catch (err) {
    results.checks.push({ name: 'Air billing coverage', status: 'error', detail: err.message });
  }

  // 2. WS billing: verify charges exist for recent WRs
  try {
    const wrs = await getCollectionSample('warehouse_receipts', 20);
    let wrsWithCharges = 0;
    let wrsWithoutCharges = 0;

    for (const wr of wrs) {
      const charges = await getChargesForWR(wr.id);
      if (charges.length > 0) {
        wrsWithCharges++;
      } else {
        wrsWithoutCharges++;
      }
    }

    results.stats.wrs_sampled = wrs.length;
    results.stats.wrs_with_charges = wrsWithCharges;

    results.checks.push({
      name: 'WS billing coverage',
      status: wrsWithoutCharges > wrs.length * 0.5 ? 'warning' : 'ok',
      detail: `${wrsWithCharges}/${wrs.length} sampled WRs have charges`,
    });
  } catch (err) {
    results.checks.push({ name: 'WS billing coverage', status: 'error', detail: err.message });
  }

  // 3. Pending charges age check
  try {
    const pendingAir = await getCollectionCount('air_billing_charges', [['status', '==', 'pending']]);
    const totalAir = await getCollectionCount('air_billing_charges');
    const pendingRatio = totalAir > 0 ? (pendingAir / totalAir) : 0;

    results.stats.air_pending_ratio = pendingRatio.toFixed(3);
    results.checks.push({
      name: 'Air pending ratio',
      status: pendingRatio > 0.5 ? 'warning' : 'ok',
      detail: `${pendingAir}/${totalAir} charges pending (${(pendingRatio * 100).toFixed(1)}%)`,
    });
  } catch (err) {
    results.checks.push({ name: 'Air pending ratio', status: 'error', detail: err.message });
  }

  // 4. Zero-amount charges (possible billing errors)
  try {
    const zeroCharges = await getCollectionCount('air_billing_charges', [['amount', '==', 0]]);
    results.stats.zero_amount_charges = zeroCharges;
    results.checks.push({
      name: 'Zero-amount charges',
      status: zeroCharges > 10 ? 'warning' : 'ok',
      detail: `${zeroCharges} charges with amount=0`,
    });
  } catch {
    // Field might not exist or be indexed differently
  }

  return results;
}
