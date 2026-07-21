const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

const TARGET_AWBS = [
  '369-98158480', '369-98158502', '369-98158745', '369-98158756',
  '369-98158815', '369-98158826', '369-98063416',
  '369-98159902', '369-98159935', '369-98159946', '369-98159950',
  '369-98063232'
]

async function main() {
  // Last run
  const runs = await db.collection('_sheet_sync_runs').orderBy('run_at', 'desc').limit(1).get()
  const r = runs.docs[0].data()
  console.log('Last run:', r.run_at, '|', r.status, '| rows:', r.rows_checked, '| detected:', r.changes_detected, '| applied:', r.changes_applied)

  // Check bookings
  const bookingsSnap = await db.collection('airfreight_bookings')
    .where('client_id', '==', 'YPATo6B9BvRJEIJO7ld9')
    .get()

  let found = 0
  let notFound = 0
  for (const awb of TARGET_AWBS) {
    const norm = awb.trim().toUpperCase()
    let match = false
    for (const doc of bookingsSnap.docs) {
      const b = doc.data()
      for (const a of (b.awb_lines || [])) {
        const a1 = (a.awb_number || '').trim().toUpperCase()
        if (a1 === norm) {
          console.log('OK ' + awb + ' -> booking ' + doc.id.slice(0, 8) + ' | flight: ' + (b.flight_number || b.flight_id || '?'))
          match = true
          found++
          break
        }
      }
      if (match) break
    }
    if (!match) { console.log('MISSING ' + awb); notFound++ }
  }
  console.log('\nTotal: ' + found + ' found, ' + notFound + ' missing')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
