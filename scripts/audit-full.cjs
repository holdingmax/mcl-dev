// FULL AUDIT: Detect all flights/bookings affected by the status vs flight_status bug
// READ ONLY — no modifications
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
  const today = new Date().toISOString().slice(0, 10)

  // ================================================================
  // AUDIT A: Flight-level anomalies
  // ================================================================
  console.log('================================================================')
  console.log('AUDIT A: FLIGHT-LEVEL ANOMALIES')
  console.log('================================================================')

  // A1: ALL dispatched flights (flight_status=dispatched) — check status field
  console.log('\n--- A1: flight_status=dispatched but status!=dispatched ---')
  const dispFlights = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_flights' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_status' }, op: 'EQUAL', value: { stringValue: 'dispatched' } } },
    limit: 200,
  })
  const dispDocs = dispFlights.filter(r => r.document)
  let a1Count = 0
  const allDispatchedFlights = []
  for (const f of dispDocs) {
    const d = f.document
    const id = d.name.split('/').pop()
    const status = gf(d, 'status')
    const flightStatus = gf(d, 'flight_status')
    const fn = gf(d, 'flight_number')
    const etd = gf(d, 'flight_datetime')
    const dispAt = gf(d, 'dispatched_at')
    allDispatchedFlights.push({ id, status, flightStatus, fn, etd, dispAt })
    if (status !== 'dispatched') {
      a1Count++
      console.log(`  MISMATCH: ${fn} (${id.slice(0,8)}) flight_status=${flightStatus} BUT status=${status} | ETD=${etd} dispAt=${dispAt}`)
    }
  }
  console.log(`  Total dispatched flights: ${dispDocs.length} | With status mismatch: ${a1Count}`)

  // A2: dispatched_at in past but flight_datetime in future
  console.log('\n--- A2: dispatched_at in past but ETD in future ---')
  let a2Count = 0
  for (const f of allDispatchedFlights) {
    const dispDate = (f.dispAt || '').slice(0, 10)
    const etdDate = (f.etd || '').slice(0, 10)
    if (dispDate && etdDate && dispDate < etdDate) {
      a2Count++
      console.log(`  ANOMALY: ${f.fn} (${f.id.slice(0,8)}) dispatched_at=${dispDate} but ETD=${etdDate} (${etdDate > dispDate ? 'ETD AFTER dispatch' : ''})`)
    }
  }
  console.log(`  Flights with ETD after dispatch: ${a2Count}`)

  // A3: Flights with same flight_number but different dates (potential collision targets)
  console.log('\n--- A3: Flight numbers with multiple dates (collision risk) ---')
  const allFlightsRes = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_flights' }],
    limit: 500,
  })
  const allFlightDocs = allFlightsRes.filter(r => r.document)
  const byFn = new Map()
  for (const f of allFlightDocs) {
    const d = f.document
    const fn = gf(d, 'flight_number') || ''
    const id = d.name.split('/').pop()
    const etd = gf(d, 'flight_datetime') || ''
    const fStatus = gf(d, 'flight_status') || ''
    const status = gf(d, 'status') || ''
    const dispAt = gf(d, 'dispatched_at') || ''
    const key = fn.replace(/[\s\-]/g, '').toUpperCase()
    if (!key || key === 'PENDING') continue
    if (!byFn.has(key)) byFn.set(key, [])
    byFn.get(key).push({ id, fn, etd: etd.slice(0, 10), fStatus, status, dispAt })
  }
  let a3Count = 0
  for (const [key, flights] of byFn) {
    const dates = new Set(flights.map(f => f.etd).filter(Boolean))
    if (dates.size > 1) {
      a3Count++
      console.log(`  ${key}: ${flights.length} flights, ${dates.size} dates`)
      for (const f of flights) {
        console.log(`    ${f.id.slice(0,8)} ETD=${f.etd} fStatus=${f.fStatus} status=${f.status} dispAt=${(f.dispAt || '').slice(0,10)}`)
      }
    }
  }
  console.log(`  Flight numbers with multiple dates: ${a3Count}`)

  // ================================================================
  // AUDIT B: Booking-level anomalies
  // ================================================================
  console.log('\n================================================================')
  console.log('AUDIT B: BOOKING-LEVEL ANOMALIES')
  console.log('================================================================')

  // B1: Bookings on dispatched flights with mixed dispatched/non-dispatched AWBs
  console.log('\n--- B1: Mixed dispatched/non-dispatched AWBs in same booking ---')
  const dispFlightIds = allDispatchedFlights.map(f => f.id)
  let b1Count = 0
  const suspiciousBookings = []
  for (let i = 0; i < dispFlightIds.length; i += 10) {
    const batch = dispFlightIds.slice(i, i + 10)
    const bRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_bookings' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'IN', value: { arrayValue: { values: batch.map(id => ({ stringValue: id })) } } } },
      limit: 200,
    })
    const bDocs = bRes.filter(r => r.document)
    for (const b of bDocs) {
      const bd = b.document
      const bid = bd.name.split('/').pop()
      const fid = gf(bd, 'flight_id')
      const lines = bd.fields?.awb_lines?.arrayValue?.values || []
      let dispatched = 0, notDispatched = 0
      const notDispAwbs = []
      for (const l of lines) {
        const m = l.mapValue?.fields
        if (!m) continue
        if (m.dispatched?.booleanValue === true) {
          dispatched++
        } else {
          notDispatched++
          notDispAwbs.push(m.awb_number?.stringValue || '?')
        }
      }
      if (dispatched > 0 && notDispatched > 0) {
        b1Count++
        const flight = allDispatchedFlights.find(f => f.id === fid)
        console.log(`  MIXED: ${flight?.fn || '?'} booking ${bid.slice(0,8)} — ${dispatched} dispatched, ${notDispatched} NOT dispatched`)
        console.log(`    Non-dispatched AWBs: ${notDispAwbs.join(', ')}`)
        suspiciousBookings.push({ bid, fid, flight, notDispAwbs })
      }
    }
  }
  console.log(`  Bookings with mixed dispatch state: ${b1Count}`)

  // B2: Check billing for suspicious bookings
  if (suspiciousBookings.length > 0) {
    console.log('\n--- B2: Billing check for suspicious bookings ---')
    for (const sb of suspiciousBookings) {
      const billingRes = await fsQuery(token, {
        from: [{ collectionId: 'air_billing_charges' }],
        where: { fieldFilter: { field: { fieldPath: 'booking_id' }, op: 'EQUAL', value: { stringValue: sb.bid } } },
        limit: 50,
      })
      const billingDocs = billingRes.filter(r => r.document)
      console.log(`  Booking ${sb.bid.slice(0,8)} (${sb.flight?.fn}): ${billingDocs.length} billing charges`)
      // Check if non-dispatched AWBs have billing
      for (const awb of sb.notDispAwbs) {
        const hasBilling = billingDocs.some(bd => {
          const d = bd.document
          return gf(d, 'awb_1st_leg') === awb || gf(d, 'awb_2nd_leg') === awb
        })
        console.log(`    AWB ${awb}: billing=${hasBilling ? 'YES' : 'MISSING'}`)
      }
    }
  }

  // B3: Doc receptions completed after flight dispatch
  console.log('\n--- B3: Doc receptions completed after flight dispatch ---')
  let b3Count = 0
  for (const sb of suspiciousBookings) {
    for (const awb of sb.notDispAwbs) {
      // Search by 1st leg
      const drRes = await fsQuery(token, {
        from: [{ collectionId: 'airfreight_doc_receptions' }],
        where: { fieldFilter: { field: { fieldPath: 'booking_id' }, op: 'EQUAL', value: { stringValue: sb.bid } } },
        limit: 50,
      })
      const drDocs = drRes.filter(r => r.document)
      for (const dr of drDocs) {
        const dd = dr.document
        const drAwb = gf(dd, 'awb_number') || ''
        const drCreated = gf(dd, 'created_at') || ''
        const drStatus = gf(dd, 'status') || ''
        const dispAt = sb.flight?.dispAt || ''
        if (drCreated && dispAt && drCreated > dispAt) {
          b3Count++
          console.log(`  POST-DISPATCH DR: ${drAwb} created=${drCreated.slice(0,10)} dispatch=${dispAt.slice(0,10)} status=${drStatus}`)
        }
      }
    }
  }
  console.log(`  Doc receptions after dispatch: ${b3Count}`)

  // ================================================================
  // AUDIT C: Agent activity trace
  // ================================================================
  console.log('\n================================================================')
  console.log('AUDIT C: AGENT ACTIVITY')
  console.log('================================================================')

  // C1: All sync alerts with alert_type=flight_moved (successful auto-moves)
  console.log('\n--- C1: All flight_moved alerts ---')
  const movedRes = await fsQuery(token, {
    from: [{ collectionId: '_sheet_sync_alerts' }],
    where: { fieldFilter: { field: { fieldPath: 'alert_type' }, op: 'EQUAL', value: { stringValue: 'flight_moved' } } },
    limit: 100,
  })
  const movedDocs = movedRes.filter(r => r.document)
  console.log(`  Total flight_moved alerts: ${movedDocs.length}`)
  for (const a of movedDocs) {
    const d = a.document
    const awb1 = gf(d, 'awb_1st') || ''
    const fn = gf(d, 'flight_number') || ''
    const sf = gf(d, 'system_flight') || ''
    const msg = gf(d, 'message') || ''
    const created = gf(d, 'created_at') || ''
    console.log(`  ${created.slice(0,16)} | ${awb1} | ${sf} -> ${fn} | ${msg}`)
  }

  // C2: All pending_resolved alerts
  console.log('\n--- C2: All pending_resolved alerts ---')
  const resolvedRes = await fsQuery(token, {
    from: [{ collectionId: '_sheet_sync_alerts' }],
    where: { fieldFilter: { field: { fieldPath: 'alert_type' }, op: 'EQUAL', value: { stringValue: 'pending_resolved' } } },
    limit: 100,
  })
  const resolvedDocs = resolvedRes.filter(r => r.document)
  console.log(`  Total pending_resolved alerts: ${resolvedDocs.length}`)

  // C3: Flights created by sheet_sync_agent
  console.log('\n--- C3: Flights created by sheet_sync_agent ---')
  const agentFlights = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_flights' }],
    where: { fieldFilter: { field: { fieldPath: 'created_by' }, op: 'EQUAL', value: { stringValue: 'sheet_sync_agent' } } },
    limit: 50,
  })
  const agentFlightDocs = agentFlights.filter(r => r.document)
  console.log(`  Total agent-created flights: ${agentFlightDocs.length}`)
  for (const f of agentFlightDocs) {
    const d = f.document
    const id = d.name.split('/').pop()
    const fn = gf(d, 'flight_number')
    const etd = gf(d, 'flight_datetime')
    const fStatus = gf(d, 'flight_status')
    const status = gf(d, 'status')
    console.log(`  ${fn} (${id.slice(0,8)}) ETD=${etd} fStatus=${fStatus} status=${status}`)
  }

  // ================================================================
  // SUMMARY
  // ================================================================
  console.log('\n================================================================')
  console.log('AUDIT SUMMARY')
  console.log('================================================================')
  console.log(`  A1 — status/flight_status mismatches: ${a1Count}`)
  console.log(`  A2 — ETD after dispatch date: ${a2Count}`)
  console.log(`  A3 — Flight numbers with multiple dates: ${a3Count}`)
  console.log(`  B1 — Bookings with mixed dispatch state: ${b1Count}`)
  console.log(`  B3 — Doc receptions after dispatch: ${b3Count}`)
  console.log(`  C1 — Auto-moved AWBs (flight_moved): ${movedDocs.length}`)
  console.log(`  C2 — Pending→Real transitions: ${resolvedDocs.length}`)
  console.log(`  C3 — Agent-created flights: ${agentFlightDocs.length}`)
}

main().catch(console.error)
