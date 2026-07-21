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
  if ('timestampValue' in v) return v.timestampValue
  if ('mapValue' in v) { const o = {}; for (const [k,val] of Object.entries(v.mapValue.fields||{})) o[k]=pv(val); return o }
  return v
}

let snaps = [], npt = null
do {
  let u = BASE + '/_sheet_sync_snapshots?pageSize=300'
  if (npt) u += '&pageToken=' + npt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  snaps.push(...(d.documents || []))
  npt = d.nextPageToken
} while (npt)

console.log(`Total snapshots: ${snaps.length}\n`)

// The 30 AWBs currently in PENDING
const PENDING_AWBS = [
  '369-99783272','369-99783283','369-99783294','369-99783305','369-99783740',
  '369-99783504','172-05091892','369-99783493','369-98154313','369-98153495',
  '369-99783773','369-98153506','369-98153473','369-98154711','369-99783515',
  '369-99783994','369-98154696','369-98154722','369-98154733','369-99362060',
  '369-99362071','369-99362082','369-99362093','369-99362104','369-99362130',
  '369-99362141','369-99362115','369-99362152','369-99362174','369-99362185',
]
const pendingNorms = new Set(PENDING_AWBS.map(a => a.replace(/[\s\-]/g, '')))

// Also check the 2 missing ones
const MISSING = ['369-99783784','369-99783806']
const missingNorms = new Set(MISSING.map(a => a.replace(/[\s\-]/g, '')))

for (const doc of snaps) {
  const f = doc.fields || {}
  const docId = doc.name.split('/').pop()
  const clientId = pv(f.client_id) || ''
  const monthKey = pv(f.month_key) || ''
  const tabName = pv(f.tab_name) || ''
  const lastChecked = pv(f.last_checked_at) || ''
  const lastChanged = pv(f.last_changed_at) || ''
  const hashes = f.row_hashes?.mapValue?.fields || {}
  const hashCount = Object.keys(hashes).length

  console.log(`--- Snapshot: ${docId} ---`)
  console.log(`  client: ${clientId} | month: ${monthKey} | tab: ${tabName}`)
  console.log(`  hashes: ${hashCount} | lastChecked: ${lastChecked} | lastChanged: ${lastChanged}`)

  // Check which PENDING AWBs have hashes
  let pendingWithHash = 0
  let pendingWithoutHash = 0
  for (const awb of PENDING_AWBS) {
    const norm = awb.replace(/[\s\-]/g, '')
    // Check both formats: with and without dashes
    const hasHash = hashes[awb] || hashes[norm] || Object.keys(hashes).some(k => k.replace(/[\s\-]/g, '') === norm)
    if (hasHash) {
      pendingWithHash++
    } else {
      pendingWithoutHash++
    }
  }
  console.log(`  PENDING AWBs with hash: ${pendingWithHash} / ${PENDING_AWBS.length}`)

  // Check missing AWBs
  for (const awb of MISSING) {
    const norm = awb.replace(/[\s\-]/g, '')
    const matchKey = Object.keys(hashes).find(k => k.replace(/[\s\-]/g, '') === norm)
    if (matchKey) {
      console.log(`  MISSING AWB ${awb} HAS hash (key: "${matchKey}")`)
    }
  }

  // List ALL hash keys that match any PENDING AWB
  console.log(`\n  Hash keys for PENDING AWBs:`)
  for (const [key, val] of Object.entries(hashes)) {
    const keyNorm = key.replace(/[\s\-]/g, '')
    if (pendingNorms.has(keyNorm)) {
      console.log(`    "${key}" -> ${pv(val).slice(0,16)}`)
    }
    if (missingNorms.has(keyNorm)) {
      console.log(`    "${key}" -> ${pv(val).slice(0,16)} [MISSING FROM SYSTEM]`)
    }
  }
  console.log()
}
