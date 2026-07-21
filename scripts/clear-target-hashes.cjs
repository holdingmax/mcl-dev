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
  const snapRef = db.collection('_sheet_sync_snapshots').doc('YPATo6B9BvRJEIJO7ld9_sync')
  const snapDoc = await snapRef.get()
  if (!snapDoc.exists) { console.log('Snapshot not found'); process.exit(1) }

  const hashes = snapDoc.data().row_hashes || {}
  const update = {}
  let count = 0
  for (const awb of TARGET_AWBS) {
    const key = awb.trim().toUpperCase()
    if (hashes[key]) {
      update['row_hashes.' + key] = admin.firestore.FieldValue.delete()
      console.log('Deleting hash for:', key)
      count++
    } else {
      console.log('Not in snapshot:', key)
    }
  }

  if (count === 0) { console.log('Nothing to delete'); process.exit(0) }

  await snapRef.update(update)
  console.log('Done — deleted ' + count + ' hashes')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
