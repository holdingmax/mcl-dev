// Test: compare doc_receptions vs bookings for a flight with DIST green
// Flight UC-1731 (Built, DIST green)

const https = require('https')
const fs = require('fs')
const path = require('path')

const PROJECT = 'wms-mcl'

function getRefreshToken() {
  const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json')
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token }
  catch { return JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token }
}

function refreshAccessToken() {
  return new Promise((resolve, reject) => {
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(getRefreshToken())}&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi`
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d)
      })
    })
    req.on('error', reject); req.write(body); req.end()
  })
}

function firestoreQuery(token, collectionId, structuredQuery) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ structuredQuery })
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(d) }
      })
    })
    req.on('error', reject); req.write(body); req.end()
  })
}

function getField(doc, field) {
  const f = doc.fields?.[field]
  if (!f) return null
  return f.stringValue || f.integerValue || f.doubleValue || f.booleanValue || null
}

function getArrayField(doc, field) {
  const f = doc.fields?.[field]
  if (!f || !f.arrayValue) return []
  return (f.arrayValue.values || []).map(v => v.mapValue || v)
}

async function main() {
  const token = await refreshAccessToken()
  console.log('Token OK\n')

  // Step 1: Find the flight UC-1731
  console.log('=== Finding flight UC-1731 ===')
  const flightRes = await firestoreQuery(token, 'airfreight_flights', {
    from: [{ collectionId: 'airfreight_flights' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'flight_number' },
        op: 'EQUAL',
        value: { stringValue: 'UC-1731' },
      },
    },
    limit: 5,
  })

  const flightDocs = flightRes.filter(r => r.document)
  if (flightDocs.length === 0) { console.log('Flight not found!'); return }

  const flight = flightDocs[0].document
  const flightId = flight.name.split('/').pop()
  console.log('Flight ID:', flightId)
  console.log('Airline:', getField(flight, 'airline'))
  console.log('Flight #:', getField(flight, 'flight_number'))
  console.log('')

  // Step 2: Get bookings for this flight
  console.log('=== Bookings for this flight ===')
  const bookRes = await firestoreQuery(token, 'airfreight_bookings', {
    from: [{ collectionId: 'airfreight_bookings' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'flight_id' },
        op: 'EQUAL',
        value: { stringValue: flightId },
      },
    },
    limit: 50,
  })

  const bookingDocs = bookRes.filter(r => r.document)
  console.log(`Found ${bookingDocs.length} booking(s)\n`)

  const bookingAwbs = []
  for (const bd of bookingDocs) {
    const d = bd.document
    const bookingId = d.name.split('/').pop()
    const bookingType = getField(d, 'booking_type')
    console.log(`  Booking: ${bookingId} (type: ${bookingType})`)

    if (bookingType === 'simple') {
      const awb = getField(d, 'awb_number') || ''
      console.log(`    awb_number: ${awb}`)
      bookingAwbs.push({ awb_number: awb, awb_2nd_leg: '' })
    } else {
      const lines = getArrayField(d, 'awb_lines')
      for (const line of lines) {
        const fields = line.fields || {}
        const awb = fields.awb_number?.stringValue || ''
        const leg2 = fields.awb_2nd_leg?.stringValue || ''
        console.log(`    awb_number: ${awb}  |  awb_2nd_leg: ${leg2}`)
        bookingAwbs.push({ awb_number: awb, awb_2nd_leg: leg2 })
      }
    }
  }
  console.log('')

  // Step 3: Get doc_receptions for this flight
  console.log('=== Doc Receptions for this flight ===')
  const drRes = await firestoreQuery(token, 'airfreight_doc_receptions', {
    from: [{ collectionId: 'airfreight_doc_receptions' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'flight_id' },
        op: 'EQUAL',
        value: { stringValue: flightId },
      },
    },
    limit: 100,
  })

  const drDocs = drRes.filter(r => r.document)
  console.log(`Found ${drDocs.length} doc_reception(s)\n`)

  const distAwbs = []
  for (const drd of drDocs) {
    const d = drd.document
    const drId = d.name.split('/').pop()
    const awb = getField(d, 'awb_number') || ''
    const leg2 = getField(d, 'awb_2nd_leg') || ''
    const status = getField(d, 'status') || ''
    console.log(`  DR: ${drId}`)
    console.log(`    awb_number: ${awb}  |  awb_2nd_leg: ${leg2}  |  status: ${status}`)
    distAwbs.push({ awb_number: awb, awb_2nd_leg: leg2 })
  }
  console.log('')

  // Step 4: Run matching logic
  console.log('=== MATCH COMPARISON ===\n')

  function normalize(s) { return (s || '').replace(/[-\s]/g, '').trim() }

  // Booking sets
  const bookingMawbs = new Set(bookingAwbs.map(a => normalize(a.awb_number)).filter(Boolean))
  const booking2nds = new Set(bookingAwbs.map(a => normalize(a.awb_2nd_leg)).filter(Boolean))

  console.log('Booking MAWB set:', [...bookingMawbs])
  console.log('Booking 2nd leg set:', [...booking2nds])
  console.log('')

  // Check dist → booking
  let allMatch = true
  console.log('--- Dist → Booking match ---')
  for (const d of distAwbs) {
    const raw = d.awb_number || ''
    const norm = normalize(raw)
    const leg2norm = normalize(d.awb_2nd_leg)

    let matched = false
    let matchedBy = ''

    if (raw.includes('-')) {
      // Has hyphen → compare with booking MAWB
      if (bookingMawbs.has(norm)) { matched = true; matchedBy = 'MAWB' }
    } else {
      // No hyphen → compare with booking 2nd leg
      if (booking2nds.has(norm)) { matched = true; matchedBy = '2nd leg (by awb_number)' }
    }

    // Also try matching by awb_2nd_leg
    if (!matched && leg2norm && booking2nds.has(leg2norm)) {
      matched = true; matchedBy = '2nd leg (by awb_2nd_leg)'
    }
    if (!matched && norm && bookingMawbs.has(norm)) {
      matched = true; matchedBy = 'MAWB (fallback)'
    }

    console.log(`  ${raw} → ${matched ? 'MATCH' : 'NO MATCH'} ${matchedBy ? '('+matchedBy+')' : ''}`)
    if (!matched) allMatch = false
  }

  console.log('')
  console.log('--- Booking → Dist match ---')
  // Dist sets
  const distNorms = new Set(distAwbs.map(d => normalize(d.awb_number)).filter(Boolean))
  const dist2nds = new Set(distAwbs.map(d => normalize(d.awb_2nd_leg)).filter(Boolean))

  for (const b of bookingAwbs) {
    const bMawb = normalize(b.awb_number)
    const b2nd = normalize(b.awb_2nd_leg)
    const foundByMawb = distNorms.has(bMawb)
    const foundBy2nd = dist2nds.has(b2nd) || distNorms.has(b2nd)
    const matched = foundByMawb || foundBy2nd
    console.log(`  ${b.awb_number} / ${b.awb_2nd_leg} → ${matched ? 'MATCH' : 'NO MATCH'}`)
    if (!matched) allMatch = false
  }

  console.log('')
  console.log('=============================')
  console.log(`RESULT: ${allMatch ? 'CHECK (green)' : 'WARNING (yellow)'}`)
  console.log('=============================')
}

main().catch(console.error)
