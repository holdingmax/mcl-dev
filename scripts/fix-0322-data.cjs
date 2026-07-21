const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // 1. Convert simple booking 033pmh to ecommerce with awb_lines
  console.log('=== 1. CONVERT SIMPLE → ECOMMERCE ===')
  const simpleRef = db.collection('airfreight_bookings').doc('033pmhVSnUUT5sxe3OiC')
  const simpleDoc = await simpleRef.get()
  const sd = simpleDoc.data()

  const awbLine = {
    awb_number: sd.awb_1st_leg || '369-10115136',
    awb_2nd_leg: sd.awb_2nd_leg || '045-22210322',
    pieces: sd.pieces || 97,
    weight: sd.weight || 2403,
    chargeable_weight: sd.chargeable_weight || 3060,
    uld_type: sd.uld_type || 'LOOSE',
    battery: sd.battery || false,
    ddgg: sd.ddgg || false,
    hold: sd.hold || false,
    on_hand: sd.on_hand || false,
    pickup_from: sd.pickup_from || null,
    ready_for_pickup: sd.ready_for_pickup || null,
    last_day_free: sd.last_day_free || null,
    docs_in_drive: false,
    warehouse_status: sd.warehouse_status || '',
  }

  // Move documents from simple slots to ecommerce slots
  const docs = sd.documents || {}
  const newDocs = {}
  // doc_mawb_def → doc_export_awb (the "AWB Final" is actually the Export AWB)
  if (docs.doc_mawb_def) newDocs.doc_export_awb = docs.doc_mawb_def
  // doc_7512 stays the same
  if (docs.doc_7512) newDocs.doc_7512 = docs.doc_7512
  // doc_do_tsa stays the same
  if (docs.doc_do_tsa) newDocs.doc_do_tsa = docs.doc_do_tsa
  // doc_import_awb stays the same
  if (docs.doc_import_awb) newDocs.doc_import_awb = docs.doc_import_awb
  // doc_hawb → not used in ecommerce, skip (was a duplicate upload anyway)

  await simpleRef.update({
    booking_type: 'ecommerce',
    awb_lines: [awbLine],
    documents: newDocs,
  })
  console.log('Converted 033pmh to ecommerce with awb_lines and remapped documents')

  // 2. Delete corrupted ghost booking fFNKTeBt (0 awb_lines, created by sync agent)
  console.log('\n=== 2. DELETE GHOST BOOKING ===')
  const ghostRef = db.collection('airfreight_bookings').doc('fFNKTeBtiq6GogIPFNa6')
  const ghostDoc = await ghostRef.get()
  if (ghostDoc.exists) {
    const gd = ghostDoc.data()
    console.log('Ghost booking: type:', gd.booking_type, '| awb_lines:', (gd.awb_lines || []).length, '| flight:', gd.flight_number)
    // Verify it has no DOs, billing, or doc receptions pointing to it
    const dos = await db.collection('delivery_orders').where('awb_keys', 'array-contains', 'fFNKTeBtiq6GogIPFNa6::0').get()
    console.log('DOs referencing this booking:', dos.size)
    const drs = await db.collection('airfreight_doc_receptions').where('booking_id', '==', 'fFNKTeBtiq6GogIPFNa6').get()
    console.log('Doc receptions pointing to this booking:', drs.size)
    const charges = await db.collection('air_billing_charges').where('booking_id', '==', 'fFNKTeBtiq6GogIPFNa6').get()
    console.log('Billing charges:', charges.size)

    if (dos.size === 0 && drs.size === 0 && charges.size === 0) {
      await ghostRef.delete()
      console.log('Deleted ghost booking fFNKTeBt')
    } else {
      console.log('CANNOT DELETE — has references')
    }
  }

  // 3. Verify final state
  console.log('\n=== 3. VERIFY ===')
  const verifyDoc = await simpleRef.get()
  const vd = verifyDoc.data()
  console.log('Booking 033pmh: type:', vd.booking_type, '| awb_lines:', (vd.awb_lines || []).length)
  console.log('  awb_lines[0]:', JSON.stringify(vd.awb_lines[0]).slice(0, 150))
  console.log('  documents:', Object.keys(vd.documents || {}).join(', '))

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
