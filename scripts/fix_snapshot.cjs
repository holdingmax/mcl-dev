/**
 * Remove snapshot hashes for the 4 removed AWBs so the sync re-processes them.
 * Usage:
 *   node scripts/fix_snapshot.cjs           # dry-run
 *   node scripts/fix_snapshot.cjs --apply   # apply
 */
const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

const APPLY = process.argv.includes('--apply')

// 1st leg AWB numbers for the 4 removed AWBs
const REMOVED_1ST_LEGS = ['369-99802522', '369-99802533', '369-10115136', '369-98158476']

async function main() {
  console.log('Mode:', APPLY ? 'APPLY' : 'DRY-RUN')
  const snapRef = db.collection('_sheet_sync_snapshots').doc('YPATo6B9BvRJEIJO7ld9_sync')
  const snapDoc = await snapRef.get()
  if (!snapDoc.exists) { console.log('Snapshot not found'); process.exit(1) }

  const data = snapDoc.data()
  const hashes = { ...data.row_hashes }
  console.log('Total hashes before:', Object.keys(hashes).length)

  let removed = 0
  for (const key of REMOVED_1ST_LEGS) {
    if (hashes[key]) {
      console.log('  Found and removing:', key)
      delete hashes[key]
      removed++
    } else {
      console.log('  NOT found:', key)
    }
  }

  console.log('Hashes to remove:', removed)
  console.log('Total hashes after:', Object.keys(hashes).length)

  if (removed === 0) {
    console.log('\nNothing to fix.')
    process.exit(0)
  }

  if (APPLY) {
    await snapRef.update({
      row_hashes: hashes,
      row_count: Object.keys(hashes).length,
    })
    console.log('\nSnapshot updated. Next sync cycle will re-process these rows.')
  } else {
    console.log('\nDry-run. To apply: node scripts/fix_snapshot.cjs --apply')
  }

  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
