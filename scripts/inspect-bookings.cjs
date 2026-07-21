const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  const ids = ['033pmhVSnUUT5sxe3OiC', 'fFNKTeBtiq6GogIPFNa6']

  for (const id of ids) {
    console.log('\n=== BOOKING:', id, '===')
    const doc = await db.collection('airfreight_bookings').doc(id).get()
    if (!doc.exists) { console.log('NOT FOUND'); continue }
    const bd = doc.data()
    console.log('booking_type:', bd.booking_type)
    console.log('flight_id:', bd.flight_id)
    console.log('flight_number:', bd.flight_number)
    console.log('client_name:', bd.client_name)
    console.log('status:', bd.status)
    console.log('created_by:', bd.created_by)
    console.log('created_at:', bd.created_at)
    console.log('awb_numbers_normalized:', JSON.stringify(bd.awb_numbers_normalized))
    console.log('awb_lines count:', (bd.awb_lines || []).length)
    for (let j = 0; j < (bd.awb_lines || []).length; j++) {
      const l = bd.awb_lines[j]
      console.log('  [' + j + '] awb:', l.awb_number, '| 2nd:', l.awb_2nd_leg, '| pcs:', l.pieces, '| cw:', l.chargeable_weight)
    }
    // Simple booking specific fields
    if (bd.booking_type === 'simple') {
      console.log('awb_number:', bd.awb_number)
      console.log('awb_2nd_leg:', bd.awb_2nd_leg)
      console.log('pieces:', bd.pieces)
      console.log('weight:', bd.weight)
      console.log('destination_id:', bd.destination_id)
    }
    // Documents
    if (bd.documents && Object.keys(bd.documents).length > 0) {
      console.log('documents:', JSON.stringify(Object.keys(bd.documents)))
    } else {
      console.log('documents: none')
    }
  }

  // Also check: what does the booking list page display?
  // The first screenshot shows 2 AWBs on LA-0543, so the display logic must combine simple + ecommerce
  console.log('\n=== SIMPLE BOOKING FIELDS ===')
  const simpleDoc = await db.collection('airfreight_bookings').doc('033pmhVSnUUT5sxe3OiC').get()
  const sd = simpleDoc.data()
  // Print ALL fields
  for (const [k, v] of Object.entries(sd)) {
    if (k === 'awb_lines' || k === 'change_log') continue
    const val = typeof v === 'object' && v !== null ? JSON.stringify(v) : v
    console.log('  ' + k + ':', val)
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
