#!/usr/bin/env node
/**
 * Investigate QT-4093 AWBs: trace doc_receptions, physical_pieces, booking links.
 * Read-only — does NOT modify any data.
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const PROJECT_ID = 'wms-mcl'
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`

function getRefreshToken() {
  const p = join(homedir(), '.config', 'configstore', 'firebase-tools.json')
  return JSON.parse(readFileSync(p, 'utf-8')).tokens.refresh_token
}

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: getRefreshToken(),
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }),
  })
  return (await res.json()).access_token
}

async function listCollection(token, col) {
  const docs = []
  let pageToken = ''
  while (true) {
    const url = `${BASE}/${col}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json()
    if (data.documents) docs.push(...data.documents)
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }
  return docs
}

async function runQuery(token, col, filters) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: col }],
      where: filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } },
    },
  }
  const res = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return (Array.isArray(data) ? data : []).filter(r => r.document).map(r => r.document)
}

function str(f, k) { return f?.[k]?.stringValue || '' }
function num(f, k) { return f?.[k]?.integerValue ? parseInt(f[k].integerValue) : (f?.[k]?.doubleValue || 0) }
function bool(f, k) { return f?.[k]?.booleanValue || false }
function norm(s) { return (s || '').replace(/[\s\-]/g, '').toUpperCase() }
function docId(doc) { return doc.name.split('/').pop() }

// The 12 missing AWBs (2nd leg from PDF)
const MISSING_2ND = [
  '729-93889810', '729-93889880', '729-93889806', '729-93889843',
  '729-93889784', '729-93889821', '729-93889795', '729-93889832',
  '729-93889865', '729-93889854', '729-93889876', '729-93889773',
]
// Their 1st legs (from screenshot)
const MISSING_1ST = [
  '369-99362071', '369-99362152', '369-99362060', '369-99362104',
  '369-98154722', '369-99362082', '369-98154733', '369-99362093',
  '369-99362141', '369-99362130', '369-99362115', '369-98154696',
]
const ALL_AWBS = new Set([...MISSING_2ND, ...MISSING_1ST].map(norm))

async function main() {
  const TOKEN = await getAccessToken()
  console.log('Authenticated OK\n')

  // 1. Load ALL doc_receptions
  console.log('=== 1. DOC RECEPTIONS ===')
  const drDocs = await listCollection(TOKEN, 'airfreight_doc_receptions')
  console.log(`Total doc_receptions: ${drDocs.length}\n`)

  const matchedDRs = []
  for (const dr of drDocs) {
    const f = dr.fields || {}
    const awbNum = str(f, 'awb_number')
    const awb2nd = str(f, 'awb_2nd_leg')
    const awb1st = str(f, 'awb_1st_leg')
    const allKeys = [awbNum, awb2nd, awb1st].filter(Boolean).map(norm)

    if (allKeys.some(k => ALL_AWBS.has(k))) {
      matchedDRs.push({
        id: docId(dr),
        awb_number: awbNum,
        awb_1st_leg: awb1st,
        awb_2nd_leg: awb2nd,
        booking_id: str(f, 'booking_id'),
        status: str(f, 'status'),
        flight_number: str(f, 'flight_number') || str(f, 'flight_id'),
        created_at: str(f, 'created_at'),
      })
    }
  }

  if (matchedDRs.length === 0) {
    console.log('  NO doc_receptions found for any of the 12 AWBs!')
  } else {
    console.log(`  Found ${matchedDRs.length} doc_receptions matching the 12 AWBs:`)
    for (const dr of matchedDRs) {
      console.log(`  DR ${dr.id.slice(0,8)}:`)
      console.log(`    awb_number: ${dr.awb_number}`)
      console.log(`    awb_1st_leg: ${dr.awb_1st_leg}`)
      console.log(`    awb_2nd_leg: ${dr.awb_2nd_leg}`)
      console.log(`    booking_id: ${dr.booking_id}`)
      console.log(`    status: ${dr.status}`)
      console.log(`    flight: ${dr.flight_number}`)
      console.log(`    created_at: ${dr.created_at}`)
      console.log()
    }
  }

  // 2. Find QT-4093 booking(s) and check AWB lines
  console.log('=== 2. QT-4093 BOOKINGS ===')
  const allBookings = await listCollection(TOKEN, 'airfreight_bookings')

  // Find the flight for QT-4093
  const allFlights = await listCollection(TOKEN, 'airfreight_flights')
  const qt4093Flights = allFlights.filter(f => {
    const fn = str(f.fields, 'flight_number')
    return fn && fn.includes('4093')
  })

  console.log(`QT-4093 flights found: ${qt4093Flights.length}`)
  for (const fl of qt4093Flights) {
    const f = fl.fields || {}
    const fId = docId(fl)
    console.log(`  Flight ${fId}: ${str(f, 'flight_number')} | status: ${str(f, 'status')} | datetime: ${str(f, 'flight_datetime')}`)

    // Find bookings for this flight
    const flightBookings = allBookings.filter(b => str(b.fields, 'flight_id') === fId)
    console.log(`  Bookings on this flight: ${flightBookings.length}`)

    for (const bk of flightBookings) {
      const bf = bk.fields || {}
      const bId = docId(bk)
      const bType = str(bf, 'booking_type')
      const clientName = str(bf, 'client_name')
      console.log(`\n  Booking ${bId} (${bType}) - ${clientName}:`)
      console.log(`    warehouse_status (top): ${str(bf, 'warehouse_status')}`)
      console.log(`    on_hand (top): ${bool(bf, 'on_hand')}`)

      const lines = bf.awb_lines?.arrayValue?.values || []
      let missing12Count = 0
      for (let i = 0; i < lines.length; i++) {
        const lf = lines[i]?.mapValue?.fields || {}
        const awb1 = str(lf, 'awb_number')
        const awb2 = str(lf, 'awb_2nd_leg')
        const ws = str(lf, 'warehouse_status')
        const oh = bool(lf, 'on_hand')

        // Check if this is one of the 12 missing
        const isMissing = ALL_AWBS.has(norm(awb1)) || ALL_AWBS.has(norm(awb2))
        if (isMissing) {
          missing12Count++
          console.log(`    LINE[${i}] ${awb1} / ${awb2}`)
          console.log(`      warehouse_status: "${ws}" | on_hand: ${oh}`)

          // Check if this AWB has a matching doc_reception
          const matchDR = matchedDRs.find(dr =>
            norm(dr.awb_number) === norm(awb1) || norm(dr.awb_number) === norm(awb2) ||
            norm(dr.awb_2nd_leg) === norm(awb2) || norm(dr.awb_1st_leg) === norm(awb1)
          )
          if (matchDR) {
            console.log(`      DR MATCH: ${matchDR.id.slice(0,8)} (booking_id: ${matchDR.booking_id.slice(0,8)}... | status: ${matchDR.status})`)
            console.log(`      DR booking_id matches THIS booking? ${matchDR.booking_id === bId ? 'YES' : 'NO (points to ' + matchDR.booking_id.slice(0,8) + '...)'}`)
          } else {
            console.log(`      DR MATCH: NONE — no doc_reception found`)
          }
        }
      }
      console.log(`    → ${missing12Count} of the 12 missing AWBs found in this booking`)
    }
  }

  // 3. Check physical_pieces for the missing AWBs
  console.log('\n=== 3. PHYSICAL PIECES ===')
  const ppDocs = await listCollection(TOKEN, 'airfreight_physical_pieces')
  console.log(`Total physical_pieces: ${ppDocs.length}`)

  let piecesWithUld = 0
  let piecesWithoutUld = 0
  const awbPieceMap = new Map() // norm(awb) -> { total, withUld, drId }

  for (const pp of ppDocs) {
    const f = pp.fields || {}
    const drId = str(f, 'doc_reception_id')
    const uldId = str(f, 'uld_id')
    const awbNum = str(f, 'awb_number') || str(f, 'awb_2nd_leg')

    // Check if linked to one of our matched DRs
    const linkedDR = matchedDRs.find(dr => dr.id === drId)
    if (linkedDR) {
      const key = norm(linkedDR.awb_2nd_leg || linkedDR.awb_number)
      if (!awbPieceMap.has(key)) awbPieceMap.set(key, { total: 0, withUld: 0, drId })
      const entry = awbPieceMap.get(key)
      entry.total++
      if (uldId) entry.withUld++
    }

    // Also check by AWB number directly
    if (awbNum && ALL_AWBS.has(norm(awbNum))) {
      const key = norm(awbNum)
      if (!awbPieceMap.has(key)) awbPieceMap.set(key, { total: 0, withUld: 0, drId })
      const entry = awbPieceMap.get(key)
      entry.total++
      if (uldId) entry.withUld++
    }
  }

  if (awbPieceMap.size === 0) {
    console.log('  No physical_pieces found for the 12 AWBs')
  } else {
    console.log(`  Physical pieces found for ${awbPieceMap.size} AWBs:`)
    for (const [awb, info] of awbPieceMap) {
      console.log(`    ${awb}: ${info.total} pieces total, ${info.withUld} with ULD (DR: ${info.drId.slice(0,8)})`)
    }
  }

  // 4. Check the booking_ids from matched DRs — what bookings do they point to?
  if (matchedDRs.length > 0) {
    console.log('\n=== 4. DR BOOKING_ID TRACE ===')
    const drBookingIds = [...new Set(matchedDRs.map(dr => dr.booking_id).filter(Boolean))]
    for (const bid of drBookingIds) {
      const bk = allBookings.find(b => docId(b) === bid)
      if (!bk) {
        console.log(`  Booking ${bid.slice(0,8)}: NOT FOUND (deleted?)`)
        continue
      }
      const bf = bk.fields || {}
      const flightId = str(bf, 'flight_id')
      const flight = allFlights.find(f => docId(f) === flightId)
      const flightNum = flight ? str(flight.fields, 'flight_number') : 'unknown'
      console.log(`  Booking ${bid.slice(0,8)}: flight=${flightNum} (${flightId.slice(0,8)}) | type=${str(bf, 'booking_type')} | client=${str(bf, 'client_name')}`)

      // Check if the AWBs from our matched DRs are still in this booking
      const lines = bf.awb_lines?.arrayValue?.values || []
      const drsForThis = matchedDRs.filter(dr => dr.booking_id === bid)
      for (const dr of drsForThis) {
        const drAwbs = [dr.awb_number, dr.awb_2nd_leg, dr.awb_1st_leg].filter(Boolean).map(norm)
        const found = lines.some((l) => {
          const lf = l?.mapValue?.fields || {}
          return drAwbs.includes(norm(str(lf, 'awb_number'))) || drAwbs.includes(norm(str(lf, 'awb_2nd_leg')))
        })
        console.log(`    DR ${dr.id.slice(0,8)} (${dr.awb_number}): AWB still in this booking? ${found ? 'YES' : 'NO (was moved out)'}`)
      }
    }
  }

  // 5. Summary
  console.log('\n=== 5. SUMMARY ===')
  for (const awb2 of MISSING_2ND) {
    const n = norm(awb2)
    const dr = matchedDRs.find(d => norm(d.awb_2nd_leg) === n || norm(d.awb_number) === n)
    const pp = awbPieceMap.get(n)
    console.log(`${awb2}: DR=${dr ? dr.id.slice(0,8) + '(' + dr.status + ')' : 'NONE'} | PP=${pp ? pp.total + 'pcs/' + pp.withUld + 'uld' : 'NONE'} | DR.booking_id=${dr ? dr.booking_id.slice(0,8) : 'N/A'}`)
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
