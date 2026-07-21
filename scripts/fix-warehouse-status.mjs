#!/usr/bin/env node
/**
 * Fix warehouse_status on bookings where DocReceptions exist but booking
 * warehouse_status is null/empty.
 *
 * Only updates warehouse_status — does NOT touch any other field.
 *
 * Logic:
 * - DR status 'complete' or 'in_physical' → warehouse_status = 'R'
 * - DR status 'pending_physical' or 'submitted' → warehouse_status = 'D'
 * - Only upgrades, never downgrades (won't overwrite 'R' with 'D')
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const PROJECT_ID = 'wms-mcl'
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`

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
function num(fields, key) { return fields?.[key]?.integerValue ? parseInt(fields[key].integerValue) : 0 }

const STATUS_RANK = { '': 0, D: 1, R: 2, B: 3, L: 4, T: 5 }
function shouldUpgrade(current, proposed) {
  return (STATUS_RANK[proposed] ?? 0) > (STATUS_RANK[current] ?? 0)
}

async function main() {
  const TOKEN = await getAccessToken()
  console.log('Authenticated OK\n')

  // 1. Load all DocReceptions
  console.log('Loading DocReceptions...')
  const drDocs = await listCollection(TOKEN, 'airfreight_doc_receptions')
  console.log(`  Found ${drDocs.length} DocReceptions`)

  // Build map: bookingId -> Map<awbIndex, bestStatus>
  const bookingStatusMap = new Map()

  for (const drDoc of drDocs) {
    const f = drDoc.fields || {}
    const bookingId = str(f, 'booking_id')
    if (!bookingId) continue

    const drStatus = str(f, 'status')
    let wsFromDr = ''
    if (drStatus === 'complete' || drStatus === 'in_physical') {
      wsFromDr = 'R'
    } else if (drStatus === 'pending_physical' || drStatus === 'submitted') {
      wsFromDr = 'D'
    }
    if (!wsFromDr) continue

    if (!bookingStatusMap.has(bookingId)) bookingStatusMap.set(bookingId, new Map())
    const awbIdx = num(f, 'awb_index')
    const existing = bookingStatusMap.get(bookingId).get(awbIdx) || ''
    if (shouldUpgrade(existing, wsFromDr)) {
      bookingStatusMap.get(bookingId).set(awbIdx, wsFromDr)
    }
  }

  console.log(`  ${bookingStatusMap.size} bookings have DocReceptions\n`)

  // 2. Check each booking and fix if needed
  let fixed = 0
  let skipped = 0
  let errors = 0

  for (const [bookingId, awbMap] of bookingStatusMap) {
    const bUrl = `${BASE}/airfreight_bookings/${bookingId}`
    const bRes = await fetch(bUrl, { headers: { Authorization: `Bearer ${TOKEN}` } })
    if (!bRes.ok) { console.log(`  SKIP: ${bookingId} (not found)`); skipped++; continue }

    const bDoc = await bRes.json()
    const f = bDoc.fields || {}
    const bookingType = str(f, 'booking_type')

    if (bookingType === 'simple') {
      const current = str(f, 'warehouse_status')
      const proposed = awbMap.get(0) || ''
      if (proposed && shouldUpgrade(current, proposed)) {
        const patchRes = await fetch(`${bUrl}?updateMask.fieldPaths=warehouse_status`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: { warehouse_status: { stringValue: proposed } },
          }),
        })
        if (patchRes.ok) {
          console.log(`  FIX: ${bookingId} (simple) warehouse_status: '${current}' -> '${proposed}'`)
          fixed++
        } else {
          console.error(`  ERROR: ${bookingId}`, patchRes.status)
          errors++
        }
      } else {
        skipped++
      }
    } else {
      // ecommerce / export / mawb — has awb_lines array
      const lines = f.awb_lines?.arrayValue?.values || []
      let anyChanged = false

      for (let idx = 0; idx < lines.length; idx++) {
        const lf = lines[idx]?.mapValue?.fields || {}
        const current = str(lf, 'warehouse_status')
        const proposed = awbMap.get(idx) || ''
        if (proposed && shouldUpgrade(current, proposed)) {
          lf.warehouse_status = { stringValue: proposed }
          const awbNum = str(lf, 'awb_number') || str(lf, 'awb_2nd_leg')
          console.log(`  FIX: ${bookingId} line[${idx}] ${awbNum} warehouse_status: '${current}' -> '${proposed}'`)
          anyChanged = true
        }
      }

      if (anyChanged) {
        const patchRes = await fetch(`${bUrl}?updateMask.fieldPaths=awb_lines`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: { awb_lines: { arrayValue: { values: lines } } },
          }),
        })
        if (patchRes.ok) { fixed++ }
        else { console.error(`  ERROR: ${bookingId}`, patchRes.status); errors++ }
      } else {
        skipped++
      }
    }
  }

  console.log(`\nDone: ${fixed} bookings fixed, ${skipped} already OK, ${errors} errors`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
