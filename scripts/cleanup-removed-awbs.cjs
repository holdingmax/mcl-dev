// Cleanup: delete all soft-deleted AWBs and recalculate flight totals
// Run: node scripts/cleanup-removed-awbs.cjs

const admin = require('firebase-admin')
admin.initializeApp({ projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  const snap = await db.collection('av_flight_awbs').where('status', '==', 'removed').get()
  console.log(`Found ${snap.size} removed AWBs to clean up`)

  const flightIds = new Set()
  for (const d of snap.docs) {
    const data = d.data()
    console.log(`  Deleting: ${data.awb_number} | flight: ${data.flight_id}`)
    flightIds.add(data.flight_id)
    await d.ref.delete()
  }

  for (const fId of flightIds) {
    const activeSnap = await db.collection('av_flight_awbs').where('flight_id', '==', fId).get()
    const active = activeSnap.docs.map(d => d.data())
    const totals = {
      total_awbs: active.length,
      total_pieces: active.reduce((s, a) => s + (a.pieces || 0), 0),
      total_gross_kg: active.reduce((s, a) => s + (a.gross_weight_kg || 0), 0),
      total_chw_kg: active.reduce((s, a) => s + (a.chw_kg || 0), 0),
      has_dg: active.some(a => a.dg),
      has_lb: active.some(a => a.lb),
    }
    await db.collection('av_flights').doc(fId).update(totals)
    console.log(`  Recalced ${fId}: ${totals.total_awbs} awbs, ${totals.total_pieces} pcs, ${totals.total_gross_kg} kg`)
  }

  console.log('Done')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
