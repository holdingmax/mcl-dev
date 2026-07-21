/**
 * Trigger a manual sync run to test the V2 dry-run mode.
 * Uses the sheetSyncManual callable function.
 */
const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // Check current global config
  const configDoc = await db.collection('_sheet_sync_global').doc('config').get()
  const gc = configDoc.exists ? configDoc.data() : {}
  console.log(`Global config: dry_run=${gc.dry_run}, updated_at=${gc.updated_at}`)

  // Find enabled sync configs
  const configsSnap = await db.collection('_sheet_sync_configs').where('enabled', '==', true).get()
  console.log(`\nEnabled sync configs: ${configsSnap.size}`)
  for (const doc of configsSnap.docs) {
    const c = doc.data()
    console.log(`  ${doc.id}: client=${c.client_name}, spreadsheet=${(c.spreadsheet_id || '').slice(0, 20)}...`)
  }

  // Check the most recent run to see if V2 is active
  console.log('\n--- Waiting for next scheduled run or checking last run ---')
  const lastRun = await db.collection('_sheet_sync_runs')
    .orderBy('run_at', 'desc')
    .limit(1)
    .get()

  if (!lastRun.empty) {
    const r = lastRun.docs[0].data()
    const hasV2 = r.dry_run !== undefined
    console.log(`Last run: ${r.run_at}`)
    console.log(`  V2 active: ${hasV2}`)
    console.log(`  dry_run: ${r.dry_run ?? 'N/A (old code)'}`)
    console.log(`  circuit_broken: ${r.circuit_broken ?? 'N/A'}`)
    console.log(`  changes_detected: ${r.changes_detected}`)
    console.log(`  changes_applied: ${r.changes_applied}`)
  }

  // Check snapshot to understand current state
  const snapshots = await db.collection('_sheet_sync_snapshots').get()
  console.log(`\nSnapshots: ${snapshots.size}`)
  for (const doc of snapshots.docs) {
    const s = doc.data()
    const hashCount = Object.keys(s.row_hashes || {}).length
    console.log(`  ${doc.id}: ${hashCount} hashes, rows=${s.row_count}, tab=${s.tab_name}`)
    console.log(`    last_checked=${s.last_checked_at ? (s.last_checked_at.toDate ? s.last_checked_at.toDate().toISOString() : s.last_checked_at) : '?'}`)
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
