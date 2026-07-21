const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // Last successful run
  const runs = await db.collection('_sheet_sync_runs')
    .where('status', '==', 'success')
    .orderBy('run_at', 'desc')
    .limit(3)
    .get()
  console.log('Last successful runs:')
  for (const d of runs.docs) {
    const r = d.data()
    console.log(r.run_at, '| rows:', r.rows_checked, '| applied:', r.changes_applied, '| dry_run:', r.dry_run)
  }

  // First error
  const errors = await db.collection('_sheet_sync_runs')
    .where('status', '==', 'error')
    .orderBy('run_at', 'asc')
    .limit(3)
    .get()
  console.log('\nFirst error runs:')
  for (const d of errors.docs) {
    const r = d.data()
    console.log(r.run_at, '|', (r.errors || [])[0] || '-')
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
