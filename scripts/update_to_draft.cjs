const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // Flights with real AWBs → change from cancelled to draft
  const toDraft = [
    '1R3zCZXwW1IiUlf14WXP', // Unknown K-4243 (1 AWB)
    'CouNljT6QL7kT9CmBN2O', // Unknown 5Y538 (3 AWBs)
  ]

  for (const id of toDraft) {
    await db.collection('airfreight_flights').doc(id).update({ status: 'draft' })
    const d = (await db.collection('airfreight_flights').doc(id).get()).data()
    console.log(`${id}: status=${d.status}, airline=${d.airline}, flight_number=${d.flight_number}`)
  }

  // PENDING/PENDING with 0 AWBs stays cancelled
  console.log('\n28W72glznCydNkk51556 (PENDING): stays cancelled (0 AWBs, obsolete)')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
