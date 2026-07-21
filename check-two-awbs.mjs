import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const config = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = config.tokens.refresh_token
const res = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type:'refresh_token',refresh_token:rt,client_id:'563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',client_secret:'j9iVZfS8kkCEFUPaAeJV0sAi'})})
const token = (await res.json()).access_token
const BASE = 'https://firestore.googleapis.com/v1/projects/wms-mcl/databases/(default)/documents'

async function runQuery(collectionId, extraQuery = {}) {
  const qr = await fetch(BASE + ':runQuery', {
    method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body: JSON.stringify({structuredQuery:{from:[{collectionId}],limit:500, ...extraQuery}})
  })
  return (await qr.json()).filter(d => d.document)
}

// 1. Search both AWBs in bookings
console.log('=== BOOKINGS WITH AWB 369-99783283 ===')
const bookings = await runQuery('airfreight_bookings')
const awb1 = '36999783283'
const awb2 = '36999783305'

function normalizeAwb(a) { return (a||'').replace(/[-\s]/g, '') }

for (const d of bookings) {
  const f = d.document.fields
  const bookingId = d.document.name.split('/').pop()
  const lines = f.awb_lines?.arrayValue?.values || []
  for (const line of lines) {
    const lf = line.mapValue?.fields || {}
    const awbNum = normalizeAwb(lf.awb_number?.stringValue || '')
    if (awbNum === awb1 || awbNum === awb2) {
      console.log(`\n--- Booking ${bookingId} | AWB: ${lf.awb_number?.stringValue} ---`)
      console.log(`  flight_id: ${f.flight_id?.stringValue || 'none'}`)
      console.log(`  flight_number: ${f.flight_number?.stringValue || 'none'}`)
      console.log(`  booking_type: ${f.booking_type?.stringValue || '?'}`)
      console.log(`  client_name: ${f.client_name?.stringValue || '?'}`)
      console.log(`  hold flag: ${lf.hold?.booleanValue}`)
      const holds = lf.holds?.arrayValue?.values || []
      console.log(`  holds array length: ${holds.length}`)
      for (let i = 0; i < holds.length; i++) {
        const hf = holds[i].mapValue?.fields || {}
        console.log(`    hold[${i}]: bag="${hf.bag?.stringValue||''}" box="${hf.box?.stringValue||''}"`)
      }
    }
  }
}

// 2. Search both AWBs in airfreight_holds collection
console.log('\n\n=== AIRFREIGHT_HOLDS COLLECTION ===')
const holdsCol = await runQuery('airfreight_holds')
for (const d of holdsCol) {
  const f = d.document.fields
  const holdAwb = normalizeAwb(f.awb_number?.stringValue || '')
  if (holdAwb === awb1 || holdAwb === awb2) {
    const holdId = d.document.name.split('/').pop()
    console.log(`  ${holdId} | AWB: ${f.awb_number?.stringValue} | bag: ${f.bag?.stringValue||''} | box: ${f.box?.stringValue||''} | status: ${f.status?.stringValue||'?'} | booking: ${f.booking_id?.stringValue||'?'}`)
  }
}

// 3. Check the sheet sync alerts for these AWBs
console.log('\n\n=== SYNC ALERTS RELATED ===')
const alerts = await runQuery('_sheet_sync_alerts')
for (const d of alerts) {
  const f = d.document.fields
  const awb = normalizeAwb(f.awb_number?.stringValue || f.awb?.stringValue || '')
  if (awb === awb1 || awb === awb2) {
    const alertId = d.document.name.split('/').pop()
    console.log(`  ${alertId} | AWB: ${f.awb_number?.stringValue || f.awb?.stringValue} | type: ${f.alert_type?.stringValue} | status: ${f.status?.stringValue}`)
  }
}

// 4. Check last sync run details
console.log('\n\n=== LAST SYNC RUNS ===')
const runs = await runQuery('_sheet_sync_runs', {orderBy:[{field:{fieldPath:'run_at'},direction:'DESCENDING'}],limit:3})
for (const d of runs) {
  const f = d.document.fields
  console.log(`  ${f.run_at?.stringValue || '?'} | status=${f.status?.stringValue} | changes=${f.changes_detected?.integerValue || '?'} | applied=${f.changes_applied?.integerValue || '?'}`)
  // Check if there are details about these AWBs
  const details = f.details?.stringValue || f.applied_changes?.arrayValue?.values || ''
  if (typeof details === 'string' && (details.includes('3283') || details.includes('3305'))) {
    console.log(`    ^ Contains reference to our AWBs`)
  }
}
