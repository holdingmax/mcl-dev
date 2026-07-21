const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // Snapshot info
  const doc = await db.collection('_sheet_sync_snapshots').doc('YPATo6B9BvRJEIJO7ld9_sync').get()
  const s = doc.data()
  console.log('Snapshot tab_name:', s.tab_name)
  console.log('Snapshot row_count:', s.row_count)
  console.log('Last checked:', s.last_checked_at ? s.last_checked_at.toDate().toISOString() : '?')

  // Sync config
  const cfgSnap = await db.collection('_sheet_sync_configs').where('enabled', '==', true).get()
  for (const d of cfgSnap.docs) {
    const c = d.data()
    console.log('Config:', d.id, '| client:', c.client_name, '| tab_pattern:', c.tab_name_pattern || 'default', '| tab_override:', c.tab_name_override || 'none')
  }

  // Last 3 runs
  const runs = await db.collection('_sheet_sync_runs').orderBy('run_at', 'desc').limit(3).get()
  for (const d of runs.docs) {
    const r = d.data()
    console.log('Run:', r.run_at, '| status:', r.status, '| rows:', r.rows_checked, '| applied:', r.changes_applied, '| errors:', (r.errors || []).length)
    if (r.errors && r.errors.length > 0) console.log('  errors:', r.errors)
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
