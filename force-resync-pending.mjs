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
  if ('mapValue' in v) { const o = {}; for (const [k,val] of Object.entries(v.mapValue.fields||{})) o[k]=pv(val); return o }
  if ('arrayValue' in v) return (v.arrayValue.values||[]).map(pv)
  return v
}

// 1. Find the PENDING booking's AWB keys
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

// Collect normalized AWB keys that are in PENDING
const pendingAwbKeys = new Set()
for (const item of pending) {
  const f = item.document.fields || {}
  const lines = pv(f.awb_lines) || []
  for (const l of lines) {
    // Keep original format (with dashes) to match snapshot keys
    const awb1 = (l.awb_number || '').trim()
    const awb2 = (l.awb_2nd_leg || '').trim()
    if (awb1) pendingAwbKeys.add(awb1)
    if (awb2) pendingAwbKeys.add(awb2)
  }
}
console.log(`PENDING AWB keys to force resync: ${pendingAwbKeys.size}`)
for (const k of pendingAwbKeys) console.log(`  ${k}`)

// 2. Find and update the snapshot — remove hashes for these AWBs
const monthKey = new Date().toISOString().slice(0, 7)
// We need to find the client_id for Express Line
const clientsSnap = await fetch(BASE + '/airfreight_clients?pageSize=50', {
  headers: { Authorization: 'Bearer ' + token },
})
const clientsData = await clientsSnap.json()
let expressLineId = null
for (const doc of (clientsData.documents || [])) {
  const f = doc.fields || {}
  const name = pv(f.name) || pv(f.client_name) || ''
  if (name.toLowerCase().includes('express')) {
    expressLineId = doc.name.split('/').pop()
    console.log(`\nExpress Line client_id: ${expressLineId}`)
    break
  }
}

if (!expressLineId) {
  console.log('Could not find Express Line client. Trying snapshot search...')
  // List all snapshots
  const snapRes = await fetch(BASE + '/_sheet_sync_snapshots?pageSize=50', {
    headers: { Authorization: 'Bearer ' + token },
  })
  const snapData = await snapRes.json()
  for (const doc of (snapData.documents || [])) {
    const id = doc.name.split('/').pop()
    console.log(`  Snapshot: ${id}`)
  }
  process.exit(1)
}

const snapshotId = `${expressLineId}_${monthKey}`
console.log(`Snapshot ID: ${snapshotId}`)

const snapRes = await fetch(BASE + `/_sheet_sync_snapshots/${snapshotId}`, {
  headers: { Authorization: 'Bearer ' + token },
})
const snapDoc = await snapRes.json()

if (!snapDoc.fields) {
  console.log('Snapshot not found!')
  process.exit(1)
}

const rowHashes = pv(snapDoc.fields.row_hashes) || {}
console.log(`\nCurrent snapshot has ${Object.keys(rowHashes).length} hashes`)

// Remove hashes for PENDING AWBs to force re-detection as "new"
let removed = 0
for (const key of Object.keys(rowHashes)) {
  if (pendingAwbKeys.has(key)) {
    console.log(`  Removing hash for: ${key}`)
    delete rowHashes[key]
    removed++
  }
}

if (removed === 0) {
  console.log('\nNo matching hashes found in snapshot. The AWBs may be keyed differently.')
  console.log('Snapshot keys sample:', Object.keys(rowHashes).slice(0, 10))
  console.log('Pending keys:', [...pendingAwbKeys])
  process.exit(0)
}

// Write updated snapshot
function toFV(val) {
  if (val === null || val === undefined) return { nullValue: null }
  if (typeof val === 'string') return { stringValue: val }
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  if (typeof val === 'boolean') return { booleanValue: val }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } }
  if (typeof val === 'object') { const fields = {}; for (const [k,v] of Object.entries(val)) fields[k]=toFV(v); return { mapValue: { fields } } }
  return { stringValue: String(val) }
}

const patchUrl = `${BASE}/_sheet_sync_snapshots/${snapshotId}?updateMask.fieldPaths=row_hashes`
const patchRes = await fetch(patchUrl, {
  method: 'PATCH',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ fields: { row_hashes: toFV(rowHashes) } }),
})
if (patchRes.ok) {
  console.log(`\nRemoved ${removed} hashes. Next agent run will re-detect these AWBs as NEW and trigger PENDING→real transition.`)
} else {
  console.error('PATCH failed:', await patchRes.text())
}
