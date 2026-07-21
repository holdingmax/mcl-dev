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
function toFV(val) {
  if (val === null || val === undefined) return { nullValue: null }
  if (typeof val === 'string') return { stringValue: val }
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  if (typeof val === 'boolean') return { booleanValue: val }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } }
  if (typeof val === 'object') { const fields = {}; for (const [k,v] of Object.entries(val)) fields[k]=toFV(v); return { mapValue: { fields } } }
  return { stringValue: String(val) }
}

// Find the new wrong booking with flight "46164"
let all = [], npt = null
do {
  let u = BASE + '/airfreight_bookings?pageSize=300'
  if (npt) u += '&pageToken=' + npt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  all.push(...(d.documents || []))
  npt = d.nextPageToken
} while (npt)

const wrongBookings = all.filter(doc => {
  const f = doc.fields || {}
  const fn = pv(f.flight_number) || ''
  const cb = pv(f.created_by) || ''
  return cb === 'sheet_sync_agent' && fn === '46164'
})

console.log(`Found ${wrongBookings.length} wrong booking(s) with flight "46164"`)

const PENDING_BOOKING_ID = 'ecIfM9uze4EaECazEbXd'
const pendingRes = await fetch(BASE + '/airfreight_bookings/' + PENDING_BOOKING_ID, { headers: { Authorization: 'Bearer ' + token } })
const pendingDoc = await pendingRes.json()
const pendingLines = pv(pendingDoc.fields.awb_lines) || []
const existingNorm = new Set(pendingLines.map(l => (l.awb_number || '').replace(/[\s\-]/g, '')))

let awbsToMove = []
for (const doc of wrongBookings) {
  const f = doc.fields || {}
  const lines = pv(f.awb_lines) || []
  const bid = doc.name.split('/').pop()
  console.log(`  ${bid} | ${lines.length} AWBs`)
  for (const l of lines) {
    const norm = (l.awb_number || '').replace(/[\s\-]/g, '')
    if (!existingNorm.has(norm)) {
      awbsToMove.push(l)
      console.log(`    → ${l.awb_number} (will move to PENDING)`)
    } else {
      console.log(`    → ${l.awb_number} (already in PENDING, skip)`)
    }
  }
}

// Move AWBs to PENDING
if (awbsToMove.length > 0) {
  const newLines = [...pendingLines, ...awbsToMove]
  console.log(`\nUpdating PENDING (${pendingLines.length} → ${newLines.length})...`)
  const patchUrl = `${BASE}/airfreight_bookings/${PENDING_BOOKING_ID}?updateMask.fieldPaths=awb_lines&updateMask.fieldPaths=pieces`
  const pr = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { awb_lines: toFV(newLines), pieces: toFV(newLines.reduce((s, l) => s + (l.pieces || 0), 0)) } }),
  })
  console.log(`  PENDING update: ${pr.ok ? 'OK' : 'FAILED'}`)
}

// Delete wrong bookings
for (const doc of wrongBookings) {
  const bid = doc.name.split('/').pop()
  const dr = await fetch(BASE + '/airfreight_bookings/' + bid, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } })
  console.log(`  DELETE booking ${bid.slice(0,12)}: ${dr.ok ? 'OK' : 'FAILED'}`)
}

// Delete wrong flight
const dr = await fetch(BASE + '/airfreight_flights/QBmISNdDVwN6DNiVtIA4', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } })
console.log(`  DELETE flight QBmISNdDVwN6: ${dr.ok ? 'OK' : 'FAILED'}`)

// Clean alerts for these AWBs
let alerts = [], anpt = null
do {
  let u = BASE + '/_sheet_sync_alerts?pageSize=300'
  if (anpt) u += '&pageToken=' + anpt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  alerts.push(...(d.documents || []))
  anpt = d.nextPageToken
} while (anpt)

const movedNorms = new Set(awbsToMove.map(a => (a.awb_number || '').replace(/[\s\-]/g, '')))
let cleaned = 0
for (const doc of alerts) {
  const f = doc.fields || {}
  const awb = (pv(f.awb_1st) || '').replace(/[\s\-]/g, '')
  const fn = (pv(f.flight_number) || '')
  const alertType = pv(f.alert_type) || ''
  if (movedNorms.has(awb) && fn.includes('46164')) {
    const aid = doc.name.split('/').pop()
    const adr = await fetch(BASE + '/_sheet_sync_alerts/' + aid, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } })
    if (adr.ok) cleaned++
  }
}
console.log(`  Cleaned ${cleaned} alerts`)

// Clear snapshot hashes
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
  let modified = false
  const newHashes = { ...hashes }
  for (const key of Object.keys(hashes)) {
    const keyNorm = key.replace(/[\s\-]/g, '')
    if (movedNorms.has(keyNorm)) {
      delete newHashes[key]
      modified = true
      console.log(`  Removing hash for ${key}`)
    }
  }
  if (modified) {
    const patchUrl = `${BASE}/_sheet_sync_snapshots/${docId}?updateMask.fieldPaths=rowHashes`
    const pr = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { rowHashes: { mapValue: { fields: newHashes } } } }),
    })
    console.log(`  Snapshot ${docId.slice(0,12)} updated: ${pr.ok ? 'OK' : 'FAILED'}`)
  }
}

console.log('\nDone.')
