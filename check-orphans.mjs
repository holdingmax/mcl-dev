import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
const config = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = config.tokens.refresh_token
const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' }) })
const token = (await res.json()).access_token
const BASE = 'https://firestore.googleapis.com/v1/projects/wms-mcl/databases/(default)/documents'

// Get latest runs
let allRuns = [], rnpt = null
do {
  let u = BASE + '/_sheet_sync_runs?pageSize=50'
  if (rnpt) u += '&pageToken=' + rnpt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  allRuns.push(...(d.documents || []))
  rnpt = d.nextPageToken
} while (rnpt)

console.log(`Total runs in collection: ${allRuns.length}`)

// Show raw fields of last few docs
const byTime = allRuns.map(doc => {
  const f = doc.fields || {}
  const ts = doc.createTime || doc.updateTime || ''
  const fieldNames = Object.keys(f)
  const summary = {}
  for (const k of fieldNames) {
    const v = f[k]
    summary[k] = v?.stringValue || v?.integerValue || v?.timestampValue || v?.booleanValue || '?'
  }
  return { ts, id: doc.name.split('/').pop(), ...summary }
}).sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))

console.log('\n=== LAST 10 RUNS ===')
for (const r of byTime.slice(0, 10)) {
  console.log(JSON.stringify(r))
}

// Check orphans
const ORPHANS = [
  '36999782605','36999782841','36999783611','36998153521',
  '36999783784','36999783806',
  '36998153510','36998153532','36998153543','36998153565','36998153576',
  '36999362292','36999362303','36999362314',
  '36999784005','36999784230','36999784252','36999784263',
]

let allBk = [], npt = null
do {
  let u = BASE + '/airfreight_bookings?pageSize=300'
  if (npt) u += '&pageToken=' + npt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  allBk.push(...(d.documents || []))
  npt = d.nextPageToken
} while (npt)

const found = new Set()
for (const doc of allBk) {
  const lines = doc.fields?.awb_lines?.arrayValue?.values || []
  for (const l of lines) {
    const awb = (l.mapValue?.fields?.awb_number?.stringValue || '').replace(/[\s\-]/g, '')
    if (ORPHANS.includes(awb)) found.add(awb)
  }
}

console.log('\n=== ORPHAN STATUS ===')
console.log(`Found in bookings: ${found.size} / ${ORPHANS.length}`)
const still = ORPHANS.filter(a => !found.has(a))
if (still.length > 0) {
  console.log('Still missing: ' + still.join(', '))
} else {
  console.log('ALL ORPHANS RESOLVED')
}
