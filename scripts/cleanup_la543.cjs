/**
 * ONE-SHOT cleanup: Remove AWBs WITHOUT activity from the contaminated
 * LA-0543_2026-06-08 flight booking.
 *
 * After removal, the sync agent (with the computeDiffs fix) will re-add
 * them to the correct flight instance on the next cycle.
 *
 * AWBs WITH activity (doc reception, physical pieces) are left intact.
 *
 * Usage:
 *   node scripts/cleanup_la543.cjs            # dry-run (default)
 *   node scripts/cleanup_la543.cjs --apply    # actually write
 */
const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

const APPLY = process.argv.includes('--apply')
const BOOKING_ID = '1fNfhx0xgCdlSFBZrDbQ'
const FLIGHT_ID = 'kuKhnv19oIvQr8KkXbCD'

async function hasActivity(awb1, awb2) {
  const checks = await Promise.all([
    db.collection('airfreight_doc_receptions').where('awb_number', '==', awb2).limit(1).get(),
    db.collection('airfreight_doc_receptions').where('awb_number', '==', awb1).limit(1).get(),
    db.collection('airfreight_physical_pieces').where('awb_number', '==', awb2).limit(1).get(),
    db.collection('airfreight_physical_pieces').where('awb_number', '==', awb1).limit(1).get(),
    db.collection('airfreight_uld_pieces').where('awb_number', '==', awb2).limit(1).get(),
    db.collection('airfreight_uld_pieces').where('awb_number', '==', awb1).limit(1).get(),
    db.collection('airfreight_holds').where('awb_number', '==', awb1).limit(1).get(),
    db.collection('airfreight_holds').where('awb_number', '==', awb2).limit(1).get(),
    db.collection('airfreight_screening').where('awb_number', '==', awb1).limit(1).get(),
  ])
  return checks.some(snap => snap.size > 0)
}

function computeAwbNumbersNormalized(bookingData) {
  const norms = new Set()
  for (const line of (bookingData.awb_lines || [])) {
    const n1 = (line.awb_number || '').replace(/[-\s]/g, '').toUpperCase()
    const n2 = (line.awb_2nd_leg || '').replace(/[-\s]/g, '').toUpperCase()
    if (n1) norms.add(n1)
    if (n2) norms.add(n2)
  }
  return [...norms]
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  console.log(`Booking: ${BOOKING_ID}`)
  console.log(`Flight: ${FLIGHT_ID} (LA-0543_2026-06-08)\n`)

  const bookingSnap = await db.collection('airfreight_bookings').doc(BOOKING_ID).get()
  if (!bookingSnap.exists) { console.error('Booking not found'); process.exit(1) }

  const bookingData = bookingSnap.data()
  const lines = [...(bookingData.awb_lines || [])]
  console.log(`Current AWB lines: ${lines.length}\n`)

  const toRemove = []
  const toKeep = []

  for (const line of lines) {
    const awb1 = line.awb_number || ''
    const awb2 = line.awb_2nd_leg || ''
    const active = await hasActivity(awb1, awb2)

    if (active) {
      toKeep.push(line)
      console.log(`  KEEP: ${awb1} / ${awb2} — has activity`)
    } else {
      toRemove.push(line)
      console.log(`  REMOVE: ${awb1} / ${awb2} — no activity`)
    }
  }

  console.log(`\n=== SUMMARY ===`)
  console.log(`Keep: ${toKeep.length} AWBs (have activity)`)
  console.log(`Remove: ${toRemove.length} AWBs (no activity)`)

  if (toRemove.length === 0) {
    console.log('\nNothing to clean up.')
    process.exit(0)
  }

  if (toKeep.length === 0) {
    console.log('\nWARNING: Would remove ALL AWBs — this would empty the booking.')
    console.log('Aborting for safety.')
    process.exit(1)
  }

  if (!APPLY) {
    console.log('\nThis was a DRY-RUN. To apply:')
    console.log('  node scripts/cleanup_la543.cjs --apply')
    process.exit(0)
  }

  // Apply: update the booking with only the kept lines
  const updatedBooking = {
    awb_lines: toKeep,
    pieces: toKeep.reduce((s, l) => s + (l.pieces || 0), 0),
    awb_numbers_normalized: computeAwbNumbersNormalized({ awb_lines: toKeep }),
    updated_at: new Date().toISOString(),
    updated_by: 'cleanup_la543_script',
  }

  await db.collection('airfreight_bookings').doc(BOOKING_ID).update(updatedBooking)

  console.log('\nBooking updated:')
  console.log(`  AWB lines: ${lines.length} → ${toKeep.length}`)
  console.log(`  Pieces: ${updatedBooking.pieces}`)
  console.log('\nRemoved AWBs will be re-synced to correct flight instances on next sync cycle.')

  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
