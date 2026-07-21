// Final state audit — confirm current state of ALL affected entities
const https = require('https')
const path = require('path')
const fs = require('fs')
const PROJECT = 'wms-mcl'
function getToken() {
  const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json')
  try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) }
  catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) }
}
function exchangeToken(rt) {
  return new Promise((resolve, reject) => {
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi`
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) })
    }); req.on('error', reject); req.write(body); req.end()
  })
}
function fsQuery(token, sq) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ structuredQuery: sq })
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`,
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(d) } })
    }); req.on('error', reject); req.write(body); req.end()
  })
}
function getDoc(token, docPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}`,
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(d) } })
    }); req.on('error', reject); req.end()
  })
}
function gf(doc, f) {
  const v = doc.fields?.[f]; if (!v) return null
  if (v.stringValue !== undefined) return v.stringValue
  if (v.integerValue !== undefined) return Number(v.integerValue)
  if (v.doubleValue !== undefined) return Number(v.doubleValue)
  if (v.booleanValue !== undefined) return v.booleanValue
  if (v.timestampValue !== undefined) return v.timestampValue
  return null
}

async function main() {
  const token = await getToken()
  console.log('Token OK\n')

  // ================================================================
  // SECTION 1: All 9 A2 flights — current full state
  // ================================================================
  console.log('=================================================================')
  console.log('SECTION 1: A2 FLIGHTS (ETD > dispatched_at)')
  console.log('=================================================================')
  const a2Flights = [
    { id: '5ulxveZcG4L4ypC00Xyj', label: 'GG-4515' },
    { id: '8HRHMqOuojcAHe0lTJQh', label: 'L7-2539' },
    { id: '9tEknSu4KVLtxTg9KjWQ', label: 'QT-4099' },
    { id: 'DIQjBb82HSFXXAUF8ApQ', label: 'LA-0543 (05-31)' },
    { id: 'T8dkuZVgZfGLKD9YI3ph', label: 'LA-0543 (05-28)' },
    { id: 'eL4mZYUqPfb8PNg28xJN', label: 'K-4865' },
    { id: 'kIELNuhOhvkR2XbpXFO2', label: 'L7-2515' },
    { id: 'naRo2jIuP7tICPb2kKNR', label: 'XL-0317' },
    { id: 'vCKVnszeQ20vMoE3Nj2V', label: 'UC-1711' },
  ]

  for (const af of a2Flights) {
    const f = await getDoc(token, `airfreight_flights/${af.id}`)
    if (f.error) { console.log(`\n  ${af.label} (${af.id}): NOT FOUND`); continue }
    const fn = gf(f, 'flight_number')
    const etd = gf(f, 'flight_datetime')
    const cutoff = gf(f, 'cutoff_datetime')
    const dispAt = gf(f, 'dispatched_at')
    const createdAt = gf(f, 'created_at')
    const createdBy = gf(f, 'created_by')
    const fStatus = gf(f, 'flight_status')
    const status = gf(f, 'status')
    const distUrl = f.fields?.doc_distribucion?.mapValue?.fields?.url?.stringValue || ''
    const distFilename = f.fields?.doc_distribucion?.mapValue?.fields?.filename?.stringValue || ''

    const etdDate = (etd || '').slice(0, 10)
    const dispDate = (dispAt || '').slice(0, 10)
    const gap = etdDate && dispDate ? Math.round((new Date(etdDate) - new Date(dispDate)) / 86400000) : '?'

    console.log(`\n--- ${fn} (${af.id.slice(0,8)}) — gap: ${gap} days ---`)
    console.log(`  ETD: ${etd}`)
    console.log(`  cutoff: ${cutoff}`)
    console.log(`  dispatched_at: ${dispAt}`)
    console.log(`  created: ${createdAt} by ${createdBy}`)
    console.log(`  flight_status: ${fStatus} | status: ${status}`)
    console.log(`  doc_dist filename: ${distFilename}`)
    if (distUrl) console.log(`  doc_dist url date: ${decodeURIComponent(distUrl).match(/\d{4}-\d{2}-\d{2}/)?.[0] || '?'}`)

    // Bookings
    const bRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_bookings' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: af.id } } },
      limit: 10,
    })
    const bDocs = bRes.filter(r => r.document)
    for (const b of bDocs) {
      const bd = b.document
      const bid = bd.name.split('/').pop()
      const lines = bd.fields?.awb_lines?.arrayValue?.values || []
      let disp = 0, notDisp = 0
      const notDispAwbs = []
      for (const l of lines) {
        const m = l.mapValue?.fields
        if (!m) continue
        if (m.dispatched?.booleanValue) disp++
        else { notDisp++; notDispAwbs.push(m.awb_number?.stringValue || '?') }
      }
      console.log(`  Booking ${bid.slice(0,8)}: ${lines.length} lines (${disp} disp, ${notDisp} NOT)`)
      if (notDispAwbs.length > 0) console.log(`    NON-DISPATCHED: ${notDispAwbs.join(', ')}`)
    }
  }

  // ================================================================
  // SECTION 2: All 4 B1 bookings — full AWB detail
  // ================================================================
  console.log('\n\n=================================================================')
  console.log('SECTION 2: B1 BOOKINGS (mixed dispatch state)')
  console.log('=================================================================')
  const b1Bookings = [
    'aQnHwwTuhNBJDDdnI7Q9',  // QT-4099
    'AMwbYZMi7NGOeaPnHyZb',  // LA-0543
    'rNfC76nZKvR5rOfFZc6m',  // UC-1527
    'Utsbc0rkRMbHh0jE2GDs',  // UC-1527 (other)
  ]
  for (const bid of b1Bookings) {
    const b = await getDoc(token, `airfreight_bookings/${bid}`)
    if (b.error) { console.log(`\n  Booking ${bid}: NOT FOUND`); continue }
    const fid = gf(b, 'flight_id')
    const fn = gf(b, 'flight_number')
    const client = gf(b, 'client_name')
    const bType = gf(b, 'booking_type')
    console.log(`\n--- Booking ${bid.slice(0,8)} ---`)
    console.log(`  flight_id: ${fid} | flight_number: ${fn}`)
    console.log(`  client: ${client} | type: ${bType}`)
    const lines = b.fields?.awb_lines?.arrayValue?.values || []
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].mapValue?.fields
      if (!m) continue
      const awb1 = m.awb_number?.stringValue || ''
      const awb2 = m.awb_2nd_leg?.stringValue || ''
      const pcs = m.pieces?.integerValue || m.pieces?.doubleValue || ''
      const cw = m.chargeable_weight?.integerValue || m.chargeable_weight?.doubleValue || ''
      const disp = m.dispatched?.booleanValue
      const dispAt = m.dispatched_at?.stringValue || ''
      const onHand = m.on_hand?.booleanValue
      console.log(`  [${i}] ${awb1} / ${awb2} pcs=${pcs} cw=${cw} disp=${disp} dispAt=${dispAt.slice(0,16)} onHand=${onHand}`)
    }

    // Check billing
    const bcRes = await fsQuery(token, {
      from: [{ collectionId: 'air_billing_charges' }],
      where: { fieldFilter: { field: { fieldPath: 'booking_id' }, op: 'EQUAL', value: { stringValue: bid } } },
      limit: 50,
    })
    const billedAwbs = new Set()
    for (const bc of bcRes.filter(r => r.document)) {
      const cd = bc.document
      billedAwbs.add(gf(cd, 'awb_1st_leg') || '')
    }
    console.log(`  Billing: ${billedAwbs.size} unique AWBs billed: ${[...billedAwbs].join(', ')}`)
  }

  // ================================================================
  // SECTION 3: Cross-check UC-1527 duplicate AWBs
  // ================================================================
  console.log('\n\n=================================================================')
  console.log('SECTION 3: UC-1527 DUPLICATE CHECK')
  console.log('=================================================================')
  const dupeAwbs = ['369-98153473', '369-98154711', '369-99783515']
  for (const awb of dupeAwbs) {
    console.log(`\n  AWB ${awb}:`)
    // Search in all bookings
    const allBRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_bookings' }],
      where: { fieldFilter: { field: { fieldPath: 'awb_numbers_normalized' }, op: 'ARRAY_CONTAINS', value: { stringValue: awb.replace(/-/g, '') } } },
      limit: 10,
    })
    const allBDocs = allBRes.filter(r => r.document)
    for (const b of allBDocs) {
      const bd = b.document
      const bid = bd.name.split('/').pop()
      const fid = gf(bd, 'flight_id')
      const fn = gf(bd, 'flight_number')
      console.log(`    Found in booking ${bid.slice(0,8)} flight=${fn} (${fid?.slice(0,8)})`)
    }
    // Doc receptions
    // Search by 2nd leg (the AWB numbers above are 1st legs, find their 2nd legs)
  }

  // ================================================================
  // SECTION 4: flight_moved alerts — full detail
  // ================================================================
  console.log('\n\n=================================================================')
  console.log('SECTION 4: FLIGHT_MOVED ALERTS (full trace)')
  console.log('=================================================================')
  const movedRes = await fsQuery(token, {
    from: [{ collectionId: '_sheet_sync_alerts' }],
    where: { fieldFilter: { field: { fieldPath: 'alert_type' }, op: 'EQUAL', value: { stringValue: 'flight_moved' } } },
    orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'ASCENDING' }],
    limit: 50,
  })
  for (const a of movedRes.filter(r => r.document)) {
    const d = a.document
    const awb1 = gf(d, 'awb_1st') || ''
    const awb2 = gf(d, 'awb_2nd') || ''
    const fn = gf(d, 'flight_number') || ''
    const sf = gf(d, 'system_flight') || ''
    const msg = gf(d, 'message') || ''
    const etd = gf(d, 'etd') || ''
    const created = gf(d, 'created_at') || ''
    const diffsField = d.fields?.diffs?.arrayValue?.values || []
    const diffsStr = diffsField.map(v => {
      const m = v.mapValue?.fields
      if (!m) return '?'
      return `${m.field?.stringValue}: ${m.old_value?.stringValue} -> ${m.new_value?.stringValue}`
    }).join(' | ')
    console.log(`\n  ${created}`)
    console.log(`    AWB: ${awb1} / ${awb2}`)
    console.log(`    ${sf} -> ${fn} (ETD: ${etd})`)
    console.log(`    msg: ${msg}`)
    console.log(`    diffs: ${diffsStr}`)
  }
}

main().catch(console.error)
