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
  console.log('=== 1. LAST 5 SYNC RUNS ===')
  const runs = await db.collection('_sheet_sync_runs').orderBy('run_at', 'desc').limit(5).get()
  for (const d of runs.docs) {
    const r = d.data()
    console.log(r.run_at, '|', r.status, '| rows:', r.rows_checked, '| detected:', r.changes_detected, '| applied:', r.changes_applied, '| alerts:', r.alerts_generated, '| errors:', (r.errors || []).length)
    if (r.dry_run_log && r.dry_run_log.length > 0) {
      console.log('  dry_run_log entries:', r.dry_run_log.length)
    }
    if (r.errors && r.errors.length > 0) {
      for (const e of r.errors.slice(0, 3)) console.log('  ERR:', String(e).slice(0, 120))
    }
  }

  console.log('\n=== 2. SNAPSHOT STATE ===')
  const snapDoc = await db.collection('_sheet_sync_snapshots').doc('YPATo6B9BvRJEIJO7ld9_sync').get()
  if (!snapDoc.exists) {
    console.log('NO SNAPSHOT FOUND')
  } else {
    const s = snapDoc.data()
    console.log('row_count:', s.row_count, '| tab:', s.tab_name)
    const hashes = s.row_hashes || {}
    const hashKeys = Object.keys(hashes)
    console.log('Total hashes in snapshot:', hashKeys.length)

    // Check if target AWBs are in the snapshot
    console.log('\nTarget AWBs in snapshot:')
    for (const awb of TARGET_AWBS) {
      const norm = awb.trim().toUpperCase()
      const found = hashes[norm] ? 'YES (hash: ' + hashes[norm] + ')' : 'NO'
      console.log('  ' + awb + ': ' + found)
    }
  }

  console.log('\n=== 3. TARGET AWBs IN SYSTEM (bookings) ===')
  const bookingsSnap = await db.collection('airfreight_bookings')
    .where('client_id', '==', 'YPATo6B9BvRJEIJO7ld9')
    .get()

  for (const awb of TARGET_AWBS) {
    const norm = awb.trim().toUpperCase()
    let found = false
    for (const doc of bookingsSnap.docs) {
      const b = doc.data()
      const awbs = b.awbs || []
      for (const a of awbs) {
        const a1 = (a.awb_number || '').trim().toUpperCase()
        const a2 = (a.awb_number_2nd || '').trim().toUpperCase()
        if (a1 === norm || a2 === norm) {
          console.log('  ' + awb + ': FOUND in booking ' + doc.id + ' | flight: ' + (b.flight_id || 'none') + ' | status: ' + (b.status || '?'))
          found = true
          break
        }
      }
      if (found) break
    }
    if (!found) console.log('  ' + awb + ': NOT IN SYSTEM')
  }

  console.log('\n=== 4. RECENT ALERTS FOR TARGET AWBs ===')
  for (const awb of TARGET_AWBS.slice(0, 3)) {
    const alerts = await db.collection('_sheet_sync_alerts')
      .where('awb_1st', '==', awb)
      .orderBy('created_at', 'desc')
      .limit(2)
      .get()
    if (alerts.empty) {
      console.log('  ' + awb + ': NO ALERTS')
    } else {
      for (const d of alerts.docs) {
        const a = d.data()
        console.log('  ' + awb + ': ' + a.alert_type + ' | ' + a.status + ' | ' + (a.message || '').slice(0, 80))
      }
    }
  }

  console.log('\n=== 5. GLOBAL CONFIG ===')
  const cfg = await db.collection('_sheet_sync_global').doc('config').get()
  console.log(JSON.stringify(cfg.data(), null, 2))

  console.log('\n=== 6. SYNC CONFIG FOR EXPRESS LINE ===')
  const syncCfg = await db.collection('_sheet_sync_configs').doc('YPATo6B9BvRJEIJO7ld9').get()
  if (syncCfg.exists) {
    const c = syncCfg.data()
    console.log('enabled:', c.enabled, '| tab_pattern:', c.tab_name_pattern, '| tab_override:', c.tab_name_override || 'none')
    console.log('spreadsheet_id:', c.spreadsheet_id)
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
