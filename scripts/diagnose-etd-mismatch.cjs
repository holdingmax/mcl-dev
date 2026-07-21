const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

const TARGET_AWBS = [
  '369-10115405', '369-98158690', '369-98158701', '369-98158712', '369-98158723'
]

async function main() {
  // 1. Find bookings with these AWBs
  console.log('=== 1. BOOKINGS ===')
  const bookings = await db.collection('airfreight_bookings')
    .where('client_id', '==', 'YPATo6B9BvRJEIJO7ld9')
    .get()

  const flightIds = new Set()
  for (const awb of TARGET_AWBS) {
    for (const b of bookings.docs) {
      const bd = b.data()
      const match = (bd.awb_lines || []).find(l => (l.awb_number || '').includes(awb))
      if (match) {
        console.log(awb, '-> booking', b.id.slice(0, 8), '| flight_id:', bd.flight_id, '| flight_number:', bd.flight_number)
        console.log('  awb_2nd_leg:', match.awb_2nd_leg, '| pcs:', match.pieces, '| cw:', match.chargeable_weight)
        flightIds.add(bd.flight_id)
        break
      }
    }
  }

  // 2. Flight details
  console.log('\n=== 2. FLIGHTS ===')
  for (const fid of flightIds) {
    const f = await db.collection('airfreight_flights').doc(fid).get()
    if (f.exists) {
      const fd = f.data()
      console.log('Flight:', fid)
      console.log('  flight_number:', fd.flight_number)
      console.log('  flight_datetime:', fd.flight_datetime)
      console.log('  flight_instance_key:', fd.flight_instance_key)
      console.log('  cutoff_datetime:', fd.cutoff_datetime)
      console.log('  status:', fd.status, '| dispatched_at:', fd.dispatched_at || 'none')
      console.log('  created_by:', fd.created_by, '| created_at:', fd.created_at)
    }
  }

  // 3. Check if there's ANOTHER flight for UC-1102 on 06/11
  console.log('\n=== 3. ALL UC-1102 FLIGHTS ===')
  const allFlights = await db.collection('airfreight_flights').get()
  for (const f of allFlights.docs) {
    const fd = f.data()
    const fn = (fd.flight_number || '').toUpperCase()
    if (fn.includes('1102') || fn.includes('UC')) {
      console.log('  ', f.id.slice(0, 8), '|', fd.flight_number, '|', fd.flight_datetime, '| key:', fd.flight_instance_key, '| status:', fd.status)
    }
  }

  // 4. Alerts for these AWBs (ETD change detection)
  console.log('\n=== 4. SYNC ALERTS FOR ETD CHANGES ===')
  for (const awb of TARGET_AWBS.slice(0, 2)) {
    const alerts = await db.collection('_sheet_sync_alerts')
      .where('awb_1st', '==', awb)
      .limit(5)
      .get()
    if (alerts.empty) {
      console.log(awb + ': NO ALERTS')
    } else {
      for (const d of alerts.docs) {
        const a = d.data()
        console.log(awb + ':', a.alert_type, '|', a.status, '| flight:', a.flight_number, '| sys_flight:', a.system_flight)
        if (a.diffs && a.diffs.length > 0) {
          for (const diff of a.diffs) {
            console.log('  diff:', diff.field, '| sheet:', diff.sheet, '| system:', diff.system)
          }
        }
        if (a.message) console.log('  msg:', (a.message || '').slice(0, 120))
      }
    }
  }

  // 5. Snapshot hashes for these AWBs
  console.log('\n=== 5. SNAPSHOT STATE ===')
  const snap = await db.collection('_sheet_sync_snapshots').doc('YPATo6B9BvRJEIJO7ld9_sync').get()
  const hashes = snap.data().row_hashes || {}
  for (const awb of TARGET_AWBS) {
    const key = awb.trim().toUpperCase()
    console.log(awb + ':', hashes[key] ? 'in snapshot (hash: ' + hashes[key] + ')' : 'NOT in snapshot')
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
