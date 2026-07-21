const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // 1. Find the LA-0543 flight (ID from URL: kuKhnv19oIvQr8KkXbCD)
  const flightId = 'kuKhnv19oIvQr8KkXbCD'
  const fDoc = await db.collection('airfreight_flights').doc(flightId).get()
  if (fDoc.exists) {
    const f = fDoc.data()
    console.log(`Flight: ${f.airline} #${f.flight_number}, ETD: ${f.flight_datetime}, status: ${f.flight_status || f.status}`)
  }

  // 2. Get all bookings for this flight
  const bSnap = await db.collection('airfreight_bookings').where('flight_id', '==', flightId).get()
  console.log(`\nBookings: ${bSnap.size}`)
  for (const bDoc of bSnap.docs) {
    const b = bDoc.data()
    console.log(`  ${bDoc.id}: type=${b.booking_type}, client=${b.client_name}, awb_lines=${(b.awb_lines||[]).length}`)
    for (const line of (b.awb_lines || [])) {
      console.log(`    AWB: ${line.awb_number} / ${line.awb_2nd_leg || ''} — ${line.pieces} pcs, ${line.chargeable_weight} CHW`)
      // Check if this line has sync metadata
      if (line.created_by || line.moved_by || line.source) {
        console.log(`      source: created_by=${line.created_by||''}, moved_by=${line.moved_by||''}, source=${line.source||''}`)
      }
    }
  }

  // 3. Check sync alerts for this flight
  console.log('\n=== SYNC ALERTS ===')
  const alertSnap = await db.collection('_sheet_sync_alerts')
    .where('flight_id', '==', flightId)
    .get()
  console.log(`Alerts by flight_id: ${alertSnap.size}`)
  for (const d of alertSnap.docs) {
    const a = d.data()
    console.log(`  [${a.alert_type}] AWB: ${a.awb_1st||a.awb||''} flight: ${a.flight_number||''} at: ${a.created_at||''} msg: ${a.message||''}`)
  }

  // Also check by flight_number
  const alertSnap2 = await db.collection('_sheet_sync_alerts')
    .where('flight_number', '==', 'LA-0543')
    .get()
  console.log(`\nAlerts by flight_number LA-0543: ${alertSnap2.size}`)
  const seen = new Set(alertSnap.docs.map(d => d.id))
  for (const d of alertSnap2.docs) {
    if (seen.has(d.id)) continue
    const a = d.data()
    console.log(`  [${a.alert_type}] AWB: ${a.awb_1st||a.awb||''} at: ${a.created_at||''} msg: ${a.message||''}`)
  }

  // 4. Check removed_from_sheet alerts
  const removedSnap = await db.collection('_sheet_sync_alerts')
    .where('alert_type', '==', 'removed_from_sheet')
    .limit(50)
    .get()
  console.log(`\n=== REMOVED FROM SHEET ALERTS (all, last 50) ===`)
  const la543Awbs = new Set(['369-10113110','369-10113386','369-99802522','369-99802533','369-10115136','369-98158476'])
  for (const d of removedSnap.docs) {
    const a = d.data()
    const awb = a.awb_1st || a.awb || ''
    if (la543Awbs.has(awb) || (a.flight_number||'').includes('0543')) {
      console.log(`  [${a.alert_type}] AWB: ${awb} flight: ${a.flight_number||''} at: ${a.created_at||''} client: ${a.client||''}`)
    }
  }

  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
