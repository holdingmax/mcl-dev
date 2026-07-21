const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // 1. Search ALL bookings for 369-10115136 or 045-22210322
  console.log('=== 1. DEEP SEARCH: 369-10115136 / 045-22210322 ===')
  const allBookings = await db.collection('airfreight_bookings').get()
  let found = false
  for (const b of allBookings.docs) {
    const bd = b.data()
    const lines = bd.awb_lines || []
    const json = JSON.stringify(lines)
    if (json.includes('10115136') || json.includes('22210322')) {
      console.log('FOUND in booking:', b.id)
      console.log('  booking_type:', bd.booking_type)
      console.log('  flight_id:', bd.flight_id)
      console.log('  flight_number:', bd.flight_number)
      console.log('  client_name:', bd.client_name)
      console.log('  created_by:', bd.created_by)
      console.log('  documents:', bd.documents ? Object.keys(bd.documents) : 'none')
      for (let j = 0; j < lines.length; j++) {
        console.log('    [' + j + ']', JSON.stringify(lines[j]).slice(0, 200))
      }
      found = true
    }
  }
  if (!found) console.log('NOT FOUND in any booking')

  // 2. All bookings on the specific flight x9hcfjqtcfFCS4G1manT
  console.log('\n=== 2. ALL BOOKINGS ON FLIGHT x9hcfjqtcfFCS4G1manT ===')
  const fb1 = await db.collection('airfreight_bookings').where('flight_id', '==', 'x9hcfjqtcfFCS4G1manT').get()
  for (const b of fb1.docs) {
    const bd = b.data()
    console.log('Booking:', b.id, '| type:', bd.booking_type, '| client:', bd.client_name, '| awbs:', (bd.awb_lines || []).length)
    for (const l of (bd.awb_lines || [])) {
      console.log('  ', l.awb_number, '/', l.awb_2nd_leg)
    }
  }

  // 3. Also check kuKhnv19 (06/08 23:40)
  console.log('\n=== 3. ALL BOOKINGS ON FLIGHT kuKhnv19oIvQr8KkXbCD (06/08) ===')
  const fb2 = await db.collection('airfreight_bookings').where('flight_id', '==', 'kuKhnv19oIvQr8KkXbCD').get()
  for (const b of fb2.docs) {
    const bd = b.data()
    console.log('Booking:', b.id, '| type:', bd.booking_type, '| client:', bd.client_name, '| awbs:', (bd.awb_lines || []).length)
    for (const l of (bd.awb_lines || [])) {
      console.log('  ', l.awb_number, '/', l.awb_2nd_leg)
    }
  }

  // 4. Check awb_numbers_normalized index
  console.log('\n=== 4. SEARCH BY NORMALIZED AWB ===')
  const normSearch = await db.collection('airfreight_bookings')
    .where('awb_numbers_normalized', 'array-contains', '36910115136')
    .get()
  console.log('Results for 36910115136:', normSearch.size)
  for (const b of normSearch.docs) {
    const bd = b.data()
    console.log('  Booking:', b.id, '| type:', bd.booking_type, '| flight:', bd.flight_number)
  }

  const normSearch2 = await db.collection('airfreight_bookings')
    .where('awb_numbers_normalized', 'array-contains', '04522210322')
    .get()
  console.log('Results for 04522210322:', normSearch2.size)
  for (const b of normSearch2.docs) {
    const bd = b.data()
    console.log('  Booking:', b.id, '| type:', bd.booking_type, '| flight:', bd.flight_number)
  }

  // 5. Doc receptions
  console.log('\n=== 5. DOC RECEPTIONS ===')
  const dr1 = await db.collection('airfreight_doc_receptions').where('awb_number', '==', '369-10115136').get()
  console.log('DRs for 369-10115136:', dr1.size)
  for (const d of dr1.docs) {
    const dr = d.data()
    console.log('  DR:', d.id, '| booking_id:', dr.booking_id, '| flight_id:', dr.flight_id, '| status:', dr.status, '| awb_2nd:', dr.awb_2nd_leg || dr.awb_2nd || 'none')
  }
  const dr2 = await db.collection('airfreight_doc_receptions').where('awb_number', '==', '045-22210322').get()
  console.log('DRs for 045-22210322:', dr2.size)
  for (const d of dr2.docs) {
    const dr = d.data()
    console.log('  DR:', d.id, '| booking_id:', dr.booking_id, '| flight_id:', dr.flight_id, '| status:', dr.status)
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
