const admin = require('firebase-admin')

admin.initializeApp({ projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // 1. Delete ALL av_screening_certs (old structure)
  const certsSnap = await db.collection('av_screening_certs').get()
  console.log(`Deleting ${certsSnap.size} old screening certs...`)
  const batch1 = db.batch()
  certsSnap.docs.forEach(d => batch1.delete(d.ref))
  if (certsSnap.size > 0) await batch1.commit()

  // 2. Reset screened flag on all pallet tags
  const ptSnap = await db.collection('av_pallet_tags').where('screened', '==', true).get()
  console.log(`Resetting ${ptSnap.size} pallet tags screened flag...`)
  const batch2 = db.batch()
  ptSnap.docs.forEach(d => batch2.update(d.ref, { screened: false }))
  if (ptSnap.size > 0) await batch2.commit()

  // 3. Reset screening_status on AWBs
  const awbSnap = await db.collection('av_flight_awbs').where('screening_status', 'in', ['complete', 'partial']).get()
  console.log(`Resetting ${awbSnap.size} AWB screening statuses...`)
  const batch3 = db.batch()
  awbSnap.docs.forEach(d => batch3.update(d.ref, { screening_status: 'pending', screened_pcs: 0 }))
  if (awbSnap.size > 0) await batch3.commit()

  // 4. Delete old screening triggers
  const trigSnap = await db.collection('av_screening_triggers').get()
  console.log(`Deleting ${trigSnap.size} old triggers...`)
  const batch4 = db.batch()
  trigSnap.docs.forEach(d => batch4.delete(d.ref))
  if (trigSnap.size > 0) await batch4.commit()

  console.log('Done! Now run the agent again from the UI.')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
