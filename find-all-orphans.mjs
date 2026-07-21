import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
const config = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = config.tokens.refresh_token
const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' }) })
const data = await res.json()
const token = data.access_token
const BASE = 'https://firestore.googleapis.com/v1/projects/wms-mcl/databases/(default)/documents'
function pv(v) {
  if (!v) return null
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('booleanValue' in v) return v.booleanValue
  if ('mapValue' in v) { const o = {}; for (const [k,val] of Object.entries(v.mapValue.fields||{})) o[k]=pv(val); return o }
  if ('arrayValue' in v) return (v.arrayValue.values||[]).map(pv)
  return v
}

// ALL AWBs that were in the PENDING booking ecIfM9uze4Ea
const allPendingAwbs = [
  '36999783272', '36999783283', '36999783294', '36999783305',
  '17205091892', '36998154313', '36999783493', '36999783740'
]

let bookings = [], npt = null
do {
  let u = BASE + '/airfreight_bookings?pageSize=300'
  if (npt) u += '&pageToken=' + npt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  bookings.push(...(d.documents || []))
  npt = d.nextPageToken
} while (npt)

console.log(`Total bookings: ${bookings.length}\n`)

// Also check if ecIfM9uze4Ea still exists
const directCheck = await fetch(BASE + '/airfreight_bookings/ecIfM9uze4Ea5rjY7nNH', { headers: { Authorization: 'Bearer ' + token } })
const dc = await directCheck.json()
if (dc.fields) {
  console.log('ecIfM9uze4Ea STILL EXISTS')
  const lines = pv(dc.fields.awb_lines) || []
  const fn = pv(dc.fields.flight_number) || ''
  console.log(`  flight: "${fn}" | lines: ${lines.length}`)
  for (const l of lines) console.log(`    ${l.awb_number}`)
} else {
  console.log('ecIfM9uze4Ea NOT FOUND (deleted or ID wrong)')
}

// Search with shorter ID patterns
console.log('\n=== SEARCHING BY ID PREFIX ===')
for (const doc of bookings) {
  const id = doc.name.split('/').pop()
  if (id.startsWith('ecIfM9uz')) {
    const f = doc.fields || {}
    const fn = pv(f.flight_number) || ''
    const lines = pv(f.awb_lines) || []
    console.log(`  ${id} | flight: "${fn}" | lines: ${lines.length}`)
  }
}

console.log('\n=== SEARCHING FOR ORPHAN AWBs IN ALL BOOKINGS ===')
const found = new Set()
for (const doc of bookings) {
  const f = doc.fields || {}
  const lines = pv(f.awb_lines) || []
  const bid = doc.name.split('/').pop()
  const fn = pv(f.flight_number) || ''
  for (const l of lines) {
    const norm = (l.awb_number || '').replace(/[\s\-]/g, '')
    if (allPendingAwbs.includes(norm)) {
      console.log(`  FOUND: ${l.awb_number} in ${bid.slice(0,12)} | flight: "${fn}" | w: ${l.weight||0}`)
      found.add(norm)
    }
  }
}

const missing = allPendingAwbs.filter(a => !found.has(a))
if (missing.length > 0) {
  console.log(`\n=== ORPHAN AWBs NOT IN ANY BOOKING ===`)
  for (const m of missing) console.log(`  ${m}`)
}
