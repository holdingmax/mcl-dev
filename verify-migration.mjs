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

async function getAllDocs(coll) {
  let all = [], npt = null
  do {
    let u = BASE + '/' + coll + '?pageSize=300'
    if (npt) u += '&pageToken=' + npt
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
    const d = await r.json()
    all.push(...(d.documents || []))
    npt = d.nextPageToken
  } while (npt)
  return all
}

const bookings = await getAllDocs('airfreight_bookings')
console.log('=== REMAINING AGENT BOOKINGS ===')
for (const doc of bookings) {
  const f = doc.fields || {}
  if (pv(f.created_by) === 'sheet_sync_agent') {
    const id = doc.name.split('/').pop()
    const fn = (pv(f.flight_number) || '').replace(/\n/g, ' ')
    const lines = pv(f.awb_lines) || []
    console.log(`  ${id.slice(0,16)} | "${fn}" | ${lines.length} AWBs`)
    for (const l of lines) console.log(`    ${l.awb_number} | 2nd: ${l.awb_2nd_leg || ''}`)
  }
}

const flights = await getAllDocs('airfreight_flights')
console.log('\n=== REMAINING AGENT FLIGHTS ===')
for (const doc of flights) {
  const f = doc.fields || {}
  if (pv(f.created_by) === 'sheet_sync_agent') {
    const id = doc.name.split('/').pop()
    const fn = (pv(f.flight_number) || '').replace(/\n/g, ' ')
    console.log(`  ${id} | "${fn}"`)
  }
}
