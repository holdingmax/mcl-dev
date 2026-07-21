// Verify original ETD of LA-0543 (DIQjBb82) — gather all evidence
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

  // 1. Full flight document
  console.log('=== 1. FLIGHT DOCUMENT (DIQjBb82HSFXXAUF8ApQ) ===')
  const flight = await getDoc(token, 'airfreight_flights/DIQjBb82HSFXXAUF8ApQ')
  if (flight.fields) {
    for (const [k, v] of Object.entries(flight.fields)) {
      let val
      if (v.stringValue !== undefined) val = v.stringValue
      else if (v.integerValue !== undefined) val = v.integerValue
      else if (v.doubleValue !== undefined) val = v.doubleValue
      else if (v.booleanValue !== undefined) val = v.booleanValue
      else if (v.timestampValue !== undefined) val = v.timestampValue
      else if (v.mapValue) val = JSON.stringify(v.mapValue.fields ? Object.keys(v.mapValue.fields) : v.mapValue).slice(0, 300)
      else if (v.arrayValue) val = JSON.stringify(v.arrayValue).slice(0, 200)
      else val = JSON.stringify(v).slice(0, 200)
      console.log(`  ${k}: ${val}`)
    }
  }

  // 2. doc_distribucion URL — often contains the date in the filename
  const distUrl = flight.fields?.doc_distribucion?.mapValue?.fields?.url?.stringValue
  if (distUrl) {
    console.log('\n=== 2. DOC_DISTRIBUCION URL (date in filename?) ===')
    console.log(`  ${decodeURIComponent(distUrl).slice(0, 300)}`)
  }

  // 3. Booking on this flight
  console.log('\n=== 3. BOOKINGS ON THIS FLIGHT ===')
  const bRes = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_bookings' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: 'DIQjBb82HSFXXAUF8ApQ' } } },
    limit: 10,
  })
  const bDocs = bRes.filter(r => r.document)
  for (const b of bDocs) {
    const bd = b.document
    const bid = bd.name.split('/').pop()
    console.log(`\n  Booking ${bid}:`)
    console.log(`    created_at: ${gf(bd, 'created_at')}`)
    console.log(`    client_name: ${gf(bd, 'client_name')}`)
    console.log(`    status: ${gf(bd, 'status')}`)
    const lines = bd.fields?.awb_lines?.arrayValue?.values || []
    console.log(`    awb_lines: ${lines.length}`)
    for (const l of lines) {
      const m = l.mapValue?.fields
      if (!m) continue
      const awb1 = m.awb_number?.stringValue || ''
      const awb2 = m.awb_2nd_leg?.stringValue || ''
      const disp = m.dispatched?.booleanValue
      const dispAt = m.dispatched_at?.stringValue || m.dispatched_at?.timestampValue || ''
      const onHand = m.on_hand?.booleanValue
      const dropOff = m.drop_off_time?.stringValue || ''
      console.log(`      ${awb1} / ${awb2} disp=${disp} dispAt=${dispAt} onHand=${onHand} dropOff=${dropOff ? dropOff.slice(0,16) : '-'}`)
    }
  }

  // 4. Doc receptions on this booking
  console.log('\n=== 4. DOC RECEPTIONS ===')
  for (const b of bDocs) {
    const bid = b.document.name.split('/').pop()
    const drRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_doc_receptions' }],
      where: { fieldFilter: { field: { fieldPath: 'booking_id' }, op: 'EQUAL', value: { stringValue: bid } } },
      limit: 20,
    })
    const drDocs = drRes.filter(r => r.document)
    console.log(`  For booking ${bid}: ${drDocs.length} doc_receptions`)
    for (const dr of drDocs) {
      const dd = dr.document
      const drid = dd.name.split('/').pop()
      console.log(`    DR ${drid}:`)
      console.log(`      awb_number: ${gf(dd, 'awb_number')}`)
      console.log(`      status: ${gf(dd, 'status')}`)
      console.log(`      created_at: ${gf(dd, 'created_at')}`)
      console.log(`      flight_id: ${gf(dd, 'flight_id')}`)
      console.log(`      flight_number: ${gf(dd, 'flight_number')}`)
    }
  }

  // 5. Billing charges
  console.log('\n=== 5. BILLING CHARGES ===')
  for (const b of bDocs) {
    const bid = b.document.name.split('/').pop()
    const bcRes = await fsQuery(token, {
      from: [{ collectionId: 'air_billing_charges' }],
      where: { fieldFilter: { field: { fieldPath: 'booking_id' }, op: 'EQUAL', value: { stringValue: bid } } },
      limit: 20,
    })
    const bcDocs = bcRes.filter(r => r.document)
    console.log(`  For booking ${bid}: ${bcDocs.length} charges`)
    for (const bc of bcDocs) {
      const cd = bc.document
      const awb1 = gf(cd, 'awb_1st_leg') || gf(cd, 'awb_number') || ''
      const awb2 = gf(cd, 'awb_2nd_leg') || ''
      const total = gf(cd, 'total')
      const status = gf(cd, 'status')
      const dispAt = gf(cd, 'dispatched_at')
      console.log(`    ${awb1}/${awb2} total=$${total} status=${status} dispAt=${dispAt}`)
    }
  }

  // 6. Physical pieces on this flight
  console.log('\n=== 6. PHYSICAL PIECES ===')
  const ppRes = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_physical_pieces' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: 'DIQjBb82HSFXXAUF8ApQ' } } },
    limit: 50,
  })
  const ppDocs = ppRes.filter(r => r.document)
  console.log(`  Total physical pieces: ${ppDocs.length}`)

  // 7. Buildup ULDs on this flight
  console.log('\n=== 7. BUILDUP ULDs ===')
  const uldRes = await fsQuery(token, {
    from: [{ collectionId: 'buildup_ulds' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: 'DIQjBb82HSFXXAUF8ApQ' } } },
    limit: 50,
  })
  const uldDocs = uldRes.filter(r => r.document)
  console.log(`  Total ULDs: ${uldDocs.length}`)
  for (const u of uldDocs) {
    const ud = u.document
    const uid = ud.name.split('/').pop()
    const uldNum = gf(ud, 'uld_number') || ''
    const status = gf(ud, 'status') || ''
    console.log(`    ${uldNum} status=${status} (${uid.slice(0,8)})`)
  }

  // 8. ALL LA-0543 flights near this date range — to help identify original ETD
  console.log('\n=== 8. ALL LA-0543 FLIGHTS (for date context) ===')
  const allLA = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_flights' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: 'LA-0543' } } },
    limit: 50,
  })
  const laFlights = allLA.filter(r => r.document)
  // Sort by ETD
  const sorted = laFlights.map(f => ({
    id: f.document.name.split('/').pop(),
    etd: gf(f.document, 'flight_datetime') || '',
    dispAt: gf(f.document, 'dispatched_at') || '',
    createdAt: gf(f.document, 'created_at') || '',
    createdBy: gf(f.document, 'created_by') || '',
  })).sort((a, b) => a.etd.localeCompare(b.etd))

  for (const f of sorted) {
    const gap = f.dispAt && f.etd ? '' : ''
    console.log(`  ${f.etd.slice(0,10)} | ${f.id.slice(0,8)} | disp=${f.dispAt.slice(0,10)} | created=${f.createdAt.slice(0,10)} by=${f.createdBy}`)
  }
  // Highlight gaps — dates without a flight
  const etdDates = sorted.map(f => f.etd.slice(0, 10)).filter(Boolean)
  console.log(`\n  LA-0543 dates covered: ${etdDates.join(', ')}`)
  // Check May dates to find gaps
  const mayDates = []
  for (let d = 1; d <= 31; d++) {
    const ds = `2026-05-${String(d).padStart(2, '0')}`
    if (!etdDates.includes(ds)) mayDates.push(ds)
  }
  console.log(`  May dates WITHOUT LA-0543: ${mayDates.join(', ')}`)
}

main().catch(console.error)
