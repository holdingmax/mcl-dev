// Fix v2: Correct warehouse_status to 'R' + on_hand + weight for AWB 045-20348252
// The doc reception is already linked (v1 fix), but status was wrong ('D' instead of 'R')
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

function extractVal(field) {
  if (!field) return null
  if (field.stringValue !== undefined) return field.stringValue
  if (field.integerValue !== undefined) return Number(field.integerValue)
  if (field.doubleValue !== undefined) return field.doubleValue
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

  const DR_ID = 'obOZ4gOAd1BDnyKTqmV4'
  const BOOKING_ID = 'bfIeh09YUOyuU7ZfeNR4'
  const AWB_NORM = '04520348252'

  // 1. Get doc reception to check status and weight
  console.log('1. Reading doc reception...')
  const dr = await getDoc(at, `airfreight_doc_receptions/${DR_ID}`)
  if (!dr.fields) { console.error('DR not found!'); process.exit(1) }
  const drStatus = extractVal(dr.fields.status)
  const drWeight = extractVal(dr.fields.weight)
  console.log(`  status: ${drStatus}`)
  console.log(`  weight: ${drWeight}`)
  console.log(`  booking_id: ${extractVal(dr.fields.booking_id)}`)

  // 2. Get booking and find AWB line
  console.log('\n2. Reading booking...')
  const bk = await getDoc(at, `airfreight_bookings/${BOOKING_ID}`)
  if (!bk.fields) { console.error('Booking not found!'); process.exit(1) }
  const linesRaw = bk.fields.awb_lines?.arrayValue?.values || []

  const matchIdx = linesRaw.findIndex(v => {
    const f = v.mapValue?.fields || {}
    const n1 = (extractVal(f.awb_2nd_leg) || '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
    const n2 = (extractVal(f.awb_number) || '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
    return n1 === AWB_NORM.toUpperCase() || n2 === AWB_NORM.toUpperCase()
  })
  if (matchIdx < 0) { console.error('AWB line not found!'); process.exit(1) }

  const lineFields = linesRaw[matchIdx].mapValue.fields
  const currentWS = extractVal(lineFields.warehouse_status)
  const currentWeight = extractVal(lineFields.weight)
  const currentOnHand = extractVal(lineFields.on_hand)
  console.log(`  AWB line index: ${matchIdx}`)
  console.log(`  Current warehouse_status: ${currentWS}`)
  console.log(`  Current weight: ${currentWeight}`)
  console.log(`  Current on_hand: ${currentOnHand}`)

  // 3. Determine correct status
  const isPhysicalComplete = drStatus === 'complete'
  const targetStatus = isPhysicalComplete ? 'R' : 'D'
  console.log(`\n3. Target warehouse_status: ${targetStatus} (DR status=${drStatus})`)

  // 4. Update booking awb_line
  if (currentWS === targetStatus && currentWeight === drWeight && currentOnHand === true) {
    console.log('  Already correct — no update needed.')
    process.exit(0)
  }

  console.log('4. Updating booking awb_line...')
  const updatedLines = linesRaw.map((v, i) => {
    if (i !== matchIdx) return v
    const fields = { ...v.mapValue.fields }
    fields.warehouse_status = { stringValue: targetStatus }
    if (isPhysicalComplete) {
      fields.on_hand = { booleanValue: true }
    }
    if (drWeight > 0 && (!currentWeight || currentWeight === 0)) {
      fields.weight = { doubleValue: drWeight }
    }
    return { mapValue: { fields } }
  })

  const patchResult = await patchDoc(at, `airfreight_bookings/${BOOKING_ID}`, {
    awb_lines: { arrayValue: { values: updatedLines } },
  })
  if (patchResult.error) { console.error('Patch failed:', patchResult.error); process.exit(1) }

  // Verify
  const verify = patchResult.fields?.awb_lines?.arrayValue?.values?.[matchIdx]?.mapValue?.fields
  console.log(`  Updated warehouse_status: ${extractVal(verify?.warehouse_status)}`)
  console.log(`  Updated on_hand: ${extractVal(verify?.on_hand)}`)
  console.log(`  Updated weight: ${extractVal(verify?.weight)}`)

  console.log('\nDone.')
}

main().catch(e => { console.error('Fatal:', e.message || e); process.exit(1) })
