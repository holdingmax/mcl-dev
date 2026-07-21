// Diagnose missing billing: check if flights, bookings, doc_receptions exist for "Sin Billing" AWBs
// READ-ONLY — no modifications

const { execSync } = require('child_process')
const https = require('https')
const path = require('path')
const fs = require('fs')

const PROJECT = 'wms-mcl'

function getToken() {
  // Try firebase CLI config
  const configPaths = [
    path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'),
    path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json'),
    path.join(process.env.APPDATA || '', 'firebase-tools.json'),
  ]
  for (const p of configPaths) {
    try {
      const config = JSON.parse(fs.readFileSync(p, 'utf8'))
      const refreshToken = config.tokens?.refresh_token
      if (refreshToken) return exchangeToken(refreshToken)
    } catch {}
  }
  throw new Error('No firebase token found')
}

function exchangeToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi`
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

function firestoreQuery(token, structuredQuery) {
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
  if (f.stringValue !== undefined) return f.stringValue
  if (f.integerValue !== undefined) return Number(f.integerValue)
  if (f.doubleValue !== undefined) return Number(f.doubleValue)
  if (f.booleanValue !== undefined) return f.booleanValue
  if (f.timestampValue !== undefined) return f.timestampValue
  if (f.nullValue !== undefined) return null
  return null
}

function getArrayField(doc, field) {
  const f = doc.fields?.[field]
  if (!f || !f.arrayValue) return []
  return (f.arrayValue.values || []).map(v => v.mapValue || v)
}

function getMapField(mv, field) {
  const f = mv?.fields?.[field]
  if (!f) return null
  if (f.stringValue !== undefined) return f.stringValue
  if (f.integerValue !== undefined) return Number(f.integerValue)
  if (f.doubleValue !== undefined) return Number(f.doubleValue)
  return null
}

// AWBs from the Cross Check "Sin Billing" screenshot
const MISSING_AWBS = [
  { flight: 'LA-0543', awb1st: '369-99782605', awb2nd: '045-22209353', etd: '2026-05-17', pcs: 142, cw: 3060, uld: 'BUP' },
  { flight: 'LA-0543', awb1st: '369-99782841', awb2nd: '045-22209843', etd: '2026-05-17', pcs: 98, cw: 1960, uld: 'BUP' },
  { flight: 'UC-1527', awb1st: '369-99783515', awb2nd: '045-22210602', etd: '2026-05-25', pcs: 84, cw: 3060, uld: 'LOOSE' },
  { flight: 'UC-1527', awb1st: '369-98153473', awb2nd: '045-22210053', etd: '2026-05-25', pcs: 138, cw: 2992, uld: 'LOOSE' },
  { flight: 'UC-1527', awb1st: '369-98154711', awb2nd: '045-22210064', etd: '2026-05-25', pcs: 90, cw: 1960, uld: 'LOOSE' },
  { flight: 'LA-0543', awb1st: '369-99362174', awb2nd: '045-22209390', etd: '2026-05-25', pcs: 93, cw: 3060, uld: 'LOOSE' },
  { flight: 'LA-0543', awb1st: '369-99362185', awb2nd: '045-22210075', etd: '2026-05-25', pcs: 85, cw: 3060, uld: 'LOOSE' },
  { flight: 'UC-1731', awb1st: '057-58867896', awb2nd: '045-22209434', etd: '2026-05-26', pcs: 65, cw: 1600, uld: 'LOOSE' },
]

async function main() {
  const token = await getToken()
  console.log('Token OK\n')

  const norm = s => (s || '').replace(/[-\s]/g, '').toUpperCase()

  // Group by flight+etd
  const flightGroups = new Map()
  for (const awb of MISSING_AWBS) {
    const key = `${awb.flight}|${awb.etd}`
    if (!flightGroups.has(key)) flightGroups.set(key, [])
    flightGroups.get(key).push(awb)
  }

  for (const [key, awbs] of flightGroups) {
    const [flightNum, etd] = key.split('|')
    console.log(`\n${'='.repeat(70)}`)
    console.log(`FLIGHT: ${flightNum}  |  ETD: ${etd}  |  ${awbs.length} missing AWBs`)
    console.log('='.repeat(70))

    // 1. Find flight document(s) matching flight_number
    const flightRes = await firestoreQuery(token, {
      from: [{ collectionId: 'airfreight_flights' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: flightNum } } },
      limit: 20,
    })
    const flightDocs = flightRes.filter(r => r.document)

    console.log(`\n  [1] FLIGHTS in Firestore with number ${flightNum}: ${flightDocs.length}`)
    let matchedFlight = null
    for (const fd of flightDocs) {
      const d = fd.document
      const fId = d.name.split('/').pop()
      const fEtd = getField(d, 'flight_datetime') || ''
      const fStatus = getField(d, 'flight_status') || ''
      const dispatched = getField(d, 'dispatched_at') || ''
      const etdDate = fEtd.slice(0, 10)
      const match = etdDate === etd ? ' ← MATCH' : ''
      console.log(`      id=${fId}  etd=${fEtd}  status=${fStatus}  dispatched=${dispatched || 'NO'}${match}`)
      if (etdDate === etd) matchedFlight = d
    }

    if (!matchedFlight) {
      console.log(`  ⚠ NO FLIGHT FOUND for ETD ${etd}`)
      // Try broader search
      console.log(`  Trying broader ETD range...`)
      const flightRes2 = await firestoreQuery(token, {
        from: [{ collectionId: 'airfreight_flights' }],
        where: { compositeFilter: { op: 'AND', filters: [
          { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: flightNum } } },
        ]}},
        limit: 50,
      })
      const allFlights = flightRes2.filter(r => r.document)
      for (const fd of allFlights) {
        const d = fd.document
        const fId = d.name.split('/').pop()
        const fEtd = getField(d, 'flight_datetime') || ''
        console.log(`      id=${fId}  etd=${fEtd}`)
      }
    }

    const flightId = matchedFlight ? matchedFlight.name.split('/').pop() : null

    // 2. Check bookings
    console.log(`\n  [2] BOOKINGS`)
    if (flightId) {
      const bookRes = await firestoreQuery(token, {
        from: [{ collectionId: 'airfreight_bookings' }],
        where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: flightId } } },
        limit: 50,
      })
      const bookDocs = bookRes.filter(r => r.document)
      console.log(`      ${bookDocs.length} booking(s) for flight ${flightId}`)

      for (const bd of bookDocs) {
        const d = bd.document
        const bId = d.name.split('/').pop()
        const bType = getField(d, 'booking_type')
        const clientName = getField(d, 'client_name')
        console.log(`      Booking ${bId} (${bType}) - ${clientName}`)

        if (bType === 'simple') {
          const a1 = getField(d, 'awb_1st_leg') || ''
          const a2 = getField(d, 'awb_2nd_leg') || ''
          console.log(`        awb_1st=${a1}  awb_2nd=${a2}`)
        } else {
          const lines = getArrayField(d, 'awb_lines')
          for (const line of lines) {
            const a1 = getMapField(line, 'awb_number') || ''
            const a2 = getMapField(line, 'awb_2nd_leg') || ''
            const pcs = getMapField(line, 'pieces') || 0
            const w = getMapField(line, 'weight') || 0
            console.log(`        1st=${a1}  2nd=${a2}  pcs=${pcs}  w=${w}`)
          }
        }
      }

      // Check which missing AWBs are in bookings
      const bookingAwbs = new Set()
      for (const bd of bookDocs) {
        const d = bd.document
        const bType = getField(d, 'booking_type')
        if (bType === 'simple') {
          bookingAwbs.add(norm(getField(d, 'awb_1st_leg') || ''))
          bookingAwbs.add(norm(getField(d, 'awb_2nd_leg') || ''))
        } else {
          for (const line of getArrayField(d, 'awb_lines')) {
            bookingAwbs.add(norm(getMapField(line, 'awb_number') || ''))
            bookingAwbs.add(norm(getMapField(line, 'awb_2nd_leg') || ''))
          }
        }
      }
      console.log(`\n      Missing AWBs in bookings:`)
      for (const awb of awbs) {
        const found1 = bookingAwbs.has(norm(awb.awb1st))
        const found2 = bookingAwbs.has(norm(awb.awb2nd))
        console.log(`        ${awb.awb2nd}: 1st=${found1 ? 'YES' : 'NO'}  2nd=${found2 ? 'YES' : 'NO'}`)
      }
    } else {
      console.log(`      Cannot check — no flight document found`)
    }

    // 3. Check doc_receptions
    console.log(`\n  [3] DOC RECEPTIONS`)
    if (flightId) {
      const drRes = await firestoreQuery(token, {
        from: [{ collectionId: 'airfreight_doc_receptions' }],
        where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: flightId } } },
        limit: 100,
      })
      const drDocs = drRes.filter(r => r.document)
      console.log(`      ${drDocs.length} doc_reception(s) for flight ${flightId}`)

      const drAwbs = new Set()
      for (const drd of drDocs) {
        const d = drd.document
        const awb = getField(d, 'awb_number') || ''
        const status = getField(d, 'status') || ''
        drAwbs.add(norm(awb))
        console.log(`        awb=${awb}  status=${status}`)
      }

      console.log(`\n      Missing AWBs in doc_receptions:`)
      for (const awb of awbs) {
        const found = drAwbs.has(norm(awb.awb2nd))
        console.log(`        ${awb.awb2nd}: ${found ? 'YES' : 'NO'}`)
      }
    } else {
      console.log(`      Cannot check — no flight document found`)
    }

    // 4. Check billing charges
    console.log(`\n  [4] BILLING CHARGES`)
    for (const awb of awbs) {
      const chargeRes = await firestoreQuery(token, {
        from: [{ collectionId: 'air_billing_charges' }],
        where: { fieldFilter: { field: { fieldPath: 'awb_2nd_leg' }, op: 'EQUAL', value: { stringValue: awb.awb2nd } } },
        limit: 5,
      })
      const chargeDocs = chargeRes.filter(r => r.document)
      if (chargeDocs.length === 0) {
        console.log(`      ${awb.awb2nd}: NO charges`)
      } else {
        for (const cd of chargeDocs) {
          const d = cd.document
          const status = getField(d, 'status') || ''
          const invoiceId = getField(d, 'invoice_id') || ''
          const flight = getField(d, 'flight_number') || ''
          console.log(`      ${awb.awb2nd}: status=${status}  invoice=${invoiceId}  flight=${flight}`)
        }
      }
    }

    // 5. Check deletion audit log
    console.log(`\n  [5] DELETION AUDIT LOG`)
    if (flightId) {
      const auditRes = await firestoreQuery(token, {
        from: [{ collectionId: '_deletion_audit_log' }],
        where: { compositeFilter: { op: 'AND', filters: [
          { fieldFilter: { field: { fieldPath: 'collection' }, op: 'IN', value: { arrayValue: { values: [
            { stringValue: 'airfreight_bookings' },
            { stringValue: 'airfreight_doc_receptions' },
            { stringValue: 'air_billing_charges' },
          ]}}}},
        ]}},
        orderBy: [{ field: { fieldPath: 'deleted_at' }, direction: 'DESCENDING' }],
        limit: 50,
      })
      const auditDocs = auditRes.filter(r => r.document)

      // Filter audit entries related to this flight
      let found = 0
      for (const ad of auditDocs) {
        const d = ad.document
        const col = getField(d, 'collection') || ''
        const docData = d.fields?.document_data?.mapValue?.fields || {}
        const fid = docData.flight_id?.stringValue || ''
        if (fid === flightId) {
          found++
          const deletedAt = getField(d, 'deleted_at') || ''
          const docId = getField(d, 'document_id') || ''
          const awbNum = docData.awb_number?.stringValue || docData.awb_2nd_leg?.stringValue || ''
          console.log(`      DELETED: ${col} id=${docId} awb=${awbNum} at=${deletedAt}`)
        }
      }
      if (found === 0) console.log(`      No deletion records found for this flight`)
    }
  }

  console.log(`\n\n${'='.repeat(70)}`)
  console.log('DIAGNOSIS COMPLETE — READ ONLY, NO CHANGES MADE')
  console.log('='.repeat(70))
}

main().catch(console.error)
