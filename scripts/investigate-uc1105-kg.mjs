#!/usr/bin/env node
/**
 * Investigate UC-1105 (May 29) KG discrepancy: 722,826 KG shown in dashboard.
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

function str(f, k) { return f?.[k]?.stringValue || '' }
function numRaw(f, k) {
  if (f?.[k]?.integerValue) return { raw: f[k].integerValue, parsed: parseInt(f[k].integerValue) }
  if (f?.[k]?.doubleValue !== undefined) return { raw: f[k].doubleValue, parsed: f[k].doubleValue }
  if (f?.[k]?.stringValue) return { raw: f[k].stringValue, parsed: Number(f[k].stringValue) }
  return { raw: null, parsed: 0 }
}
function docId(doc) { return doc.name.split('/').pop() }

async function main() {
  const TOKEN = await getAccessToken()
  console.log('Authenticated OK\n')

  // 1. Find UC-1105 flight(s)
  const allFlights = await listCollection(TOKEN, 'airfreight_flights')
  const uc1105 = allFlights.filter(f => {
    const fn = str(f.fields, 'flight_number')
    return fn && fn.includes('1105')
  })

  console.log(`=== FLIGHTS matching "1105": ${uc1105.length} ===`)
  for (const fl of uc1105) {
    const f = fl.fields || {}
    console.log(`  ${docId(fl)}: ${str(f, 'flight_number')} | ETD: ${str(f, 'flight_datetime')} | status: ${str(f, 'status')}`)
  }

  // 2. For each UC-1105 flight, find bookings and analyze weight fields
  const allBookings = await listCollection(TOKEN, 'airfreight_bookings')

  for (const fl of uc1105) {
    const fId = docId(fl)
    const flightNum = str(fl.fields, 'flight_number')
    const flightDate = str(fl.fields, 'flight_datetime')

    console.log(`\n=== BOOKINGS for ${flightNum} (${flightDate}) ===`)
    const flightBookings = allBookings.filter(b => str(b.fields, 'flight_id') === fId)
    console.log(`Found ${flightBookings.length} bookings`)

    let grandTotalWeight = 0
    let grandTotalChw = 0

    for (const bk of flightBookings) {
      const bf = bk.fields || {}
      const bId = docId(bk)
      const bType = str(bf, 'booking_type')
      const client = str(bf, 'client_name')

      console.log(`\n  BOOKING ${bId} (${bType}) — ${client}`)

      if (bType === 'mawb' || bType === 'ecommerce' || bType === 'export') {
        const lines = bf.awb_lines?.arrayValue?.values || []
        console.log(`    AWB lines: ${lines.length}`)

        let bookingWeight = 0
        let bookingChw = 0

        for (let i = 0; i < lines.length; i++) {
          const lf = lines[i]?.mapValue?.fields || {}
          const awb = str(lf, 'awb_number')
          const awb2 = str(lf, 'awb_2nd_leg')
          const pcs = numRaw(lf, 'pieces')
          const wt = numRaw(lf, 'weight')
          const cw = numRaw(lf, 'chargeable_weight')

          bookingWeight += Number(wt.parsed) || 0
          bookingChw += Number(cw.parsed) || 0

          console.log(`    [${i}] ${awb} / ${awb2}`)
          console.log(`        pieces: ${pcs.raw} (=${pcs.parsed})`)
          console.log(`        weight: ${wt.raw} (=${wt.parsed}) ← KG field`)
          console.log(`        chargeable_weight: ${cw.raw} (=${cw.parsed}) ← CHW field`)
        }

        console.log(`    BOOKING TOTALS: weight=${bookingWeight}, chw=${bookingChw}`)
        grandTotalWeight += bookingWeight
        grandTotalChw += bookingChw
      } else {
        // Simple booking — top-level fields
        const wt = numRaw(bf, 'weight')
        const cw = numRaw(bf, 'chargeable_weight')
        const pcs = numRaw(bf, 'pieces')
        console.log(`    pieces: ${pcs.raw} (=${pcs.parsed})`)
        console.log(`    weight: ${wt.raw} (=${wt.parsed}) ← KG field`)
        console.log(`    chargeable_weight: ${cw.raw} (=${cw.parsed}) ← CHW field`)
        grandTotalWeight += Number(wt.parsed) || 0
        grandTotalChw += Number(cw.parsed) || 0
      }
    }

    console.log(`\n  === FLIGHT GRAND TOTAL ===`)
    console.log(`  totalWeight (KG column): ${grandTotalWeight}`)
    console.log(`  totalChw (CHW column):   ${grandTotalChw}`)
    console.log(`  Dashboard would show KG: ${Math.round(grandTotalWeight * 10) / 10}`)
    console.log(`  Dashboard would show CHW: ${Math.round(grandTotalChw * 10) / 10}`)
  }

  // 2b. Check booking metadata (created_by, updated_at, etc.)
  console.log('\n=== BOOKING METADATA yVKHwo3AbkIdHbxOi4pT ===')
  const targetBooking = allBookings.find(b => docId(b) === 'yVKHwo3AbkIdHbxOi4pT')
  if (targetBooking) {
    const bf = targetBooking.fields || {}
    console.log(`  created_by: ${str(bf, 'created_by')}`)
    console.log(`  created_at: ${str(bf, 'created_at')}`)
    console.log(`  updated_at: ${str(bf, 'updated_at')}`)
    console.log(`  updated_by: ${str(bf, 'updated_by')}`)
    console.log(`  booking_type: ${str(bf, 'booking_type')}`)
    console.log(`  client_name: ${str(bf, 'client_name')}`)
    console.log(`  flight_id: ${str(bf, 'flight_id')}`)
    // Check Firestore document metadata
    console.log(`  _createTime: ${targetBooking.createTime}`)
    console.log(`  _updateTime: ${targetBooking.updateTime}`)
    // Check all top-level fields
    console.log('  ALL FIELDS:')
    for (const [k, v] of Object.entries(bf)) {
      if (k === 'awb_lines') continue // skip array
      const val = v?.stringValue || v?.integerValue || v?.doubleValue || v?.booleanValue || v?.timestampValue || JSON.stringify(v)
      console.log(`    ${k}: ${val}`)
    }
  }

  // 3. Find ALL doc_receptions for the 3 AWBs (broadened to catch duplicates)
  console.log('\n=== ALL DOC RECEPTIONS for the 3 OH AWBs ===')
  const drDocs = await listCollection(TOKEN, 'airfreight_doc_receptions')
  const targetAwbs = ['36999784300', '36998153646', '36998153915', '04522210613', '04522209515']
  const matchedDRIds = []
  for (const dr of drDocs) {
    const f = dr.fields || {}
    const awb = (str(f, 'awb_number') || '').replace(/[\s\-]/g, '')
    const awb2 = (str(f, 'awb_2nd_leg') || '').replace(/[\s\-]/g, '')
    const awb1 = (str(f, 'awb_1st_leg') || '').replace(/[\s\-]/g, '')
    if (targetAwbs.includes(awb) || targetAwbs.includes(awb2) || targetAwbs.includes(awb1)) {
      const id = docId(dr)
      matchedDRIds.push(id)
      const wt = numRaw(f, 'weight')
      const cw = numRaw(f, 'chargeable_weight')
      const pcs = numRaw(f, 'pieces')
      console.log(`  DR ${id}:`)
      console.log(`    awb_number: ${str(f, 'awb_number')}`)
      console.log(`    awb_1st_leg: ${str(f, 'awb_1st_leg')}`)
      console.log(`    awb_2nd_leg: ${str(f, 'awb_2nd_leg')}`)
      console.log(`    pieces: ${pcs.raw} (=${pcs.parsed})`)
      console.log(`    weight: ${wt.raw} (=${wt.parsed})`)
      console.log(`    chargeable_weight: ${cw.raw} (=${cw.parsed})`)
      console.log(`    booking_id: ${str(f, 'booking_id')}`)
      console.log(`    status: ${str(f, 'status')}`)
      console.log(`    warehouse_status: ${str(f, 'warehouse_status')}`)
      console.log(`    warehouse_number: ${str(f, 'warehouse_number')}`)
      console.log(`    created_at: ${str(f, 'created_at')}`)
      console.log(`    created_by: ${str(f, 'created_by')}`)
      console.log(`    updated_at: ${str(f, 'updated_at')}`)
      console.log(`    _createTime: ${dr.createTime}`)
      console.log(`    _updateTime: ${dr.updateTime}`)
      console.log()
    }
  }
  console.log(`  Total doc receptions found: ${matchedDRIds.length}`)

  // 3b. Check physical_pieces for ALL found doc receptions
  console.log('\n=== PHYSICAL PIECES for ALL matched DRs ===')
  const ppDocs = await listCollection(TOKEN, 'airfreight_physical_pieces')
  for (const drId of matchedDRIds) {
    const ppForDr = ppDocs.filter(pp => str(pp.fields, 'doc_reception_id') === drId)
    const totalWt = ppForDr.reduce((s, pp) => s + (numRaw(pp.fields, 'weight_kg').parsed || 0), 0)
    console.log(`  DR ${drId}: ${ppForDr.length} pieces, total weight_kg=${totalWt}`)
    for (const pp of ppForDr.slice(0, 3)) {
      const f = pp.fields || {}
      console.log(`    piece: wt=${numRaw(f, 'weight_kg').raw}, awb=${str(f, 'awb_number')}, created=${str(f, 'created_at')}, by=${str(f, 'created_by')}`)
    }
    if (ppForDr.length > 3) console.log(`    ... and ${ppForDr.length - 3} more`)
  }

  // 3c. Check current weight/on_hand values in booking (re-fetch fresh)
  console.log('\n=== CURRENT BOOKING STATE yVKHwo3AbkIdHbxOi4pT ===')
  const freshRes = await fetch(`${BASE}/airfreight_bookings/yVKHwo3AbkIdHbxOi4pT`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  })
  const freshBooking = await freshRes.json()
  if (freshBooking.fields) {
    const lines = freshBooking.fields?.awb_lines?.arrayValue?.values || []
    console.log(`  _updateTime: ${freshBooking.updateTime}`)
    console.log(`  awb_lines count: ${lines.length}`)
    for (let i = 0; i < lines.length; i++) {
      const lf = lines[i]?.mapValue?.fields || {}
      const awb = str(lf, 'awb_number')
      const awb2 = str(lf, 'awb_2nd_leg')
      const wt = numRaw(lf, 'weight')
      const oh = lf?.on_hand?.booleanValue || false
      const ws = str(lf, 'warehouse_status')
      const pcs = numRaw(lf, 'pieces')
      const cw = numRaw(lf, 'chargeable_weight')
      console.log(`  [${i}] ${awb} / ${awb2}: pcs=${pcs.parsed}, wt=${wt.parsed}, cw=${cw.parsed}, ws=${ws}, oh=${oh}`)
    }
  } else {
    console.log('  ERROR: Could not fetch booking')
  }

  // 3d. Search ALL physical pieces by AWB number (broadened)
  console.log('\n=== PHYSICAL PIECES by AWB number (broadened search) ===')
  const awbSearch = ['36999784300', '04522210613', '36998153646', '04522209515', '36998153915']
  let ppFound = 0
  for (const pp of ppDocs) {
    const f = pp.fields || {}
    const ppAwb = (str(f, 'awb_number') || '').replace(/[\s\-]/g, '')
    const ppAwb1 = (str(f, 'awb_1st_leg') || '').replace(/[\s\-]/g, '')
    if (awbSearch.includes(ppAwb) || awbSearch.includes(ppAwb1)) {
      ppFound++
      console.log(`  Piece ${docId(pp)}: awb=${str(f, 'awb_number')}, dr=${str(f, 'doc_reception_id')}, wt=${numRaw(f, 'weight_kg').raw}, created=${str(f, 'created_at')}`)
    }
  }
  if (ppFound === 0) console.log('  NONE FOUND — no physical pieces exist anywhere for these AWBs')

  // 3e. Full doc_reception details
  console.log('\n=== DOC RECEPTION FULL DETAILS ===')
  for (const dr of drDocs) {
    const drId = docId(dr)
    if (!targetDRs.includes(drId)) continue
    const f = dr.fields || {}
    console.log(`  DR ${drId}:`)
    console.log(`    awb_number: ${str(f, 'awb_number')}`)
    console.log(`    status: ${str(f, 'status')}`)
    console.log(`    warehouse_status: ${str(f, 'warehouse_status')}`)
    console.log(`    created_at: ${str(f, 'created_at')}`)
    console.log(`    created_by: ${str(f, 'created_by')}`)
    console.log(`    updated_at: ${str(f, 'updated_at')}`)
    console.log(`    warehouse_number: ${str(f, 'warehouse_number')}`)
    console.log(`    _createTime: ${dr.createTime}`)
    console.log(`    _updateTime: ${dr.updateTime}`)
    // All remaining fields
    for (const [k, v] of Object.entries(f)) {
      if (['awb_number', 'awb_1st_leg', 'awb_2nd_leg', 'pieces', 'weight', 'chargeable_weight', 'booking_id', 'status', 'created_at', 'created_by', 'warehouse_status', 'updated_at', 'warehouse_number'].includes(k)) continue
      const val = v?.stringValue ?? v?.integerValue ?? v?.doubleValue ?? v?.booleanValue ?? v?.timestampValue ?? ''
      if (val !== '' && val !== false && val !== 0) console.log(`    ${k}: ${val}`)
    }
    console.log()
  }

  // 4. Check alerts for this booking
  console.log('\n=== ALERTS for booking yVKHwo3AbkIdHbxOi4pT ===')
  const alertDocs = await listCollection(TOKEN, '_sheet_sync_alerts')
  const bookingAlerts = alertDocs.filter(a => {
    const f = a.fields || {}
    return str(f, 'booking_id') === 'yVKHwo3AbkIdHbxOi4pT'
  })
  console.log(`Found ${bookingAlerts.length} alerts`)
  for (const a of bookingAlerts) {
    const f = a.fields || {}
    console.log(`  Alert ${docId(a)}:`)
    console.log(`    type: ${str(f, 'type')}`)
    console.log(`    awb: ${str(f, 'awb_1st')}`)
    console.log(`    status: ${str(f, 'status')}`)
    console.log(`    created: ${str(f, 'created_at')}`)
    // Show diffs if present
    const diffs = f.diffs?.arrayValue?.values || []
    for (const d of diffs) {
      const df = d?.mapValue?.fields || {}
      console.log(`      diff: ${str(df, 'field')} "${str(df, 'old')}" → "${str(df, 'new')}"`)
    }
    console.log()
  }

  // 5. Check activity log for this booking
  console.log('\n=== ACTIVITY LOG for booking yVKHwo3AbkIdHbxOi4pT ===')
  const logDocs = await listCollection(TOKEN, 'airfreight_activity_log')
  const bookingLogs = logDocs.filter(a => {
    const f = a.fields || {}
    return str(f, 'booking_id') === 'yVKHwo3AbkIdHbxOi4pT' ||
           str(f, 'entity_id') === 'yVKHwo3AbkIdHbxOi4pT'
  })
  console.log(`Found ${bookingLogs.length} log entries`)
  for (const l of bookingLogs.slice(-20)) {
    const f = l.fields || {}
    console.log(`  ${str(f, 'created_at') || str(f, 'timestamp')}: ${str(f, 'action') || str(f, 'type')} | ${str(f, 'details') || str(f, 'message')}`)
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
