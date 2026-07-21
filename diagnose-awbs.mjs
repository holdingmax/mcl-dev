import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
const config = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = config.tokens.refresh_token
const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' }) })
const token = (await res.json()).access_token
const BASE = 'https://firestore.googleapis.com/v1/projects/wms-mcl/databases/(default)/documents'
function pv(v) {
  if (!v) return null
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('booleanValue' in v) return v.booleanValue
  if ('mapValue' in v) { const o = {}; for (const [k,val] of Object.entries(v.mapValue.fields||{})) o[k]=pv(val); return o }
  if ('arrayValue' in v) return (v.arrayValue.values||[]).map(pv)
  return v
}

const TARGETS = [
  '36999783515',  // row 1
  '36999783784',  // row 2 (green highlight)
  '36999783806',  // row 3
  '36998153473',  // row 4
  '36998154711',  // row 5 (PENDING in sheet)
]

// 1. Search all bookings for these AWBs
let bookings = [], npt = null
do {
  let u = BASE + '/airfreight_bookings?pageSize=300'
  if (npt) u += '&pageToken=' + npt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  bookings.push(...(d.documents || []))
  npt = d.nextPageToken
} while (npt)

console.log('=== SEARCH IN ALL BOOKINGS ===')
const found = new Map()
for (const doc of bookings) {
  const f = doc.fields || {}
  const lines = pv(f.awb_lines) || []
  const bid = doc.name.split('/').pop()
  const fn = String(pv(f.flight_number) ?? '').replace(/\n/g, ' ')
  const flightId = pv(f.flight_id) || ''
  for (const l of lines) {
    const norm = (l.awb_number || '').replace(/[\s\-]/g, '')
    if (TARGETS.includes(norm)) {
      console.log(`  ${l.awb_number} -> booking ${bid.slice(0,16)} | flight: "${fn}" | flight_id: ${flightId.slice(0,12)}`)
      found.set(norm, { bid, fn, flightId })
    }
  }
}

const missing = TARGETS.filter(t => !found.has(t))
if (missing.length > 0) {
  console.log('\n  NOT IN ANY BOOKING:')
  for (const m of missing) console.log(`    ${m}`)
}

// 2. Check snapshot hashes for these AWBs
console.log('\n=== SNAPSHOT HASHES ===')
let snaps = [], snpt = null
do {
  let u = BASE + '/_sheet_sync_snapshots?pageSize=300'
  if (snpt) u += '&pageToken=' + snpt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  snaps.push(...(d.documents || []))
  snpt = d.nextPageToken
} while (snpt)

for (const doc of snaps) {
  const f = doc.fields || {}
  const hashes = f.rowHashes?.mapValue?.fields
  if (!hashes) continue
  const docId = doc.name.split('/').pop()
  for (const key of Object.keys(hashes)) {
    const keyNorm = key.replace(/[\s\-]/g, '')
    if (TARGETS.includes(keyNorm)) {
      console.log(`  ${key} -> snapshot ${docId.slice(0,16)} | hash: ${pv(hashes[key])}`)
    }
  }
}

// 3. Check alerts for these AWBs
console.log('\n=== ALERTS ===')
let alerts = [], anpt = null
do {
  let u = BASE + '/_sheet_sync_alerts?pageSize=300'
  if (anpt) u += '&pageToken=' + anpt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  alerts.push(...(d.documents || []))
  anpt = d.nextPageToken
} while (anpt)

for (const doc of alerts) {
  const f = doc.fields || {}
  const awb = (pv(f.awb_1st) || '').replace(/[\s\-]/g, '')
  if (TARGETS.includes(awb)) {
    const fn = String(pv(f.flight_number) ?? '').replace(/\n/g, ' ')
    const type = pv(f.alert_type) || ''
    const status = pv(f.status) || ''
    console.log(`  ${pv(f.awb_1st)} | flight: "${fn}" | type: ${type} | status: ${status}`)
  }
}
