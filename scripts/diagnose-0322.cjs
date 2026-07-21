const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  const AWB_1ST = ['369-98158476', '369-10115136']
  const AWB_2ND = ['045-20348436', '045-22210322']

  // 1. Find bookings containing these AWBs
  console.log('=== 1. BOOKINGS ===')
  const allBookings = await db.collection('airfreight_bookings').get()
  for (const b of allBookings.docs) {
    const bd = b.data()
    const lines = bd.awb_lines || []
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      const a1 = (l.awb_number || '').trim()
      const a2 = (l.awb_2nd_leg || '').trim()
      if (AWB_1ST.includes(a1) || AWB_2ND.includes(a2) || AWB_1ST.includes(a2)) {
        console.log('\nBooking:', b.id)
        console.log('  booking_type:', bd.booking_type)
        console.log('  flight_id:', bd.flight_id)
        console.log('  flight_number:', bd.flight_number)
        console.log('  client_id:', bd.client_id, '| client_name:', bd.client_name)
        console.log('  status:', bd.status)
        console.log('  created_by:', bd.created_by)
        console.log('  awb_lines count:', lines.length)
        for (let j = 0; j < lines.length; j++) {
          const ll = lines[j]
          console.log('    [' + j + '] awb_number:', ll.awb_number, '| awb_2nd_leg:', ll.awb_2nd_leg, '| pcs:', ll.pieces, '| cw:', ll.chargeable_weight)
        }
        // Check documents structure
        if (bd.documents) {
          console.log('  documents keys:', Object.keys(bd.documents).join(', '))
        }
      }
    }
  }

  // 2. Find the flight LA-0543
  console.log('\n=== 2. FLIGHT LA-0543 ===')
  const flights = await db.collection('airfreight_flights').get()
  for (const f of flights.docs) {
    const fd = f.data()
    if ((fd.flight_number || '').includes('0543') || (fd.flight_number || '').includes('LA-0543')) {
      console.log('Flight:', f.id, '| number:', fd.flight_number, '| datetime:', fd.flight_datetime, '| status:', fd.status)
    }
  }

  // 3. Doc receptions for these AWBs
  console.log('\n=== 3. DOC RECEPTIONS ===')
  for (const awb of AWB_1ST) {
    const drs = await db.collection('airfreight_doc_receptions').where('awb_number', '==', awb).get()
    for (const d of drs.docs) {
      const dr = d.data()
      console.log(awb, ': DR', d.id.slice(0, 8), '| booking_id:', (dr.booking_id || '').slice(0, 12), '| flight_id:', (dr.flight_id || '').slice(0, 12), '| status:', dr.status)
    }
  }

  // 4. Check sync alerts for creation
  console.log('\n=== 4. SYNC ALERTS (creation) ===')
  for (const awb of AWB_1ST) {
    const alerts = await db.collection('_sheet_sync_alerts')
      .where('awb_1st', '==', awb)
      .limit(5)
      .get()
    for (const d of alerts.docs) {
      const a = d.data()
      console.log(awb, ':', a.alert_type, '|', a.status, '| msg:', (a.message || '').slice(0, 100))
    }
  }

  // 5. All bookings on flight LA-0543 to see the mix
  console.log('\n=== 5. ALL BOOKINGS ON LA-0543 FLIGHT ===')
  // Find flight ID first
  let la0543Id = null
  for (const f of flights.docs) {
    if ((f.data().flight_number || '').includes('0543')) {
      la0543Id = f.id
      break
    }
  }
  if (la0543Id) {
    const flightBookings = await db.collection('airfreight_bookings').where('flight_id', '==', la0543Id).get()
    for (const b of flightBookings.docs) {
      const bd = b.data()
      console.log('Booking:', b.id.slice(0, 12), '| type:', bd.booking_type, '| client:', bd.client_name, '| awbs:', (bd.awb_lines || []).length)
      for (const l of (bd.awb_lines || [])) {
        console.log('  ', l.awb_number, '/', l.awb_2nd_leg, '| pcs:', l.pieces)
      }
    }
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
