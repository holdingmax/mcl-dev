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

let all = [], npt = null
do {
  let u = BASE + '/_sheet_sync_configs?pageSize=100'
  if (npt) u += '&pageToken=' + npt
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
  const d = await r.json()
  all.push(...(d.documents || []))
  npt = d.nextPageToken
} while (npt)

for (const doc of all) {
  const f = doc.fields || {}
  const id = doc.name.split('/').pop()
  console.log(`Config: ${id}`)
  console.log(`  client_id: ${pv(f.client_id)}`)
  console.log(`  client_name: ${pv(f.client_name)}`)
  console.log(`  enabled: ${pv(f.enabled)}`)
  console.log(`  spreadsheet_id: ${pv(f.spreadsheet_id)}`)
  console.log(`  tab_name: ${pv(f.tab_name)}`)
  console.log()
}
