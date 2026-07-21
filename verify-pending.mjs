import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
const config = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = config.tokens.refresh_token
const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: rt,
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
  }),
})
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

// 1. Check PENDING bookings
console.log('=== PENDING BOOKINGS ===')
const bq = await fetch(BASE + ':runQuery', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'airfreight_bookings' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: 'PENDING' } } },
    }
  }),
})
const bd = await bq.json()
const pending = bd.filter(r => r.document)
console.log(`PENDING bookings: ${pending.length}`)
for (const item of pending) {
  const f = item.document.fields || {}
  const bid = item.document.name.split('/').pop()
  const lines = pv(f.awb_lines) || []
  console.log(`\n  ${bid.slice(0,12)} | ${pv(f.client_name)} | ${lines.length} AWBs`)
  for (const l of lines) {
    console.log(`    ${l.awb_number} | 2nd: ${l.awb_2nd_leg || ''} | w: ${l.weight || 0}`)
  }
}

// 2. Check if 369-99783294 / 369-99783305 are now in a UC-1617 booking
console.log('\n=== SEARCH AWBs 369-99783294 and 369-99783305 ===')
const allBookings = []
let npt = null
do {
  let u = BASE + '/airfreight_bookings?pageSize=300'
  if (npt) u += '&pageToken=' + npt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  allBookings.push(...(d.documents || []))
  npt = d.nextPageToken
} while (npt)

const targets = ['36999783294', '36999783305']
for (const doc of allBookings) {
  const f = doc.fields || {}
  const lines = pv(f.awb_lines) || []
  const bid = doc.name.split('/').pop()
  const fn = pv(f.flight_number) || ''
  for (const l of lines) {
    const norm = (l.awb_number || '').replace(/[\s\-]/g, '')
    if (targets.includes(norm)) {
      console.log(`  FOUND: ${l.awb_number} in booking ${bid.slice(0,12)} | flight: ${fn} | w: ${l.weight || 0}`)
    }
  }
}

// 3. Check _sheet_sync_alerts for pending_resolved
console.log('\n=== RECENT ALERTS (pending_resolved) ===')
const aq = await fetch(BASE + ':runQuery', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: '_sheet_sync_alerts' }],
      where: { fieldFilter: { field: { fieldPath: 'alert_type' }, op: 'EQUAL', value: { stringValue: 'pending_resolved' } } },
      limit: 20,
    }
  }),
})
const ad = await aq.json()
const alerts = ad.filter(r => r.document)
console.log(`pending_resolved alerts: ${alerts.length}`)
for (const a of alerts) {
  const f = a.document.fields || {}
  console.log(`  ${pv(f.awb_1st)} | ${pv(f.flight_number)} | ${pv(f.message)}`)
}
