#!/usr/bin/env node
/**
 * FIX: Renumber WS invoices from 0031 onwards to close gaps left by deleted duplicates.
 *
 * Remap:
 *   WS-INV-0031 → WS-INV-0030
 *   WS-INV-0032 → WS-INV-0031
 *   WS-INV-0033 → WS-INV-0032
 *   WS-INV-0039 → WS-INV-0033
 *   WS-INV-0040 → WS-INV-0034
 *
 * Updates: ws_invoices.invoice_number, ws_billing_charges.invoice_number,
 *          config/ws_invoice_sequence.last_num → 34
 *
 * Usage: node scripts/fix-invoice-sequence.mjs [--dry-run]
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
      grant_type: 'refresh_token', refresh_token: rt,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('Auth failed: ' + JSON.stringify(data))
  return data.access_token
}

// ── Firestore helpers ─────────────────────────────────────────────────────

async function fetchAll(TOKEN, collName) {
  const docs = []
  let pageToken = ''
  while (true) {
    const url = `${BASE}/${collName}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
    const data = await res.json()
    if (data.documents) {
      for (const d of data.documents) {
        docs.push({ id: d.name.split('/').pop(), fields: d.fields || {} })
      }
    }
    if (data.nextPageToken) pageToken = data.nextPageToken
    else break
  }
  return docs
}

async function patchFields(TOKEN, collection, docId, updates) {
  const fields = {}
  for (const [k, v] of Object.entries(updates)) {
    if (typeof v === 'number') fields[k] = { integerValue: String(v) }
    else fields[k] = { stringValue: v }
  }
  const mask = Object.keys(updates).map(k => `updateMask.fieldPaths=${k}`).join('&')
  const url = `${BASE}/${collection}/${docId}?${mask}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`PATCH ${collection}/${docId}: ${res.status} ${await res.text()}`)
}

// ── Main ──────────────────────────────────────────────────────────────────

const REMAP = {
  'WS-INV-0031': 'WS-INV-0030',
  'WS-INV-0032': 'WS-INV-0031',
  'WS-INV-0033': 'WS-INV-0032',
  'WS-INV-0039': 'WS-INV-0033',
  'WS-INV-0040': 'WS-INV-0034',
}
const NEW_LAST_NUM = 34

async function main() {
  const TOKEN = await getAccessToken()
  if (DRY_RUN) console.log('=== DRY RUN ===\n')

  // 1. Rename invoices
  console.log('--- STEP 1: Rename ws_invoices ---')
  const invoices = await fetchAll(TOKEN, 'ws_invoices')
  for (const inv of invoices) {
    const oldNum = (inv.fields.invoice_number || {}).stringValue || ''
    if (!REMAP[oldNum]) continue
    const newNum = REMAP[oldNum]
    console.log(`  ${oldNum} → ${newNum}  (${inv.id.slice(0, 8)})`)
    if (!DRY_RUN) {
      await patchFields(TOKEN, 'ws_invoices', inv.id, { invoice_number: newNum })
    }
  }

  // 2. Update billing charges that reference old invoice numbers
  console.log('\n--- STEP 2: Update ws_billing_charges ---')
  const charges = await fetchAll(TOKEN, 'ws_billing_charges')
  let chargesUpdated = 0
  for (const ch of charges) {
    const oldNum = (ch.fields.invoice_number || {}).stringValue || ''
    if (!REMAP[oldNum]) continue
    const newNum = REMAP[oldNum]
    console.log(`  Charge ${ch.id.slice(0, 8)}: ${oldNum} → ${newNum}`)
    if (!DRY_RUN) {
      await patchFields(TOKEN, 'ws_billing_charges', ch.id, { invoice_number: newNum })
    }
    chargesUpdated++
  }
  console.log(`  ${chargesUpdated} charges updated`)

  // 3. Reset sequence counter
  console.log(`\n--- STEP 3: Reset sequence counter to ${NEW_LAST_NUM} ---`)
  if (!DRY_RUN) {
    await patchFields(TOKEN, 'config', 'ws_invoice_sequence', { last_num: NEW_LAST_NUM })
  }
  console.log(`  last_num → ${NEW_LAST_NUM}`)

  console.log('\nDone.' + (DRY_RUN ? ' (dry-run, no changes made)' : ''))
}

main().catch(err => { console.error(err); process.exit(1) })
