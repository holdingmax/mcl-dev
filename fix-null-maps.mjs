/**
 * Fix 4 bookings where null fields were stored as maps {nullValue: null}
 * instead of proper Firestore null values.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const config = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = config.tokens.refresh_token
const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' }) })
const token = (await res.json()).access_token
const BASE = 'https://firestore.googleapis.com/v1/projects/wms-mcl/databases/(default)/documents'

const AFFECTED = [
  'TNHrhQGScwEtBtgv46pw',
  'Utsbc0rkRMbHh0jE2GDs',
  'YW772SousGAD0xekw937',
  'aQnHwwTuhNBJDDdnI7Q9',
]

function fixValue(v) {
  if (!v) return v
  // If it's a null-as-map: {mapValue: {fields: {nullValue: {nullValue: null}}}}
  if (v.mapValue?.fields && Object.keys(v.mapValue.fields).length === 1 && 'nullValue' in v.mapValue.fields) {
    return { nullValue: null }
  }
  // Recurse into real maps
  if (v.mapValue?.fields) {
    const fixed = {}
    for (const [k, val] of Object.entries(v.mapValue.fields)) {
      fixed[k] = fixValue(val)
    }
    return { mapValue: { fields: fixed } }
  }
  // Recurse into arrays
  if (v.arrayValue?.values) {
    return { arrayValue: { values: v.arrayValue.values.map(fixValue) } }
  }
  return v
}

for (const bookingId of AFFECTED) {
  console.log(`\nFixing ${bookingId}...`)
  const r = await fetch(`${BASE}/airfreight_bookings/${bookingId}`, { headers: { Authorization: 'Bearer ' + token } })
  const doc = await r.json()

  const lines = doc.fields?.awb_lines?.arrayValue?.values || []
  let fixCount = 0

  const fixedLines = lines.map((line, idx) => {
    const fields = line.mapValue?.fields || {}
    const fixedFields = {}
    for (const [k, v] of Object.entries(fields)) {
      const fixed = fixValue(v)
      if (fixed !== v) fixCount++
      fixedFields[k] = fixed
    }
    return { mapValue: { fields: fixedFields } }
  })

  console.log(`  Fixed ${fixCount} null-as-map fields`)

  // Write back
  const params = 'updateMask.fieldPaths=awb_lines'
  const wr = await fetch(`${BASE}/airfreight_bookings/${bookingId}?${params}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { awb_lines: { arrayValue: { values: fixedLines } } } }),
  })
  console.log(`  Write: ${wr.ok ? 'OK' : 'FAILED (' + wr.status + ')'}`)

  // Verify
  const vr = await fetch(`${BASE}/airfreight_bookings/${bookingId}`, { headers: { Authorization: 'Bearer ' + token } })
  const vdoc = await vr.json()
  const vlines = vdoc.fields?.awb_lines?.arrayValue?.values || []
  let remaining = 0
  for (const l of vlines) {
    for (const [k, v] of Object.entries(l.mapValue?.fields || {})) {
      if (v?.mapValue?.fields && 'nullValue' in v.mapValue.fields) remaining++
    }
  }
  console.log(`  Verify: ${remaining === 0 ? 'CLEAN' : remaining + ' null-maps remain'}`)

  // Show first line
  const fl = vlines[0]?.mapValue?.fields || {}
  console.log(`  First line awb: ${fl.awb_number?.stringValue || 'EMPTY'} | uld: ${fl.uld_type?.stringValue || 'n/a'}`)
}

console.log('\nDone. Refresh the page to verify.')
