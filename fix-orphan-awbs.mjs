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
function toFV(val) {
  if (val === null || val === undefined) return { nullValue: null }
  if (typeof val === 'string') return { stringValue: val }
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  if (typeof val === 'boolean') return { booleanValue: val }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } }
  if (typeof val === 'object') { const fields = {}; for (const [k,v] of Object.entries(val)) fields[k]=toFV(v); return { mapValue: { fields } } }
  return { stringValue: String(val) }
}

// The orphan AWBs that were removed from PENDING booking ecIfM9uze4Ea
const orphans = [
  { awb_number: '172-05091892', awb_2nd_leg: '729-93889585', weight: 0, pieces: 0, chargeable_weight: 0, on_hand: false, hold: false },
  { awb_number: '369-98154313', awb_2nd_leg: '729-93889596', weight: 0, pieces: 0, chargeable_weight: 0, on_hand: false, hold: false },
  { awb_number: '369-99783493', awb_2nd_leg: '729-93889600', weight: 0, pieces: 0, chargeable_weight: 0, on_hand: false, hold: false },
]

const PENDING_BOOKING_ID = 'ecIfM9uze4Ea5rjY7nNH'

// First, get current booking data
const bookingUrl = BASE + '/airfreight_bookings/' + PENDING_BOOKING_ID
const br = await fetch(bookingUrl, { headers: { Authorization: 'Bearer ' + token } })
const bd = await br.json()

if (!bd.fields) {
  // Try shorter ID
  console.log('Trying to find booking by query...')
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
  const bqd = await bq.json()
  const pending = bqd.filter(r => r.document)
  if (pending.length === 0) { console.log('No PENDING booking found!'); process.exit(1) }

  const doc = pending[0].document
  const docId = doc.name.split('/').pop()
  const f = doc.fields || {}
  const lines = pv(f.awb_lines) || []

  console.log(`Found PENDING booking: ${docId}`)
  console.log(`Current lines: ${lines.length}`)

  // Check which orphans are NOT already in the booking
  const existingAwbs = new Set(lines.map(l => (l.awb_number || '').replace(/[\s\-]/g, '')))
  const toAdd = orphans.filter(o => !existingAwbs.has(o.awb_number.replace(/[\s\-]/g, '')))

  if (toAdd.length === 0) {
    console.log('All orphan AWBs already in PENDING booking. Nothing to do.')
    process.exit(0)
  }

  console.log(`Adding ${toAdd.length} orphan AWBs back to PENDING booking:`)
  for (const o of toAdd) console.log(`  ${o.awb_number} | 2nd: ${o.awb_2nd_leg}`)

  const newLines = [...lines, ...toAdd]

  // Patch
  const patchUrl = `${BASE}/airfreight_bookings/${docId}?updateMask.fieldPaths=awb_lines&updateMask.fieldPaths=pieces`
  const pr = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        awb_lines: toFV(newLines),
        pieces: toFV(newLines.reduce((s, l) => s + (l.pieces || 0), 0)),
      }
    }),
  })
  if (pr.ok) {
    console.log(`\nDone. PENDING booking now has ${newLines.length} AWBs.`)
  } else {
    console.error('PATCH failed:', await pr.text())
  }
}
