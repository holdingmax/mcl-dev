/**
 * Check dry-run logs and recent sync runs from Firestore.
 */
const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

function fmtTs(ts) {
  if (!ts) return '—'
  if (ts.toDate) return ts.toDate().toISOString()
  return String(ts)
}

async function main() {
  // 1. Recent sync runs
  console.log('=== RECENT SYNC RUNS ===')
  const runsSnap = await db.collection('_sheet_sync_runs')
    .orderBy('run_at', 'desc')
    .limit(10)
    .get()

  if (runsSnap.empty) {
    console.log('No sync runs found.')
  } else {
    for (const doc of runsSnap.docs) {
      const r = doc.data()
      console.log(`\n  [${r.run_at || fmtTs(r.created_at)}] client=${r.client_id || r.client_name || '?'}`)
      console.log(`    status=${r.status} dry_run=${r.dry_run ?? '?'} circuit_broken=${r.circuit_broken ?? '?'}`)
      console.log(`    rows=${r.rows_checked ?? '?'} changes_detected=${r.changes_detected ?? '?'} applied=${r.changes_applied ?? '?'} alerts=${r.alerts_generated ?? '?'}`)
      console.log(`    cb: flights=${r.cb_flights_created ?? '?'} moves=${r.cb_awbs_moved ?? '?'} gates=${r.cb_gate_blocks ?? '?'}`)
      console.log(`    duration=${r.duration_ms ?? '?'}ms written_back=${r.cells_written_back ?? '?'} holds=${r.holds_synced ?? '?'}`)
      if (r.errors && r.errors.length > 0) {
        console.log(`    ERRORS: ${r.errors.join('; ')}`)
      }
    }
  }

  // 2. Dry-run logs
  console.log('\n\n=== DRY-RUN LOGS ===')
  const drySnap = await db.collection('_sheet_sync_dry_runs')
    .orderBy('run_at', 'desc')
    .limit(5)
    .get()

  if (drySnap.empty) {
    console.log('No dry-run logs found.')
  } else {
    for (const doc of drySnap.docs) {
      const d = doc.data()
      console.log(`\n  [${d.run_at}] client=${d.client_id || d.client_name || '?'}`)
      console.log(`    Summary: ${JSON.stringify(d.summary || {})}`)
      const actions = d.actions || []
      console.log(`    Actions (${actions.length}):`)
      for (const a of actions) {
        console.log(`      ${JSON.stringify(a)}`)
      }
    }
  }

  // 3. Recent circuit breaker alerts
  console.log('\n\n=== CIRCUIT BREAKER ALERTS ===')
  const cbSnap = await db.collection('_sheet_sync_alerts')
    .where('alert_type', '==', 'circuit_breaker')
    .limit(5)
    .get()

  if (cbSnap.empty) {
    console.log('No circuit breaker alerts. (Good)')
  } else {
    for (const doc of cbSnap.docs) {
      const a = doc.data()
      console.log(`  [${fmtTs(a.created_at)}] ${a.message}`)
    }
  }

  // 4. Global config
  console.log('\n\n=== GLOBAL CONFIG ===')
  const configDoc = await db.collection('_sheet_sync_global').doc('config').get()
  if (configDoc.exists) {
    console.log(JSON.stringify(configDoc.data(), null, 2))
  } else {
    console.log('No global config found.')
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
