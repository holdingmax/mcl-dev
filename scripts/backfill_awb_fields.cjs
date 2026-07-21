// One-time backfill: re-trigger AI processing for all AWBs in flight M4003
// This sets ai_status back to 'pending' which triggers avProcessAwbDocs
// with the updated prompt that now extracts shipper_name, consignee_name, agent_name, shipper_phone, nature_of_goods

const admin = require('firebase-admin')

admin.initializeApp({ projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // Find flight M4003
  const flightsSnap = await db.collection('av_flights')
    .where('flight_number', '==', 'M4003')
    .get()

  if (flightsSnap.empty) {
    console.log('No flight M4003 found')
    process.exit(1)
  }

  for (const flightDoc of flightsSnap.docs) {
    const flightId = flightDoc.id
    console.log(`Flight: ${flightId} — ${flightDoc.data().flight_number} (${flightDoc.data().flight_date})`)

    const awbsSnap = await db.collection('av_flight_awbs')
      .where('flight_id', '==', flightId)
      .get()

    console.log(`Found ${awbsSnap.size} AWBs`)

    for (const awbDoc of awbsSnap.docs) {
      const awb = awbDoc.data()
      if (!awb.doc_awb_url) {
        console.log(`  SKIP ${awb.awb_number} — no doc_awb_url`)
        continue
      }
      console.log(`  Resetting ${awb.awb_number} to pending...`)
      await db.doc(`av_flight_awbs/${awbDoc.id}`).update({
        ai_status: 'pending',
        updated_at: new Date().toISOString(),
      })
      // Small delay to avoid overwhelming the function
      await new Promise(r => setTimeout(r, 2000))
    }
  }

  console.log('Done. AWBs will be re-processed by avProcessAwbDocs trigger.')
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
