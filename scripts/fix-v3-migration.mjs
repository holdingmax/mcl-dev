#!/usr/bin/env node
/**
 * FIX V3 — Global data migration script.
 *
 * Phases:
 *   D1: Detect and remove duplicate AWBs across bookings
 *   D2: Repair warehouse_status by global AWB matching (not by booking_id)
 *   D3: Repair doc_reception.booking_id to point to correct booking
 *   D4: Repair physical_pieces.awb_number when 2nd leg changed
 *   D5: Verification — report any remaining inconsistencies
 *
 * Usage:
 *   node scripts/fix-v3-migration.mjs                 (dry run — all phases)
 *   node scripts/fix-v3-migration.mjs --apply          (apply all phases)
 *   node scripts/fix-v3-migration.mjs --verify-only    (only run D5 verification)
 *
 * Read-only by default. Pass --apply to write changes.
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const PROJECT_ID = 'wms-mcl'
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`
const DRY_RUN = !process.argv.includes('--apply')
const VERIFY_ONLY = process.argv.includes('--verify-only')

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

async function patchDoc(token, docName, fields, fieldPaths) {
  const mask = fieldPaths.map(k => `updateMask.fieldPaths=${k}`).join('&')
  const res = await fetch(`${BASE}/${docName}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  return res.ok
}

function str(f, k) { return f?.[k]?.stringValue || '' }
function bool(f, k) { return f?.[k]?.booleanValue || false }
function num(f, k) { return f?.[k]?.integerValue ? parseInt(f[k].integerValue) : (f?.[k]?.doubleValue || 0) }
function norm(s) { return (s || '').replace(/[\s\-]/g, '').toUpperCase() }
function docId(doc) { return doc.name.split('/').pop() }
function docPath(doc) { return doc.name.replace(`projects/${PROJECT_ID}/databases/(default)/documents/`, '') }

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log(VERIFY_ONLY ? '=== VERIFY ONLY ===' : DRY_RUN ? '=== DRY RUN ===' : '=== APPLYING ===')
  const TOKEN = await getAccessToken()
  console.log('Authenticated OK\n')

  // Load all data
  console.log('Loading all data...')
  const [bookingDocs, drDocs, ppDocs] = await Promise.all([
    listCollection(TOKEN, 'airfreight_bookings'),
    listCollection(TOKEN, 'airfreight_doc_receptions'),
    listCollection(TOKEN, 'airfreight_physical_pieces'),
  ])
  console.log(`  ${bookingDocs.length} bookings, ${drDocs.length} doc_receptions, ${ppDocs.length} physical_pieces\n`)

  // Parse bookings into usable structure
  const bookings = bookingDocs.map(d => {
    const f = d.fields || {}
    const lines = (f.awb_lines?.arrayValue?.values || []).map((v, idx) => {
      const lf = v?.mapValue?.fields || {}
      return {
        idx,
        awb_number: str(lf, 'awb_number'),
        awb_2nd_leg: str(lf, 'awb_2nd_leg'),
        warehouse_status: str(lf, 'warehouse_status'),
        on_hand: bool(lf, 'on_hand'),
        dispatched: bool(lf, 'dispatched'),
        doc_reception_id: str(lf, 'doc_reception_id'),
        _fields: lf,
        _value: v,
      }
    })
    return {
      id: docId(d),
      doc: d,
      booking_type: str(f, 'booking_type'),
      client_id: str(f, 'client_id'),
      flight_id: str(f, 'flight_id'),
      lines,
      _fields: f,
    }
  })

  // Parse doc_receptions
  const docReceptions = drDocs.map(d => {
    const f = d.fields || {}
    return {
      id: docId(d),
      doc: d,
      booking_id: str(f, 'booking_id'),
      awb_number: str(f, 'awb_number'),
      awb_2nd_leg: str(f, 'awb_2nd_leg'),
      status: str(f, 'status'),
      _fields: f,
    }
  })

  // Parse physical_pieces
  const physicalPieces = ppDocs.map(d => {
    const f = d.fields || {}
    return {
      id: docId(d),
      doc: d,
      doc_reception_id: str(f, 'doc_reception_id'),
      awb_number: str(f, 'awb_number'),
      uld_id: str(f, 'uld_id'),
      _fields: f,
    }
  })

  const stats = { d1_duplicates_removed: 0, d2_status_fixed: 0, d3_booking_id_fixed: 0, d4_pp_fixed: 0, d5_issues: 0 }

  if (!VERIFY_ONLY) {
    await phaseD1(TOKEN, bookings, docReceptions, stats)
    await phaseD2(TOKEN, bookings, docReceptions, stats)
    await phaseD3(TOKEN, bookings, docReceptions, stats)
    await phaseD4(TOKEN, docReceptions, physicalPieces, stats)
  }
  await phaseD5(bookings, docReceptions, physicalPieces, stats)

  console.log('\n=== FINAL STATS ===')
  console.log(`  D1 duplicates removed: ${stats.d1_duplicates_removed}`)
  console.log(`  D2 warehouse_status fixed: ${stats.d2_status_fixed}`)
  console.log(`  D3 doc_reception.booking_id fixed: ${stats.d3_booking_id_fixed}`)
  console.log(`  D4 physical_pieces.awb_number fixed: ${stats.d4_pp_fixed}`)
  console.log(`  D5 remaining issues: ${stats.d5_issues}`)
  console.log(`\nMode: ${DRY_RUN ? 'DRY RUN (no changes written)' : 'APPLIED'}`)
}

// ============================================================
// D1: Detect and remove duplicate AWBs across bookings
// ============================================================
async function phaseD1(TOKEN, bookings, docReceptions, stats) {
  console.log('=== D1: DUPLICATE DETECTION ===')

  // Build map: norm(awb_number) -> [{bookingId, lineIdx, warehouse_status, on_hand, ...}]
  const awbMap = new Map()

  for (const b of bookings) {
    if (b.booking_type !== 'ecommerce') continue
    for (const line of b.lines) {
      const key = norm(line.awb_number)
      if (!key) continue
      if (!awbMap.has(key)) awbMap.set(key, [])
      awbMap.get(key).push({
        bookingId: b.id,
        lineIdx: line.idx,
        awb_number: line.awb_number,
        awb_2nd_leg: line.awb_2nd_leg,
        warehouse_status: line.warehouse_status,
        on_hand: line.on_hand,
        dispatched: line.dispatched,
      })
    }
  }

  // Find duplicates and collect lines to remove, grouped by booking
  let dupCount = 0
  const linesToRemoveByBooking = new Map() // bookingId -> Set of lineIdx to remove

  for (const [awbKey, entries] of awbMap) {
    if (entries.length <= 1) continue
    dupCount++

    // Determine which entry to KEEP: prefer the one with warehouse_status, then on_hand, then dispatched
    // Also check which booking has a matching doc_reception
    const withDR = entries.filter(e => {
      return docReceptions.some(dr => {
        const drAwbs = [norm(dr.awb_number), norm(dr.awb_2nd_leg)].filter(Boolean)
        return dr.booking_id === e.bookingId && drAwbs.includes(awbKey)
      })
    })

    const ranked = entries.map(e => {
      let score = 0
      if (e.dispatched) score += 100
      if (e.warehouse_status === 'R') score += 50
      if (e.warehouse_status === 'D') score += 20
      if (e.on_hand) score += 10
      if (withDR.some(w => w.bookingId === e.bookingId)) score += 30
      return { ...e, score }
    }).sort((a, b) => b.score - a.score)

    const keep = ranked[0]
    const remove = ranked.slice(1)

    console.log(`  DUP: ${entries[0].awb_number} (${entries.length} copies)`)
    console.log(`    KEEP: booking ${keep.bookingId.slice(0, 8)} (score ${keep.score}, ws=${keep.warehouse_status || '-'}, oh=${keep.on_hand})`)
    for (const r of remove) {
      console.log(`    REMOVE: booking ${r.bookingId.slice(0, 8)} line[${r.lineIdx}] (score ${r.score}, ws=${r.warehouse_status || '-'}, oh=${r.on_hand})`)
      if (!linesToRemoveByBooking.has(r.bookingId)) linesToRemoveByBooking.set(r.bookingId, new Set())
      linesToRemoveByBooking.get(r.bookingId).add(r.lineIdx)
      stats.d1_duplicates_removed++
    }
  }

  // Apply removals: one patch per booking, removing ALL duplicate lines at once
  if (!DRY_RUN) {
    for (const [bookingId, idxSet] of linesToRemoveByBooking) {
      const booking = bookings.find(b => b.id === bookingId)
      if (!booking) continue
      const allValues = booking.doc.fields?.awb_lines?.arrayValue?.values || []
      const newLines = allValues.filter((_, i) => !idxSet.has(i))
      const ok = await patchDoc(TOKEN, docPath(booking.doc), {
        awb_lines: { arrayValue: { values: newLines } },
      }, ['awb_lines'])
      if (ok) {
        booking.lines = booking.lines.filter(l => !idxSet.has(l.idx))
        console.log(`  PATCHED: booking ${bookingId.slice(0, 8)} — removed ${idxSet.size} lines (${newLines.length} remaining)`)
      } else {
        console.log(`  ERROR: Failed to patch booking ${bookingId.slice(0, 8)}`)
      }
    }
  }

  console.log(`  Total duplicate AWBs: ${dupCount}, lines to remove: ${stats.d1_duplicates_removed}\n`)
}

// ============================================================
// D2: Repair warehouse_status by global AWB matching
// ============================================================
async function phaseD2(TOKEN, bookings, docReceptions, stats) {
  console.log('=== D2: WAREHOUSE STATUS REPAIR ===')

  // Build map: norm(awb) -> best warehouse_status from doc_receptions (globally, not by booking_id)
  const awbBestStatus = new Map() // norm(awb) -> { ws: 'R'|'D', drId, drBookingId }

  const STATUS_RANK = { '': 0, 'D': 1, 'R': 2 }

  for (const dr of docReceptions) {
    let ws = ''
    if (dr.status === 'complete' || dr.status === 'in_physical') ws = 'R'
    else if (dr.status === 'pending_physical' || dr.status === 'submitted') ws = 'D'
    if (!ws) continue

    const keys = [norm(dr.awb_number), norm(dr.awb_2nd_leg)].filter(Boolean)
    for (const key of keys) {
      const existing = awbBestStatus.get(key)
      if (!existing || (STATUS_RANK[ws] || 0) > (STATUS_RANK[existing.ws] || 0)) {
        awbBestStatus.set(key, { ws, drId: dr.id, drBookingId: dr.booking_id })
      }
    }
  }

  console.log(`  ${awbBestStatus.size} AWB keys with doc_reception status\n`)

  // Check each booking's AWB lines
  for (const b of bookings) {
    if (b.lines.length === 0) continue
    let bookingChanged = false
    const linesValues = [...(b.doc.fields?.awb_lines?.arrayValue?.values || [])]

    for (const line of b.lines) {
      const key1 = norm(line.awb_number)
      const key2 = norm(line.awb_2nd_leg)
      const best = awbBestStatus.get(key1) || awbBestStatus.get(key2)
      if (!best) continue

      const currentWs = line.warehouse_status
      if ((STATUS_RANK[best.ws] || 0) > (STATUS_RANK[currentWs] || 0)) {
        console.log(`  FIX: ${b.id.slice(0, 8)} line[${line.idx}] ${line.awb_number}: ws '${currentWs}' → '${best.ws}'`)

        // Update in the raw values array
        const lf = linesValues[line.idx]?.mapValue?.fields
        if (lf) {
          lf.warehouse_status = { stringValue: best.ws }
          if (best.ws === 'R') lf.on_hand = { booleanValue: true }
          bookingChanged = true
          stats.d2_status_fixed++
        }
      } else if (best.ws === 'R' && !line.on_hand) {
        // Status correct but on_hand missing
        console.log(`  FIX: ${b.id.slice(0, 8)} line[${line.idx}] ${line.awb_number}: on_hand false → true`)
        const lf = linesValues[line.idx]?.mapValue?.fields
        if (lf) {
          lf.on_hand = { booleanValue: true }
          bookingChanged = true
          stats.d2_status_fixed++
        }
      }
    }

    if (bookingChanged && !DRY_RUN) {
      const ok = await patchDoc(TOKEN, docPath(b.doc), {
        awb_lines: { arrayValue: { values: linesValues } },
      }, ['awb_lines'])
      if (!ok) console.log(`  ERROR: Failed to patch booking ${b.id.slice(0, 8)}`)
    }
  }

  console.log(`  Total lines fixed: ${stats.d2_status_fixed}\n`)
}

// ============================================================
// D3: Repair doc_reception.booking_id
// ============================================================
async function phaseD3(TOKEN, bookings, docReceptions, stats) {
  console.log('=== D3: DOC_RECEPTION BOOKING_ID REPAIR ===')

  // Build map: norm(awb) -> bookingId (where the AWB currently lives)
  const awbToBooking = new Map()
  for (const b of bookings) {
    for (const line of b.lines) {
      const key1 = norm(line.awb_number)
      const key2 = norm(line.awb_2nd_leg)
      if (key1) awbToBooking.set(key1, b.id)
      if (key2) awbToBooking.set(key2, b.id)
    }
  }

  for (const dr of docReceptions) {
    const drAwbs = [norm(dr.awb_number), norm(dr.awb_2nd_leg)].filter(Boolean)
    const correctBookingId = drAwbs.map(k => awbToBooking.get(k)).find(Boolean)

    if (!correctBookingId) continue // AWB not found in any booking — orphan DR
    if (dr.booking_id === correctBookingId) continue // already correct

    console.log(`  FIX: DR ${dr.id.slice(0, 8)} (${dr.awb_number}): booking_id '${(dr.booking_id || '').slice(0, 8)}' → '${correctBookingId.slice(0, 8)}'`)

    if (!DRY_RUN) {
      const ok = await patchDoc(TOKEN, docPath(dr.doc), {
        booking_id: { stringValue: correctBookingId },
      }, ['booking_id'])
      if (ok) {
        stats.d3_booking_id_fixed++
        dr.booking_id = correctBookingId // update in-memory
      } else {
        console.log(`  ERROR: Failed to patch DR ${dr.id.slice(0, 8)}`)
      }
    } else {
      stats.d3_booking_id_fixed++
    }
  }

  console.log(`  Total doc_receptions fixed: ${stats.d3_booking_id_fixed}\n`)
}

// ============================================================
// D4: Repair physical_pieces.awb_number + add awb_1st_leg field
// ============================================================
async function phaseD4(TOKEN, docReceptions, physicalPieces, stats) {
  console.log('=== D4: PHYSICAL_PIECES REPAIR + AWB_1ST_LEG BACKFILL ===')

  // Build map: doc_reception_id -> { awb_number (1st), awb_2nd_leg }
  const drMap = new Map()
  for (const dr of docReceptions) {
    drMap.set(dr.id, { awb1st: dr.awb_number, awb2nd: dr.awb_2nd_leg })
  }

  let backfilled = 0
  const patchQueue = [] // collect all patches first

  for (const pp of physicalPieces) {
    if (!pp.doc_reception_id) continue
    const dr = drMap.get(pp.doc_reception_id)
    if (!dr) continue

    const updates = {}
    const fieldPaths = []

    // Fix awb_number if 2nd leg changed
    const expectedAwb = dr.awb2nd || dr.awb1st
    if (expectedAwb && norm(pp.awb_number) !== norm(expectedAwb)) {
      updates.awb_number = { stringValue: expectedAwb }
      fieldPaths.push('awb_number')
      stats.d4_pp_fixed++
    }

    // Backfill awb_1st_leg if missing
    const pp1st = str(pp._fields, 'awb_1st_leg')
    if (!pp1st && dr.awb1st) {
      updates.awb_1st_leg = { stringValue: dr.awb1st }
      fieldPaths.push('awb_1st_leg')
      backfilled++
    }

    if (fieldPaths.length > 0) {
      patchQueue.push({ pp, updates, fieldPaths })
    }
  }

  // Apply in batches of 20 concurrent requests with pause between batches
  if (!DRY_RUN && patchQueue.length > 0) {
    const BATCH = 20
    let done = 0
    let errors = 0
    for (let i = 0; i < patchQueue.length; i += BATCH) {
      const batch = patchQueue.slice(i, i + BATCH)
      const results = await Promise.all(batch.map(({ pp, updates, fieldPaths }) =>
        patchDoc(TOKEN, docPath(pp.doc), updates, fieldPaths)
      ))
      done += results.filter(Boolean).length
      errors += results.filter(r => !r).length
      if (i % 500 === 0 && i > 0) console.log(`    ... ${done}/${patchQueue.length} done`)
      // Small pause every batch to avoid rate limits
      await new Promise(r => setTimeout(r, 50))
    }
    console.log(`  Applied: ${done} ok, ${errors} errors`)
  }

  console.log(`  awb_number fixes: ${stats.d4_pp_fixed}`)
  console.log(`  awb_1st_leg backfilled: ${backfilled}`)
  console.log(`  Total physical_pieces patched: ${stats.d4_pp_fixed + backfilled}\n`)
}

// ============================================================
// D5: Verification — check all data consistency
// ============================================================
async function phaseD5(bookings, docReceptions, physicalPieces, stats) {
  console.log('=== D5: VERIFICATION ===')

  const issues = []

  // V1: Check for duplicate AWBs across bookings
  const awbBookings = new Map() // norm(awb) -> [bookingId]
  for (const b of bookings) {
    if (b.booking_type !== 'ecommerce') continue
    for (const line of b.lines) {
      const key = norm(line.awb_number)
      if (!key) continue
      if (!awbBookings.has(key)) awbBookings.set(key, [])
      awbBookings.get(key).push(b.id)
    }
  }
  for (const [awb, bids] of awbBookings) {
    if (bids.length > 1) {
      issues.push(`DUPLICATE: AWB ${awb} exists in ${bids.length} bookings: ${bids.map(b => b.slice(0, 8)).join(', ')}`)
    }
  }

  // V2: Check doc_reception.booking_id points to correct booking
  const awbToBooking = new Map()
  for (const b of bookings) {
    for (const line of b.lines) {
      if (norm(line.awb_number)) awbToBooking.set(norm(line.awb_number), b.id)
      if (norm(line.awb_2nd_leg)) awbToBooking.set(norm(line.awb_2nd_leg), b.id)
    }
  }
  for (const dr of docReceptions) {
    const drAwbs = [norm(dr.awb_number), norm(dr.awb_2nd_leg)].filter(Boolean)
    const correctBookingId = drAwbs.map(k => awbToBooking.get(k)).find(Boolean)
    if (correctBookingId && dr.booking_id !== correctBookingId) {
      issues.push(`DR_BOOKING_ID: DR ${dr.id.slice(0, 8)} (${dr.awb_number}) points to ${(dr.booking_id || '').slice(0, 8)} but AWB is in ${correctBookingId.slice(0, 8)}`)
    }
  }

  // V3: Check warehouse_status consistency
  const STATUS_RANK = { '': 0, 'D': 1, 'R': 2 }
  const awbBestStatus = new Map()
  for (const dr of docReceptions) {
    let ws = ''
    if (dr.status === 'complete' || dr.status === 'in_physical') ws = 'R'
    else if (dr.status === 'pending_physical' || dr.status === 'submitted') ws = 'D'
    if (!ws) continue
    for (const key of [norm(dr.awb_number), norm(dr.awb_2nd_leg)].filter(Boolean)) {
      const existing = awbBestStatus.get(key)
      if (!existing || (STATUS_RANK[ws] || 0) > (STATUS_RANK[existing] || 0)) {
        awbBestStatus.set(key, ws)
      }
    }
  }
  for (const b of bookings) {
    for (const line of b.lines) {
      const best = awbBestStatus.get(norm(line.awb_number)) || awbBestStatus.get(norm(line.awb_2nd_leg))
      if (best && (STATUS_RANK[best] || 0) > (STATUS_RANK[line.warehouse_status] || 0)) {
        issues.push(`WS_MISMATCH: ${b.id.slice(0, 8)} line[${line.idx}] ${line.awb_number}: has '${line.warehouse_status || '-'}' but should be '${best}'`)
      }
      if (best === 'R' && !line.on_hand) {
        issues.push(`ON_HAND_MISSING: ${b.id.slice(0, 8)} line[${line.idx}] ${line.awb_number}: ws=R but on_hand=false`)
      }
    }
  }

  // V4: Check physical_pieces.awb_number matches doc_reception
  const drMap = new Map()
  for (const dr of docReceptions) drMap.set(dr.id, dr)
  for (const pp of physicalPieces) {
    if (!pp.doc_reception_id) continue
    const dr = drMap.get(pp.doc_reception_id)
    if (!dr) continue
    const expectedAwb = dr.awb_2nd_leg || dr.awb_number
    if (expectedAwb && norm(pp.awb_number) !== norm(expectedAwb)) {
      issues.push(`PP_AWB: PP ${pp.id.slice(0, 8)} has '${pp.awb_number}' but DR expects '${expectedAwb}'`)
    }
  }

  // Report
  if (issues.length === 0) {
    console.log('  ALL CHECKS PASSED — 0 inconsistencies found')
  } else {
    console.log(`  ${issues.length} issues found:`)
    for (const issue of issues) {
      console.log(`    ${issue}`)
    }
  }
  stats.d5_issues = issues.length
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
