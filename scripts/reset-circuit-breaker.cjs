const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  const ref = db.collection('_sheet_sync_global').doc('config')
  await ref.update({ cb_max_moves: 20, cb_max_flights: 10 })
  console.log('Reset to cb_max_moves=20, cb_max_flights=10')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
