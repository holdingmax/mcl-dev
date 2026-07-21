#!/usr/bin/env node
/**
 * ONE-TIME FIX: Update flights with airline="Unknown" using deliverTo from bookings.
 *
 * For each flight with airline="Unknown" (not dispatched/closed):
 * - Find bookings on that flight
 * - Check if booking has airline or deliver_to data
 * - Update flight airline if valid data found
 *
 * Usage: node scripts/fix-unknown-airlines.mjs [--dry-run]
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const PROJECT_ID = 'wms-mcl'
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`
const DRY_RUN = process.argv.includes('--dry-run')

// ── Auth ──────────────────────────────────────────────────────────────────

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
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data))
  return data.access_token
}

let TOKEN = ''

// ── Firestore REST helpers ────────────────────────────────────────────────

function fieldVal(fields, key) {
  const f = fields[key]
  if (!f) return ''
  return f.stringValue || f.integerValue || ''
}

async function runQuery(collectionId, fieldPath, op, value) {
  const url = `${BASE}:runQuery`
  const body = {
    structuredQuery: {
      from: [{ collectionId }],
      where: {
        fieldFilter: {
          field: { fieldPath },
          op,
          value: { stringValue: value },
        },
      },
      limit: 100,
    },
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  const docs = []
  for (const r of data) {
    if (r.document) {
      const id = r.document.name.split('/').pop()
      docs.push({ id, fields: r.document.fields || {} })
    }
  }
  return docs
}

async function updateDoc(collectionId, docId, updates) {
  const fields = {}
  for (const [k, v] of Object.entries(updates)) {
    fields[k] = { stringValue: v }
  }
  const mask = Object.keys(updates).map(k => `updateMask.fieldPaths=${k}`).join('&')
  const url = `${BASE}/${collectionId}/${docId}?${mask}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`PATCH failed: ${res.status} ${err}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  TOKEN = await getAccessToken()
  if (DRY_RUN) console.log('=== DRY RUN MODE ===\n')

  // 1. Find flights with airline="Unknown"
  const unknownFlights = await runQuery('airfreight_flights', 'airline', 'EQUAL', 'Unknown')
  console.log(`Found ${unknownFlights.length} flights with airline="Unknown"\n`)
  if (unknownFlights.length === 0) return

  let fixed = 0, skippedBlocked = 0, skippedNoData = 0

  for (const flight of unknownFlights) {
    const fn = fieldVal(flight.fields, 'flight_number')
    const etd = fieldVal(flight.fields, 'flight_datetime')
    const status = fieldVal(flight.fields, 'flight_status') || fieldVal(flight.fields, 'status')
    const dispatchedAt = flight.fields.dispatched_at

    const sLow = (status || '').toLowerCase()
    const isBlocked = sLow === 'dispatched' || sLow === 'closed' || sLow === 'cancelled' || !!dispatchedAt

    console.log(`Flight: ${fn} (${(etd || '').slice(0, 10)}) [${flight.id.slice(0, 8)}] status=${sLow || 'open'}`)

    if (isBlocked) {
      console.log(`  SKIP: flight is ${sLow || 'dispatched'}\n`)
      skippedBlocked++
      continue
    }

    // 2. Find bookings on this flight
    const bookings = await runQuery('airfreight_bookings', 'flight_id', 'EQUAL', flight.id)

    if (bookings.length === 0) {
      console.log(`  SKIP: no bookings found\n`)
      skippedNoData++
      continue
    }

    // 3. Check booking-level airline/deliver_to fields
    let foundAirline = ''
    for (const b of bookings) {
      const airline = fieldVal(b.fields, 'airline')
      if (airline && airline !== 'Unknown' && airline.trim().length >= 2) {
        foundAirline = airline.trim()
        break
      }
      const deliverTo = fieldVal(b.fields, 'deliver_to')
      if (deliverTo && deliverTo !== 'Unknown' && deliverTo.trim().length >= 2) {
        foundAirline = deliverTo.trim()
        break
      }
    }

    if (!foundAirline) {
      console.log(`  SKIP: no airline data in ${bookings.length} booking(s)\n`)
      skippedNoData++
      continue
    }

    console.log(`  FIX: "${foundAirline}"`)
    if (!DRY_RUN) {
      await updateDoc('airfreight_flights', flight.id, { airline: foundAirline })
      console.log(`  UPDATED\n`)
    } else {
      console.log(`  [DRY-RUN] would update\n`)
    }
    fixed++
  }

  console.log('\n--- Summary ---')
  console.log(`Total Unknown flights: ${unknownFlights.length}`)
  console.log(`Fixed: ${fixed}`)
  console.log(`Skipped (blocked): ${skippedBlocked}`)
  console.log(`Skipped (no data): ${skippedNoData}`)
  if (DRY_RUN) console.log('\nRe-run without --dry-run to apply fixes.')
}

main().catch(err => { console.error(err); process.exit(1) })
