// Check LA-0543 (DIQjBb82) and LA-0543 (AMwbYZMi booking) — potential 3rd case
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

  // LA-0543 (DIQjBb82) — dispatched 05-07 but ETD 05-31
  console.log('=== LA-0543 DIQjBb82 — ETD anomaly ===')
  const f1 = await getDoc(token, 'airfreight_flights/DIQjBb82KfRFB4CjBZOh')
  if (f1.fields) {
    console.log(`  flight_number: ${gf(f1, 'flight_number')}`)
    console.log(`  flight_datetime: ${gf(f1, 'flight_datetime')}`)
    console.log(`  dispatched_at: ${gf(f1, 'dispatched_at')}`)
    console.log(`  created_at: ${gf(f1, 'created_at')}`)
    console.log(`  created_by: ${gf(f1, 'created_by')}`)
  } else {
    console.log('  Not found (might be partial ID)')
  }

  // Booking AMwbYZMi — mixed dispatch
  console.log('\n=== Booking AMwbYZMi (LA-0543 mixed) ===')
  const b1 = await getDoc(token, 'airfreight_bookings/AMwbYZMi0ooNxvZw0VHi')
  if (b1.error) {
    // Try the full audit output ID
    console.log('  Trying alternative...')
  }
  // Search bookings on the 2 suspicious LA-0543 flights
  const laFlights = ['DIQjBb82', 'T8dkuZVg']
  for (const fid of laFlights) {
    const bRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_bookings' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: fid } } },
      limit: 10,
    })
    const bDocs = bRes.filter(r => r.document)
    for (const b of bDocs) {
      const bd = b.document
      const bid = bd.name.split('/').pop()
      const lines = bd.fields?.awb_lines?.arrayValue?.values || []
      let disp = 0, notDisp = 0
      console.log(`\n  Booking ${bid} on flight ${fid}:`)
      console.log(`    Lines: ${lines.length}`)
      for (const l of lines) {
        const m = l.mapValue?.fields
        if (!m) continue
        const awb1 = m.awb_number?.stringValue || ''
        const d = m.dispatched?.booleanValue
        if (d) disp++; else notDisp++
        console.log(`    ${awb1} dispatched=${d}`)
      }
      console.log(`    Summary: ${disp} dispatched, ${notDisp} NOT dispatched`)
    }
  }

  // UC-1527 Utsbc0rk — check the 3 non-dispatched (is this the same Case 1 we fixed?)
  console.log('\n=== UC-1527 booking Utsbc0rk — is this our Case 1? ===')
  const b2Res = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_bookings' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: 'clFtNKunwg2MMZLKRIRs' } } },
    limit: 10,
  })
  const b2Docs = b2Res.filter(r => r.document)
  for (const b of b2Docs) {
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
    console.log(`  Booking ${bid}: ${lines.length} lines, ${disp} dispatched, ${notDisp} NOT`)
    if (notDispAwbs.length) console.log(`    Non-dispatched: ${notDispAwbs.join(', ')}`)
  }

  // Check the LA-0543 booking AMwbYZMi specifically
  console.log('\n=== Search booking AMwbYZMi ===')
  // It might be linked to a different flight — search all LA-0543 bookings
  const allLA = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_bookings' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: 'LA-0543' } } },
    limit: 50,
  })
  const laBookings = allLA.filter(r => r.document)
  for (const b of laBookings) {
    const bd = b.document
    const bid = bd.name.split('/').pop()
    if (!bid.startsWith('AMwbYZMi')) continue
    const fid = gf(bd, 'flight_id')
    const lines = bd.fields?.awb_lines?.arrayValue?.values || []
    let disp = 0, notDisp = 0
    const notDispAwbs = []
    for (const l of lines) {
      const m = l.mapValue?.fields
      if (!m) continue
      if (m.dispatched?.booleanValue) disp++
      else { notDisp++; notDispAwbs.push(m.awb_number?.stringValue || '?') }
    }
    console.log(`  ${bid} flight_id=${fid}: ${lines.length} lines, ${disp} disp, ${notDisp} NOT`)
    if (notDispAwbs.length) console.log(`    Non-dispatched: ${notDispAwbs.join(', ')}`)
  }
}

main().catch(console.error)
