const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  const nullFlightIds = [
    '1R3zCZXwW1IiUlf14WXP', // Unknown K-4243
    'CouNljT6QL7kT9CmBN2O', // Unknown 5Y538
    '28W72glznCydNkk51556',  // PENDING PENDING
  ]

  console.log('=== PRE-FIX STATE ===')
  for (const id of nullFlightIds) {
    const doc = await db.collection('airfreight_flights').doc(id).get()
    if (!doc.exists) { console.log(`  ${id}: NOT FOUND`); continue }
    const d = doc.data()
    console.log(`  ${id}: airline=${d.airline}, flight_number=${d.flight_number}, status=${d.status}, flight_datetime=${d.flight_datetime}, created_at=${d.created_at}`)

    // Check if any bookings reference this flight
    const bSnap = await db.collection('airfreight_bookings').where('flight_id', '==', id).get()
    console.log(`    -> ${bSnap.size} bookings reference this flight`)
    if (bSnap.size > 0) {
      for (const bDoc of bSnap.docs) {
        const b = bDoc.data()
        console.log(`       booking ${bDoc.id}: type=${b.booking_type}, client=${b.client_name}, awb_lines=${(b.awb_lines||[]).length}`)
      }
    }
  }

  console.log('\n=== APPLYING FIX ===')
  for (const id of nullFlightIds) {
    const doc = await db.collection('airfreight_flights').doc(id).get()
    if (!doc.exists) continue
    const d = doc.data()

    // All 3 are garbage/auto-generated with no valid datetime
    // Cancel them so BookingNew's filter (status === 'open') excludes them
    await db.collection('airfreight_flights').doc(id).update({
      status: 'cancelled',
      _fix_note: 'Cancelled by hotfix: flight_datetime was null, caused BookingNew crash',
      _fix_date: new Date().toISOString(),
      _original_status: d.status || 'unknown',
    })
    console.log(`  ${id} (${d.airline} ${d.flight_number}): status changed open -> cancelled`)
  }

  console.log('\n=== POST-FIX VERIFICATION ===')
  for (const id of nullFlightIds) {
    const doc = await db.collection('airfreight_flights').doc(id).get()
    const d = doc.data()
    console.log(`  ${id}: status=${d.status}, _fix_note=${d._fix_note}`)
  }

  // Verify no more null flight_datetime in open flights
  const allFlights = await db.collection('airfreight_flights').where('status', '==', 'open').get()
  let remainingNull = 0
  for (const d of allFlights.docs) {
    if (!d.data().flight_datetime) remainingNull++
  }
  console.log(`\nRemaining open flights with null flight_datetime: ${remainingNull}`)
  console.log('Data hotfix complete.')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
