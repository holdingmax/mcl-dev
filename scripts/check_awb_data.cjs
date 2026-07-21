const admin = require('firebase-admin');
const serviceAccount = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function main() {
  console.log('=== AWB Data Check in Firestore bookings ===\n');

  const snap = await db.collection('airfreight_bookings')
    .orderBy('created_at', 'desc')
    .limit(100)
    .get();

  console.log(`Total bookings fetched: ${snap.size}\n`);

  let hasAwbLines = 0;
  let emptyAwbLines = 0;
  let missingAwbLines = 0;
  let hasAwb1stLeg = 0;

  const rows = [];

  snap.forEach(doc => {
    const d = doc.data();
    const id = doc.id;
    const type = d.booking_type || '(none)';
    const flight = d.flight_id || d.flight || '(none)';
    const client = d.client_name || d.client || '(none)';

    let awbStatus, awbCount, sampleAwb;

    if (d.awb_lines === undefined || d.awb_lines === null) {
      awbStatus = 'MISSING';
      awbCount = '-';
      sampleAwb = '-';
      missingAwbLines++;
    } else if (Array.isArray(d.awb_lines) && d.awb_lines.length === 0) {
      awbStatus = 'EMPTY_ARRAY';
      awbCount = 0;
      sampleAwb = '-';
      emptyAwbLines++;
    } else if (Array.isArray(d.awb_lines) && d.awb_lines.length > 0) {
      awbStatus = 'EXISTS';
      awbCount = d.awb_lines.length;
      const first = d.awb_lines[0];
      sampleAwb = first.awb_number || first.awb || first.hawb || JSON.stringify(first).substring(0, 80);
      hasAwbLines++;
    } else {
      awbStatus = `OTHER(${typeof d.awb_lines})`;
      awbCount = '-';
      sampleAwb = String(d.awb_lines).substring(0, 80);
      missingAwbLines++;
    }

    const has1stLeg = d.awb_1st_leg !== undefined ? 'YES' : 'no';
    if (d.awb_1st_leg !== undefined) hasAwb1stLeg++;

    rows.push({ id, type, flight, client, awbStatus, awbCount, sampleAwb, has1stLeg });
  });

  // Print table
  console.log('ID | Type | Flight | Client | awb_lines | Count | Sample AWB | awb_1st_leg');
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(`${r.id} | ${r.type} | ${r.flight} | ${r.client} | ${r.awbStatus} | ${r.awbCount} | ${r.sampleAwb} | ${r.has1stLeg}`);
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total bookings checked: ${snap.size}`);
  console.log(`With awb_lines (non-empty): ${hasAwbLines}`);
  console.log(`With awb_lines (empty array): ${emptyAwbLines}`);
  console.log(`Missing awb_lines field: ${missingAwbLines}`);
  console.log(`With awb_1st_leg field: ${hasAwb1stLeg}`);

  // Breakdown by type
  const byType = {};
  for (const r of rows) {
    if (!byType[r.type]) byType[r.type] = { total: 0, has: 0, empty: 0, missing: 0 };
    byType[r.type].total++;
    if (r.awbStatus === 'EXISTS') byType[r.type].has++;
    else if (r.awbStatus === 'EMPTY_ARRAY') byType[r.type].empty++;
    else byType[r.type].missing++;
  }
  console.log('\n=== BY BOOKING TYPE ===');
  for (const [type, counts] of Object.entries(byType)) {
    console.log(`${type}: ${counts.total} total | ${counts.has} with data | ${counts.empty} empty | ${counts.missing} missing`);
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
