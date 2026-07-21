const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // Find all buildup_ulds with uld_number containing "43256QT"
  console.log('=== 1. ALL buildup_ulds with uld_number "43256QT" ===')
  const q1 = await db.collection('buildup_ulds').where('uld_number', '==', '43256QT').get()
  for (const d of q1.docs) {
    const u = d.data()
    console.log('  ID:', d.id, '| type:', u.type, '| uld_number:', u.uld_number, '| flight_id:', u.flight_id, '| status:', u.status, '| conf:', u.conf, '| dest:', u.destination)
  }

  // Also try full number
  console.log('\n=== 2. ALL buildup_ulds with uld_number "PMC43256QT" ===')
  const q2 = await db.collection('buildup_ulds').where('uld_number', '==', 'PMC43256QT').get()
  for (const d of q2.docs) {
    const u = d.data()
    console.log('  ID:', d.id, '| type:', u.type, '| uld_number:', u.uld_number, '| flight_id:', u.flight_id, '| status:', u.status, '| conf:', u.conf)
  }

  // For each found ULD, check pieces and flight info
  const allUlds = [...q1.docs, ...q2.docs]
  const seenIds = new Set()

  for (const d of allUlds) {
    if (seenIds.has(d.id)) continue
    seenIds.add(d.id)
    const u = d.data()

    // Pieces
    const pSnap = await db.collection('airfreight_physical_pieces').where('uld_id', '==', d.id).get()
    const awbs = new Set()
    for (const p of pSnap.docs) {
      awbs.add(p.data().awb_number)
    }

    // Flight
    let flightNum = '?'
    if (u.flight_id) {
      const fDoc = await db.collection('airfreight_flights').doc(u.flight_id).get()
      if (fDoc.exists) {
        const f = fDoc.data()
        flightNum = f.flight_number + ' (' + (f.flight_datetime || '').slice(0, 10) + ')'
      }
    }

    console.log('\n--- ULD:', d.id, '---')
    console.log('  type:', u.type, '| number:', u.uld_number, '| status:', u.status)
    console.log('  flight:', flightNum)
    console.log('  pieces:', pSnap.size, '| AWBs:', [...awbs].join(', '))

    // Check if DO already exists for this ULD
    const doSnap = await db.collection('delivery_orders').where('ulds_loaded', 'array-contains', u.type + u.uld_number).get()
    if (!doSnap.empty) {
      for (const dd of doSnap.docs) {
        console.log('  HAS DO:', dd.id, '| do_number:', dd.data().do_number, '| status:', dd.data().status)
      }
    } else {
      console.log('  NO DO yet')
    }
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
