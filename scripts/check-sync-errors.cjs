const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // Get last 20 runs to see when errors started
  const runs = await db.collection('_sheet_sync_runs').orderBy('run_at', 'desc').limit(20).get()
  for (const d of runs.docs) {
    const r = d.data()
    const errs = (r.errors || []).length
    console.log(r.run_at, '|', r.status, '| rows:', r.rows_checked || '-', '| applied:', r.changes_applied || 0, '| errors:', errs, errs > 0 ? '| ' + r.errors[0].slice(0, 80) : '')
  }
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
