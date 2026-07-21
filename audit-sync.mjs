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

// 1. Sync configs
console.log('=== SYNC CONFIGS ===')
const configs = await runQuery('_sheet_sync_configs')
for (const d of configs) {
  const f = d.document.fields
  const id = d.document.name.split('/').pop()
  console.log(`  ${id} | ${f.client_name?.stringValue || '?'} | active: ${f.active?.booleanValue} | sheet: ${(f.sheet_id?.stringValue || '').slice(0,20)}...`)
}

// 2. Booking types
console.log('\n=== BOOKING TYPES ===')
const bookings = await runQuery('airfreight_bookings')
const typeCount = {}
const clientTypes = {}
for (const d of bookings) {
  const f = d.document.fields
  const bt = f.booking_type?.stringValue || 'unknown'
  const client = f.client_name?.stringValue || '?'
  typeCount[bt] = (typeCount[bt] || 0) + 1
  if (!clientTypes[client]) clientTypes[client] = new Set()
  clientTypes[client].add(bt)
}
for (const [t, c] of Object.entries(typeCount)) console.log(`  ${t}: ${c}`)

// 3. Client breakdown
console.log('\n=== CLIENTS & BOOKING TYPES ===')
for (const [client, types] of Object.entries(clientTypes)) {
  console.log(`  ${client}: ${[...types].join(', ')}`)
}

// 4. Holds audit
console.log('\n=== HOLDS AUDIT ===')
let totalHoldsInBookings = 0
let placeholderHolds = 0
let holdsWithRealData = 0
let holdsNoAwb = 0

for (const d of bookings) {
  const f = d.document.fields
  const lines = f.awb_lines?.arrayValue?.values || []
  for (const line of lines) {
    const lf = line.mapValue?.fields || {}
    const holdFlag = lf.hold?.booleanValue || false
    const holds = lf.holds?.arrayValue?.values || []
    if (holdFlag || holds.length > 0) {
      totalHoldsInBookings++
      const awb = lf.awb_number?.stringValue || ''
      if (!awb) holdsNoAwb++
      for (const h of holds) {
        const hf = h.mapValue?.fields || {}
        const bag = hf.bag?.stringValue || ''
        const box = hf.box?.stringValue || ''
        if (bag === 'hold' || box === 'hold' || bag === '' || box === '') {
          placeholderHolds++
        } else {
          holdsWithRealData++
        }
      }
    }
  }
}

// Holds in airfreight_holds collection
const holdsCol = await runQuery('airfreight_holds')
let colPlaceholders = 0
let colRealData = 0
for (const d of holdsCol) {
  const f = d.document.fields
  const bag = f.bag?.stringValue || ''
  const box = f.box?.stringValue || ''
  if (bag === 'hold' || box === 'hold' || bag === '' || box === '') {
    colPlaceholders++
  } else {
    colRealData++
  }
}

console.log(`  Holds in booking awb_lines: ${totalHoldsInBookings}`)
console.log(`    With real bag/box: ${holdsWithRealData}`)
console.log(`    With placeholder: ${placeholderHolds}`)
console.log(`    Missing AWB: ${holdsNoAwb}`)
console.log(`  Holds in airfreight_holds collection: ${holdsCol.length}`)
console.log(`    With real bag/box: ${colRealData}`)
console.log(`    With placeholder: ${colPlaceholders}`)

// 5. Check which booking holds are NOT in airfreight_holds
console.log('\n=== MISSING FROM AIRFREIGHT_HOLDS ===')
const existingHoldKeys = new Set()
for (const d of holdsCol) {
  const f = d.document.fields
  const key = `${f.booking_id?.stringValue}|${f.awb_number?.stringValue}|${f.bag?.stringValue}|${f.box?.stringValue}`
  existingHoldKeys.add(key)
}

let missingCount = 0
for (const d of bookings) {
  const f = d.document.fields
  const bookingId = d.document.name.split('/').pop()
  const lines = f.awb_lines?.arrayValue?.values || []
  for (const line of lines) {
    const lf = line.mapValue?.fields || {}
    const holds = lf.holds?.arrayValue?.values || []
    const awb = lf.awb_number?.stringValue || ''
    for (const h of holds) {
      const hf = h.mapValue?.fields || {}
      const bag = hf.bag?.stringValue || ''
      const box = hf.box?.stringValue || ''
      const key = `${bookingId}|${awb}|${bag}|${box}`
      if (!existingHoldKeys.has(key)) {
        missingCount++
        if (missingCount <= 15) {
          console.log(`  MISSING: ${awb} | bag=${bag} | box=${box} | booking=${bookingId.slice(0,8)} | flight=${f.flight_number?.stringValue || '?'}`)
        }
      }
    }
  }
}
console.log(`  Total missing: ${missingCount}`)

// 6. Alerts audit
console.log('\n=== ALERTS AUDIT ===')
const alerts = await runQuery('_sheet_sync_alerts')
const alertsByType = {}
const alertsByStatus = {}
for (const d of alerts) {
  const f = d.document.fields
  const t = f.alert_type?.stringValue || '?'
  const s = f.status?.stringValue || '?'
  alertsByType[t] = (alertsByType[t] || 0) + 1
  alertsByStatus[s] = (alertsByStatus[s] || 0) + 1
}
console.log('  By type:', JSON.stringify(alertsByType))
console.log('  By status:', JSON.stringify(alertsByStatus))

// 7. Recent runs
console.log('\n=== RECENT SYNC RUNS ===')
const runs = await runQuery('_sheet_sync_runs', {orderBy:[{field:{fieldPath:'run_at'},direction:'DESCENDING'}],limit:5})
for (const d of runs) {
  const f = d.document.fields
  console.log(`  ${f.run_at?.stringValue || '?'} | status=${f.status?.stringValue} | changes=${f.changes_detected?.integerValue || '?'} | applied=${f.changes_applied?.integerValue || '?'} | alerts=${f.alerts_generated?.integerValue || '?'} | errors=${f.errors?.stringValue || f.errors?.arrayValue ? 'yes' : 'none'}`)
}
