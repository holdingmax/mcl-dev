#!/usr/bin/env node
/**
 * ONE-TIME FIX: Set airline="TriStar AEROLINEAS" on the two AR-1305 flights
 * that were created with airline="Unknown" due to header detection issue.
 *
 * Flight IDs (from Firestore audit):
 *   ZrAIIy0x... → AR-1305 2026-07-09
 *   uIodxKwG... → AR-1305 2026-07-10
 *
 * Usage: node scripts/fix-ar1305-airline.mjs [--dry-run]
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const PROJECT_ID = 'wms-mcl'
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`
const DRY_RUN = process.argv.includes('--dry-run')

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
  if (!data.access_token) throw new Error('Auth failed: ' + JSON.stringify(data))
  return data.access_token
}

async function getDoc(token, collection, docId) {
  const res = await fetch(`${BASE}/${collection}/${docId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`GET ${docId}: ${res.status}`)
  return await res.json()
}

async function patchDoc(token, collection, docId, updates) {
  const fields = {}
  for (const [k, v] of Object.entries(updates)) {
    fields[k] = { stringValue: v }
  }
  const mask = Object.keys(updates).map(k => `updateMask.fieldPaths=${k}`).join('&')
  const res = await fetch(`${BASE}/${collection}/${docId}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`PATCH ${docId}: ${res.status} ${await res.text()}`)
}

async function main() {
  const TOKEN = await getAccessToken()
  if (DRY_RUN) console.log('=== DRY RUN ===\n')

  const TARGET_AIRLINE = 'TriStar AEROLINEAS'

  // These IDs were identified from Firestore audit trail
  const flightIds = ['ZrAIIy0xaY7jFAUotAua', 'uIodxKwGJHsBJsGOsgZ8']

  for (const fid of flightIds) {
    const doc = await getDoc(TOKEN, 'airfreight_flights', fid)
    const fields = doc.fields || {}
    const fn = (fields.flight_number || {}).stringValue || '?'
    const etd = (fields.flight_datetime || {}).stringValue || ''
    const airline = (fields.airline || {}).stringValue || ''

    console.log(`Flight ${fn} (${etd.slice(0, 10)}) [${fid.slice(0, 8)}]`)
    console.log(`  Current airline: "${airline}"`)

    if (airline !== 'Unknown') {
      console.log(`  SKIP: airline already set\n`)
      continue
    }

    if (DRY_RUN) {
      console.log(`  [DRY-RUN] Would set to "${TARGET_AIRLINE}"\n`)
    } else {
      await patchDoc(TOKEN, 'airfreight_flights', fid, { airline: TARGET_AIRLINE })
      console.log(`  UPDATED to "${TARGET_AIRLINE}"\n`)
    }
  }

  console.log('Done.')
}

main().catch(err => { console.error(err); process.exit(1) })
