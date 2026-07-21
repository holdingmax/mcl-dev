/**
 * Diagnostic: Check activity for each AWB on the contaminated LA-0543_2026-06-08 flight.
 */
const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  const bookingId = '1fNfhx0xgCdlSFBZrDbQ'

  const booking = await db.collection('airfreight_bookings').doc(bookingId).get()
  const lines = booking.data().awb_lines || []

  console.log('=== ACTIVITY CHECK FOR EACH AWB ON LA-0543_2026-06-08 ===\n')

  for (const line of lines) {
    const awb1 = line.awb_number || ''
    const awb2 = line.awb_2nd_leg || ''

    console.log('AWB:', awb1, '/', awb2)

    // Doc receptions
    const dr1 = await db.collection('airfreight_doc_receptions').where('awb_number', '==', awb2).get()
    const dr2 = await db.collection('airfreight_doc_receptions').where('awb_number', '==', awb1).get()
    console.log('  Doc Receptions:', dr1.size + dr2.size)

    // Physical pieces
    const pp1 = await db.collection('airfreight_physical_pieces').where('awb_number', '==', awb2).get()
    const pp2 = await db.collection('airfreight_physical_pieces').where('awb_number', '==', awb1).get()
    console.log('  Physical Pieces:', pp1.size + pp2.size)

    // ULD assignments
    const uld1 = await db.collection('airfreight_uld_pieces').where('awb_number', '==', awb2).get()
    const uld2 = await db.collection('airfreight_uld_pieces').where('awb_number', '==', awb1).get()
    console.log('  ULD Pieces:', uld1.size + uld2.size)

    // Holds
    const h1 = await db.collection('airfreight_holds').where('awb_number', '==', awb1).get()
    const h2 = await db.collection('airfreight_holds').where('awb_number', '==', awb2).get()
    console.log('  Holds:', h1.size + h2.size)

    // Screening
    const sc = await db.collection('airfreight_screening').where('awb_number', '==', awb1).get()
    console.log('  Screening:', sc.size)

    // Line-level flags
    const onHand = line.on_hand ? 'YES' : 'NO'
    const dispatched = line.dispatched ? 'YES' : 'NO'
    const docsInDrive = line.docs_in_drive ? 'YES' : 'NO'
    console.log('  on_hand:', onHand, '| dispatched:', dispatched, '| docs_in_drive:', docsInDrive)
    console.log('  hold:', line.hold || 'none', '| holds count:', (line.holds || []).length)

    const totalActivity = dr1.size + dr2.size + pp1.size + pp2.size + uld1.size + uld2.size + h1.size + h2.size + sc.size
    console.log('  >>> HAS ACTIVITY:', totalActivity > 0, '(' + totalActivity + ' records)')
    console.log()
  }

  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
