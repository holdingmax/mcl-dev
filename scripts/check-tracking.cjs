const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  // Check tracking config for last run stats
  const config = await db.collection('_tracking_config').doc('settings').get()
  if (config.exists) {
    const d = config.data()
    console.log('=== TRACKING CONFIG ===')
    console.log('Last run:', d.last_run)
    console.log('Stats:', JSON.stringify(d.last_run_stats))
    console.log('Errors:', JSON.stringify((d.last_run_errors || []).slice(0, 10), null, 2))
    if (d.last_run_debug && d.last_run_debug.length > 0) {
      console.log('\n=== DEBUG SAMPLES ===')
      for (const s of d.last_run_debug) {
        console.log(`\n  AWB: ${s.awb} (prefix ${s.prefix})`)
        console.log(`  URL: ${s.url}`)
        console.log(`  Tables found: ${s.tables}`)
        console.log(`  Result: status=${s.resultStatus} legs=${s.resultLegs} flight=${s.resultFlight}`)
        if (s.error) console.log(`  Error: ${s.error}`)
        console.log(`  Page snippet: "${s.snippet}"`)
      }
    }
  } else {
    console.log('No tracking config doc found')
  }

  // Check if any bookings have tracking data
  const bookings = await db.collection('airfreight_bookings').where('status', '!=', 'cancelled').get()
  let tracked = 0
  let withStatus = 0
  const samples = []
  for (const doc of bookings.docs) {
    const b = doc.data()
    if (!b.awb_lines) continue
    for (const line of b.awb_lines) {
      if (line.tracking_last_checked) {
        tracked++
        if (samples.length < 5) {
          samples.push({
            awb: line.awb_number,
            status: line.tracking_status,
            flight: line.tracking_inbound_flight,
            eta: line.tracking_eta,
            origin: line.tracking_origin,
            checked: line.tracking_last_checked,
            legs: (line.tracking_legs || []).length,
          })
        }
      }
      if (line.tracking_status) withStatus++
    }
  }
  console.log('\n=== TRACKING RESULTS ===')
  console.log('AWBs checked (tracking_last_checked):', tracked)
  console.log('AWBs with status:', withStatus)
  if (samples.length > 0) {
    console.log('\nSample results:')
    for (const s of samples) {
      console.log(`  ${s.awb}: status=${s.status} flight=${s.flight} eta=${s.eta} origin=${s.origin} legs=${s.legs}`)
    }
  }
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
