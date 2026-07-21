const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // Find the booking
  const bSnap = await db.collection('airfreight_bookings').doc('ubNO2DEM').get()
  // Try with full ID from verify script output
  const bookings = await db.collection('airfreight_bookings')
    .where('client_id', '==', 'YPATo6B9BvRJEIJO7ld9')
    .get()

  for (const doc of bookings.docs) {
    const b = doc.data()
    const awbs = (b.awb_lines || []).map(a => a.awb_number).join(', ')
    if (awbs.includes('369-98158480')) {
      console.log('Booking ID:', doc.id)
      console.log('flight_id:', b.flight_id)
      console.log('flight_number:', b.flight_number)
      console.log('status:', b.status)
      console.log('booking_type:', b.booking_type)

      // Now check the flight
      if (b.flight_id) {
        const fDoc = await db.collection('airfreight_flights').doc(b.flight_id).get()
        if (fDoc.exists) {
          const f = fDoc.data()
          console.log('\nFlight doc:')
          console.log('  flight_number:', f.flight_number)
          console.log('  flight_datetime:', f.flight_datetime)
          console.log('  status:', f.status)
          console.log('  airline:', f.airline)
          console.log('  destination:', f.destination_id)
        } else {
          console.log('Flight doc NOT FOUND')
        }
      }
      break
    }
  }
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
