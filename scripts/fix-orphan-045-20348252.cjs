// One-time fix: Link orphan doc reception obOZ4gOAd1BDnyKTqmV4 to its booking
// AWB 045-20348252, booking bfIeh09YUOyuU7ZfeNR4
const https = require('https')
const os = require('os')
const path = require('path')
const fs = require('fs')

function findRefreshToken() {
  const locations = [
    path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'configstore', 'firebase-tools.json'),
    path.join(process.env.APPDATA || '', 'configstore', 'firebase-tools.json'),
  ]
  for (const loc of locations) {
    try {
      if (fs.existsSync(loc)) {
        const config = JSON.parse(fs.readFileSync(loc, 'utf-8'))
        return config.tokens?.refresh_token || config.user?.tokens?.refresh_token
      }
    } catch (e) {}
  }
  return null
}

function getAccessToken(rt) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: rt,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }).toString()
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d).access_token) } catch(e) { reject(e) } })
    })
    req.on('error', reject); req.write(body); req.end()
  })
}

function patchDoc(at, docPath, fields) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ fields })
    const fieldPaths = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&')
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/wms-mcl/databases/(default)/documents/${docPath}?${fieldPaths}`,
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + at, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(e) } })
    })
    req.on('error', reject); req.write(body); req.end()
  })
}

function getDoc(at, docPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/wms-mcl/databases/(default)/documents/${docPath}`,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + at },
    }, res => {
      let d = ''; res.on('data', c => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(e) } })
    })
    req.on('error', reject); req.end()
  })
}

function extractVal(field) {
  if (!field) return null
  if (field.stringValue !== undefined) return field.stringValue
  if (field.integerValue !== undefined) return Number(field.integerValue)
  if (field.booleanValue !== undefined) return field.booleanValue
  if (field.nullValue !== undefined) return null
  if (field.arrayValue) return (field.arrayValue.values || []).map(v => extractVal(v))
  if (field.mapValue) { const o = {}; for (const [k, v] of Object.entries(field.mapValue.fields || {})) o[k] = extractVal(v); return o }
  return JSON.stringify(field)
}

async function main() {
  const rt = findRefreshToken()
  if (!rt) { console.error('No refresh token. Run: npx firebase login --reauth'); process.exit(1) }
  const at = await getAccessToken(rt)
  if (!at) { console.error('Failed to get access token'); process.exit(1) }

  const DR_ID = 'obOZ4gOAd1BDnyKTqmV4'
  const BOOKING_ID = 'bfIeh09YUOyuU7ZfeNR4'
  const AWB_NORM = '04520348252'

  // 1. Verify doc reception exists and has booking_id = null
  console.log('1. Checking doc reception...')
  const dr = await getDoc(at, `airfreight_doc_receptions/${DR_ID}`)
  if (!dr.fields) { console.error('Doc reception not found!'); process.exit(1) }
  const drBookingId = dr.fields.booking_id?.stringValue || dr.fields.booking_id?.nullValue
  if (dr.fields.booking_id?.stringValue) {
    console.log(`  Already has booking_id: ${dr.fields.booking_id.stringValue}`)
    console.log('  No fix needed — aborting.')
    process.exit(0)
  }
  console.log('  booking_id is null — orphan confirmed.')

  // 2. Verify booking exists and has the AWB line
  console.log('2. Checking booking...')
  const bk = await getDoc(at, `airfreight_bookings/${BOOKING_ID}`)
  if (!bk.fields) { console.error('Booking not found!'); process.exit(1) }
  const flightId = bk.fields.flight_id?.stringValue || null
  const lines = (bk.fields.awb_lines?.arrayValue?.values || []).map(v => {
    const f = v.mapValue?.fields || {}
    return { awb_number: f.awb_number?.stringValue, awb_2nd_leg: f.awb_2nd_leg?.stringValue, warehouse_status: f.warehouse_status?.stringValue }
  })
  const matchIdx = lines.findIndex(l =>
    (l.awb_2nd_leg || '').replace(/[^A-Z0-9]/gi, '').toUpperCase() === AWB_NORM.toUpperCase() ||
    (l.awb_number || '').replace(/[^A-Z0-9]/gi, '').toUpperCase() === AWB_NORM.toUpperCase()
  )
  if (matchIdx < 0) { console.error('AWB line not found in booking!'); process.exit(1) }
  console.log(`  Found AWB at line index ${matchIdx}: ${lines[matchIdx].awb_2nd_leg || lines[matchIdx].awb_number}`)
  console.log(`  Current warehouse_status: ${lines[matchIdx].warehouse_status || 'null'}`)
  console.log(`  flight_id: ${flightId}`)

  // 3. Link doc reception to booking
  console.log('3. Linking doc reception to booking...')
  const patchResult = await patchDoc(at, `airfreight_doc_receptions/${DR_ID}`, {
    booking_id: { stringValue: BOOKING_ID },
    flight_id: flightId ? { stringValue: flightId } : { nullValue: null },
    reconciled_by: { stringValue: 'manual_fix_script' },
    reconciled_at: { stringValue: new Date().toISOString() },
  })
  if (patchResult.error) { console.error('Patch failed:', patchResult.error); process.exit(1) }
  console.log('  Done.')

  // 4. Write warehouse_status = 'D' on the awb_line (only if not already set)
  if (!lines[matchIdx].warehouse_status) {
    console.log('4. Writing warehouse_status = D on awb_line...')
    // Need to rebuild the full awb_lines array with the update
    const fullLines = (bk.fields.awb_lines?.arrayValue?.values || []).map((v, i) => {
      if (i === matchIdx) {
        const fields = { ...v.mapValue.fields }
        fields.warehouse_status = { stringValue: 'D' }
        return { mapValue: { fields } }
      }
      return v
    })
    const patchBk = await patchDoc(at, `airfreight_bookings/${BOOKING_ID}`, {
      awb_lines: { arrayValue: { values: fullLines } },
    })
    if (patchBk.error) { console.error('Booking patch failed:', patchBk.error); process.exit(1) }
    console.log('  Done.')
  } else {
    console.log(`4. warehouse_status already set (${lines[matchIdx].warehouse_status}) — skipping.`)
  }

  console.log('\nFix complete. Doc reception linked to booking, warehouse_status set.')
}

main().catch(e => { console.error('Fatal:', e.message || e); process.exit(1) })
