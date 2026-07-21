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
  if ('mapValue' in v) { const o = {}; for (const [k,val] of Object.entries(v.mapValue.fields||{})) o[k]=pv(val); return o }
  if ('arrayValue' in v) return (v.arrayValue.values||[]).map(pv)
  return v
}

const targets = ['17205091892','36998154313','36999783493']
let all = [], npt = null
do {
  let u = BASE + '/airfreight_bookings?pageSize=300'
  if (npt) u += '&pageToken=' + npt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  all.push(...(d.documents || []))
  npt = d.nextPageToken
} while (npt)

console.log('=== SEARCHING FOR MOVED AWBs ===')
for (const doc of all) {
  const f = doc.fields || {}
  const lines = pv(f.awb_lines) || []
  const bid = doc.name.split('/').pop()
  const fn = pv(f.flight_number) || ''
  const flightId = pv(f.flight_id) || ''
  for (const l of lines) {
    const norm = (l.awb_number || '').replace(/[\s\-]/g, '')
    if (targets.includes(norm)) {
      console.log(`  ${bid.slice(0,12)} | flight: "${fn}" | flight_id: ${flightId.slice(0,12)} | AWB: ${l.awb_number} | w: ${l.weight||0}`)
    }
  }
}

// Also check flights created by agent
console.log('\n=== AGENT-CREATED FLIGHTS ===')
let flights = [], fnpt = null
do {
  let u = BASE + '/airfreight_flights?pageSize=300'
  if (fnpt) u += '&pageToken=' + fnpt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  flights.push(...(d.documents || []))
  fnpt = d.nextPageToken
} while (fnpt)

for (const doc of flights) {
  const f = doc.fields || {}
  const cb = pv(f.created_by) || ''
  if (cb === 'sheet_sync_agent') {
    const id = doc.name.split('/').pop()
    const fn = pv(f.flight_number) || ''
    const dt = pv(f.flight_datetime) || ''
    console.log(`  ${id} | "${fn}" | ${dt}`)
  }
}
