const admin = require('firebase-admin');
const serviceAccount = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'wms-mcl'
});

const db = admin.firestore();

async function main() {
  // Load ALL alerts once
  const allAlerts = await db.collection('_sheet_sync_alerts').get();
  console.log(`Loaded ${allAlerts.size} total alerts\n`);

  const allDocs = [];
  allAlerts.forEach(doc => {
    const d = doc.data();
    // Normalize timestamps
    for (const key of Object.keys(d)) {
      if (d[key] && d[key].toDate) d[key] = d[key].toDate().toISOString();
    }
    allDocs.push({ id: doc.id, ...d });
  });

  // ============================================================
  // 1. ALL removed_from_sheet alerts
  // ============================================================
  console.log('='.repeat(80));
  console.log('1. REMOVED_FROM_SHEET ALERTS');
  console.log('='.repeat(80));

  const removed = allDocs.filter(d => d.alert_type === 'removed_from_sheet');
  console.log(`Total: ${removed.length}`);

  const byFlight = {};
  removed.forEach(d => {
    const fn = d.flight_number || d.system_flight || 'UNKNOWN';
    if (!byFlight[fn]) byFlight[fn] = [];
    byFlight[fn].push(d);
  });

  const sorted = Object.entries(byFlight).sort((a, b) => b[1].length - a[1].length);
  console.log(`\nGrouped by flight (${Object.keys(byFlight).length} flights):`);
  console.log('\nTop 10 flights with most removals:');
  sorted.slice(0, 10).forEach(([fn, alerts], i) => {
    console.log(`  ${i + 1}. ${fn}: ${alerts.length} removals`);
    alerts.forEach(a => console.log(`      AWB: ${a.awb_1st} / ${a.awb_2nd}, ts: ${a.created_at || a.timestamp || 'N/A'}`));
  });

  // ============================================================
  // 2. applied_new alerts for the 8 AWBs on LA-0543
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('2. ALL ALERTS FOR 8 AWBs ON LA-0543 (booking 1fNfhx0xgCdlSFBZrDbQ)');
  console.log('='.repeat(80));

  const targetAwbs = [
    '369-10113110', '369-10113386', '172-05297600', '369-98083996',
    '369-99802522', '369-99802533', '369-10115136', '369-98158476'
  ];

  for (const awb of targetAwbs) {
    const matches = allDocs.filter(d =>
      d.awb_1st === awb || d.awb_2nd === awb ||
      (d.awb_1st || '').replace(/-/g, '') === awb.replace(/-/g, '') ||
      (d.awb_2nd || '').replace(/-/g, '') === awb.replace(/-/g, '')
    );

    console.log(`\n  AWB ${awb}: ${matches.length} alerts`);
    matches.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    matches.forEach(m => {
      console.log(`    [${m.alert_type}] flight=${m.flight_number}, sys_flight=${m.system_flight}, ts=${m.created_at || 'N/A'}, status=${m.status}, msg=${(m.message || '').substring(0, 120)}`);
      if (m.diffs && m.diffs.length > 0) {
        m.diffs.forEach(diff => {
          if (diff.field === 'Vuelo' || diff.field === 'Flight' || diff.field === '2nd Leg') {
            console.log(`      diff: ${diff.field}: ${diff.old_value || diff.system || ''} -> ${diff.new_value || diff.sheet || ''}`);
          }
        });
      }
    });
  }

  // ============================================================
  // 3. Distinct flights with LA-0543 or LA0543
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('3. DISTINCT FLIGHTS WITH LA-0543 / LA0543');
  console.log('='.repeat(80));

  // Try multiple collection names
  for (const collName of ['flights', 'airfreight_flights', 'ecommerce_flights']) {
    try {
      const snap = await db.collection(collName).get();
      if (snap.size > 0) {
        console.log(`\nCollection '${collName}': ${snap.size} total docs`);
        const la543 = [];
        snap.forEach(doc => {
          const d = doc.data();
          const fn = d.flight_number || d.flightNumber || d.flight || '';
          if (fn.includes('LA-0543') || fn.includes('LA0543') || fn.includes('la-0543') || fn.includes('la0543')) {
            la543.push({ id: doc.id, ...d });
          }
        });
        if (la543.length > 0) {
          console.log(`  Found ${la543.length} LA-0543 flights`);
          for (const f of la543) {
            console.log(`  ID: ${f.id}, flight_number: ${f.flight_number || f.flightNumber}, status: ${f.status}`);
            const dt = f.flight_datetime || f.flightDatetime || f.etd;
            console.log(`    datetime: ${dt && dt.toDate ? dt.toDate().toISOString() : dt}`);
          }
        }
      }
    } catch (e) {
      // skip
    }
  }

  // Search bookings collection directly
  console.log('\nSearching for booking 1fNfhx0xgCdlSFBZrDbQ...');
  const bookingDoc = await db.collection('bookings').doc('1fNfhx0xgCdlSFBZrDbQ').get();
  if (bookingDoc.exists) {
    const bd = bookingDoc.data();
    console.log(`  Found in 'bookings' collection:`);
    console.log(`  flight: ${bd.flight_number || bd.flightNumber || bd.flight}`);
    console.log(`  status: ${bd.status}`);
    console.log(`  Keys: ${Object.keys(bd).join(', ')}`);
  } else {
    console.log('  Not in root bookings collection');
  }

  // Check ecommerce_bookings
  const ecBooking = await db.collection('ecommerce_bookings').doc('1fNfhx0xgCdlSFBZrDbQ').get();
  if (ecBooking.exists) {
    const bd = ecBooking.data();
    console.log(`  Found in 'ecommerce_bookings':`);
    console.log(`  flight: ${bd.flight_number || bd.flightNumber || bd.flight}`);
    console.log(`  Keys: ${Object.keys(bd).join(', ')}`);
  }

  // Search all collections for LA-0543 via alerts data
  console.log('\nDistinct flights in _sheet_sync_alerts referencing LA-0543:');
  const la543Alerts = allDocs.filter(d =>
    (d.flight_number || '').includes('LA-0543') || (d.flight_number || '').includes('LA0543') ||
    (d.system_flight || '').includes('LA-0543') || (d.system_flight || '').includes('LA0543')
  );
  const la543FlightIds = new Set();
  la543Alerts.forEach(a => {
    la543FlightIds.add(a.flight_number);
    if (a.system_flight && a.system_flight !== a.flight_number) la543FlightIds.add(a.system_flight);
  });
  console.log(`  Distinct flight identifiers: ${[...la543FlightIds].join(', ')}`);
  console.log(`  Total alerts referencing LA-0543: ${la543Alerts.length}`);

  // Group by ETD to find distinct flight dates
  const byEtd = {};
  la543Alerts.forEach(a => {
    const etd = (a.etd || 'unknown').substring(0, 10);
    if (!byEtd[etd]) byEtd[etd] = new Set();
    byEtd[etd].add(a.awb_1st);
  });
  console.log('\n  LA-0543 alerts grouped by ETD date:');
  Object.entries(byEtd).sort().forEach(([etd, awbs]) => {
    console.log(`    ETD ${etd}: ${awbs.size} distinct AWBs`);
  });

  // ============================================================
  // 4. Movement alerts for 6 suspicious AWBs
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('4. ALL ALERTS FOR 6 SUSPICIOUS AWBs (looking for flight changes)');
  console.log('='.repeat(80));

  const suspiciousAwbs = [
    '369-10113110', '369-10113386', '369-99802522',
    '369-99802533', '369-10115136', '369-98158476'
  ];

  for (const awb of suspiciousAwbs) {
    const matches = allDocs.filter(d =>
      d.awb_1st === awb || d.awb_2nd === awb
    );

    console.log(`\n  AWB ${awb}: ${matches.length} alerts`);
    matches.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    matches.forEach(m => {
      console.log(`    [${m.alert_type}] flight=${m.flight_number}, sys_flight=${m.system_flight}, etd=${m.etd}, ts=${m.created_at || 'N/A'}, status=${m.status}`);
      console.log(`      msg: ${(m.message || 'N/A').substring(0, 150)}`);
      if (m.diffs && m.diffs.length > 0) {
        m.diffs.forEach(diff => {
          console.log(`      diff: ${diff.field}: "${diff.old_value || diff.system || ''}" -> "${diff.new_value || diff.sheet || ''}"`);
        });
      }
    });
  }

  // Also show all flight_moved alerts
  console.log('\n  All flight_moved alerts:');
  const moved = allDocs.filter(d => d.alert_type === 'flight_moved');
  console.log(`  Total: ${moved.length}`);
  moved.forEach(m => {
    console.log(`    AWB=${m.awb_1st}, flight=${m.flight_number}, sys_flight=${m.system_flight}, msg=${(m.message || '').substring(0, 150)}`);
  });

  // ============================================================
  // 5. System-wide alert counts by type
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('5. SYSTEM-WIDE ALERT COUNTS BY TYPE');
  console.log('='.repeat(80));
  console.log(`Total alerts: ${allDocs.length}`);

  const byType = {};
  allDocs.forEach(d => {
    const t = d.alert_type || 'UNKNOWN';
    byType[t] = (byType[t] || 0) + 1;
  });

  Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });

  // By status
  console.log('\nBy status:');
  const byStatus = {};
  allDocs.forEach(d => {
    const s = d.status || 'UNKNOWN';
    byStatus[s] = (byStatus[s] || 0) + 1;
  });
  Object.entries(byStatus).sort((a, b) => b[1] - a[1]).forEach(([s, c]) => {
    console.log(`  ${s}: ${c}`);
  });

  // Pending alerts breakdown
  console.log('\nPending alerts by type:');
  const pending = allDocs.filter(d => d.status === 'pending');
  const pendByType = {};
  pending.forEach(d => {
    const t = d.alert_type || 'UNKNOWN';
    pendByType[t] = (pendByType[t] || 0) + 1;
  });
  Object.entries(pendByType).sort((a, b) => b[1] - a[1]).forEach(([t, c]) => {
    console.log(`  ${t}: ${c}`);
  });

  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS COMPLETE');
  console.log('='.repeat(80));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
