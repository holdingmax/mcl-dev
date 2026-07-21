/**
 * Check snapshot structure and find keys for the removed AWBs.
 */
const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  const snapDoc = await db.collection('_sheet_sync_snapshots').doc('YPATo6B9BvRJEIJO7ld9_sync').get()
  if (!snapDoc.exists) { console.log('Snapshot not found'); process.exit(1) }
  const data = snapDoc.data()
  console.log('tab:', data.tab_name)
  console.log('row_count:', data.row_count)
  const hashes = data.row_hashes || {}
  const keys = Object.keys(hashes)
  console.log('hash entries:', keys.length)

  console.log('\nSample keys (first 5):')
  for (const k of keys.slice(0, 5)) {
    console.log('  key:', k)
  }

  // Find keys containing the 4 removed AWBs
  const removed = ['22210311', '20348344', '22210322', '20348436']
  console.log('\nKeys for the 4 REMOVED AWBs:')
  let found = 0
  for (const k of keys) {
    for (const awb of removed) {
      if (k.includes(awb)) {
        console.log('  key:', k)
        found++
      }
    }
  }
  if (found === 0) console.log('  (none found)')

  // Also check all 8
  const all8 = ['20348005', '20348193', '22210300', '20348263', '22210311', '20348344', '22210322', '20348436']
  console.log('\nKeys for ALL 8 AWBs:')
  found = 0
  for (const k of keys) {
    for (const awb of all8) {
      if (k.includes(awb)) {
        console.log('  key:', k)
        found++
      }
    }
  }
  if (found === 0) console.log('  (none found — snapshot uses different key format)')

  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
