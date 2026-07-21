/**
 * Set up the global sync config document with dry_run = true.
 * This ensures the sync agent runs in dry-run mode after deploy.
 *
 * Usage:
 *   node scripts/setup_dryrun.cjs           # enable dry-run
 *   node scripts/setup_dryrun.cjs --off     # disable dry-run (activate real mode)
 */
const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

const OFF = process.argv.includes('--off')

async function main() {
  const ref = db.collection('_sheet_sync_global').doc('config')
  const doc = await ref.get()
  const current = doc.exists ? doc.data() : {}

  const update = {
    dry_run: !OFF,
    cb_max_flights: current.cb_max_flights || 10,
    cb_max_moves: current.cb_max_moves || 20,
    cb_max_gate_blocks: current.cb_max_gate_blocks || 10,
    updated_at: new Date().toISOString(),
    updated_by: 'setup_dryrun_script',
  }

  await ref.set(update, { merge: true })
  console.log(`Global sync config updated:`)
  console.log(`  dry_run: ${update.dry_run}`)
  console.log(`  cb_max_flights: ${update.cb_max_flights}`)
  console.log(`  cb_max_moves: ${update.cb_max_moves}`)
  console.log(`  cb_max_gate_blocks: ${update.cb_max_gate_blocks}`)

  if (!OFF) {
    console.log('\nSync agent will run in DRY-RUN mode.')
    console.log('To activate real mode: node scripts/setup_dryrun.cjs --off')
  } else {
    console.log('\nSync agent is now in REAL mode.')
    console.log('To re-enable dry-run: node scripts/setup_dryrun.cjs')
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
