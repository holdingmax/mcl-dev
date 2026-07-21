#!/usr/bin/env node
/**
 * Fix warehouse_status on ecommerce bookings where DocReceptions exist
 * but awb_lines have warehouse_status empty/missing.
 *
 * Improvements over v1:
 * - Matches by AWB number (not awb_index) for reliability
 * - Also sets on_hand=true when status='R'
 * - Handles both 1st leg and 2nd leg matching
 *
 * Usage: node scripts/fix-warehouse-status-v2.mjs          (dry run)
 *        node scripts/fix-warehouse-status-v2.mjs --apply   (apply)
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const PROJECT_ID = 'wms-mcl'
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`
const DRY_RUN = !process.argv.includes('--apply')

function getRefreshToken() {
  const p = join(homedir(), '.config', 'configstore', 'firebase-tools.json')
  const cfg = JSON.parse(readFileSync(p, 'utf-8'))
  return cfg.tokens.refresh_token
}

async function getAccessToken() {
  const rt = getRefreshToken()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: rt,
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

function str(fields, key) { return fields?.[key]?.stringValue || '' }
function norm(s) { return (s || '').replace(/[\s\-]/g, '').toUpperCase() }

const STATUS_RANK = { '': 0, D: 1, R: 2 }
function shouldUpgrade(current, proposed) {
  return (STATUS_RANK[proposed] ?? 0) > (STATUS_RANK[current] ?? 0)
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== APPLYING ===')
  const TOKEN = await getAccessToken()
  console.log('Authenticated OK\n')

  // 1. Load all DocReceptions
  console.log('Loading DocReceptions...')
  const drDocs = await listCollection(TOKEN, 'airfreight_doc_receptions')
  console.log(`  Found ${drDocs.length} DocReceptions`)

  // Build map: bookingId -> Map<normalizedAwb, bestStatus>
  const bookingAwbStatus = new Map()

  for (const drDoc of drDocs) {
    const f = drDoc.fields || {}
    const bookingId = str(f, 'booking_id')
    if (!bookingId) continue

    const drStatus = str(f, 'status')
    let wsFromDr = ''
    if (drStatus === 'complete' || drStatus === 'in_physical') wsFromDr = 'R'
    else if (drStatus === 'pending_physical' || drStatus === 'submitted') wsFromDr = 'D'
    if (!wsFromDr) continue

    // Collect all AWB identifiers from this doc reception
    const awbKeys = new Set()
    const awbNum = str(f, 'awb_number')
    const awb2nd = str(f, 'awb_2nd_leg')
    const awb1st = str(f, 'awb_1st_leg')
    if (awbNum) awbKeys.add(norm(awbNum))
    if (awb2nd) awbKeys.add(norm(awb2nd))
    if (awb1st) awbKeys.add(norm(awb1st))

    if (!bookingAwbStatus.has(bookingId)) bookingAwbStatus.set(bookingId, new Map())
    const awbMap = bookingAwbStatus.get(bookingId)
    for (const key of awbKeys) {
      const existing = awbMap.get(key) || ''
      if (shouldUpgrade(existing, wsFromDr)) awbMap.set(key, wsFromDr)
    }
  }

  console.log(`  ${bookingAwbStatus.size} bookings have DocReceptions\n`)

  // 2. Check each booking and fix if needed
  let fixedBookings = 0
  let fixedLines = 0
  let skipped = 0
  let errors = 0

  for (const [bookingId, awbMap] of bookingAwbStatus) {
    const bUrl = `${BASE}/airfreight_bookings/${bookingId}`
    const bRes = await fetch(bUrl, { headers: { Authorization: `Bearer ${TOKEN}` } })
    if (!bRes.ok) { skipped++; continue }

    const bDoc = await bRes.json()
    const f = bDoc.fields || {}
    const bookingType = str(f, 'booking_type')

    if (bookingType === 'simple') {
      // Simple booking: warehouse_status is at top level
      const current = str(f, 'warehouse_status')
      // Find best status from any AWB key
      let best = ''
      for (const [, s] of awbMap) { if (shouldUpgrade(best, s)) best = s }

      if (best && shouldUpgrade(current, best)) {
        console.log(`  FIX: ${bookingId} (simple) warehouse_status: '${current}' -> '${best}'`)
        if (!DRY_RUN) {
          const updateFields = { warehouse_status: { stringValue: best } }
          if (best === 'R') updateFields.on_hand = { booleanValue: true }
          const mask = Object.keys(updateFields).map(k => `updateMask.fieldPaths=${k}`).join('&')
          const patchRes = await fetch(`${bUrl}?${mask}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: updateFields }),
          })
          if (patchRes.ok) fixedBookings++
          else { console.error(`  ERROR: ${bookingId}`, patchRes.status); errors++ }
        } else {
          fixedBookings++
        }
        fixedLines++
      } else {
        skipped++
      }
    } else {
      // ecommerce / mawb — has awb_lines array
      const lines = f.awb_lines?.arrayValue?.values || []
      let anyChanged = false

      for (let idx = 0; idx < lines.length; idx++) {
        const lf = lines[idx]?.mapValue?.fields || {}
        const current = str(lf, 'warehouse_status')

        // Match by AWB number (1st leg or 2nd leg)
        const lineAwb1 = norm(str(lf, 'awb_number'))
        const lineAwb2 = norm(str(lf, 'awb_2nd_leg'))
        const proposed = awbMap.get(lineAwb1) || awbMap.get(lineAwb2) || ''

        if (proposed && shouldUpgrade(current, proposed)) {
          const awbDisplay = str(lf, 'awb_number') || str(lf, 'awb_2nd_leg')
          console.log(`  FIX: ${bookingId} line[${idx}] ${awbDisplay} warehouse_status: '${current}' -> '${proposed}'`)
          lf.warehouse_status = { stringValue: proposed }
          if (proposed === 'R') lf.on_hand = { booleanValue: true }
          anyChanged = true
          fixedLines++
        }
      }

      if (anyChanged) {
        if (!DRY_RUN) {
          const patchRes = await fetch(`${bUrl}?updateMask.fieldPaths=awb_lines`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { awb_lines: { arrayValue: { values: lines } } } }),
          })
          if (patchRes.ok) fixedBookings++
          else { console.error(`  ERROR: ${bookingId}`, patchRes.status); errors++ }
        } else {
          fixedBookings++
        }
      } else {
        skipped++
      }
    }
  }

  console.log(`\n${DRY_RUN ? 'DRY RUN' : 'APPLIED'}:`)
  console.log(`  ${fixedBookings} bookings fixed (${fixedLines} AWB lines)`)
  console.log(`  ${skipped} already OK, ${errors} errors`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
