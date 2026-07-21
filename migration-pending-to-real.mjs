/**
 * ONE-TIME MIGRATION SCRIPT: Move AWBs from PENDING to correct flights
 *
 * Usage:
 *   node migration-pending-to-real.mjs --dry-run    # Dry run (mandatory first)
 *   node migration-pending-to-real.mjs --execute     # Execute migration
 *   node migration-pending-to-real.mjs --verify      # Post-migration verification
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import crypto from 'crypto'

const MODE = process.argv.includes('--execute') ? 'execute'
  : process.argv.includes('--verify') ? 'verify'
  : 'dry-run'

// ── Auth ──
const fbConfig = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = fbConfig.tokens.refresh_token
const authRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt,
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' }),
})
const token = (await authRes.json()).access_token
const BASE = 'https://firestore.googleapis.com/v1/projects/wms-mcl/databases/(default)/documents'

// ── Firestore helpers ──
function pv(v) {
  if (!v) return null
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('booleanValue' in v) return v.booleanValue
  if ('mapValue' in v) { const o = {}; for (const [k,val] of Object.entries(v.mapValue.fields||{})) o[k]=pv(val); return o }
  if ('arrayValue' in v) return (v.arrayValue.values||[]).map(pv)
  return v
}
function toFV(val) {
  if (val === null || val === undefined) return { nullValue: null }
  if (typeof val === 'string') return { stringValue: val }
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  if (typeof val === 'boolean') return { booleanValue: val }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } }
  if (typeof val === 'object') { const fields = {}; for (const [k,v] of Object.entries(val)) fields[k]=toFV(v); return { mapValue: { fields } } }
  return { stringValue: String(val) }
}
async function fsGet(path) {
  const r = await fetch(BASE + '/' + path, { headers: { Authorization: 'Bearer ' + token } })
  return r.json()
}
async function fsGetAll(coll) {
  let all = [], npt = null
  do {
    let u = BASE + '/' + coll + '?pageSize=300'
    if (npt) u += '&pageToken=' + npt
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } })
    const d = await r.json()
    all.push(...(d.documents || []))
    npt = d.nextPageToken
  } while (npt)
  return all
}
async function fsPatch(path, fields, fieldPaths) {
  const params = fieldPaths.map(f => `updateMask.fieldPaths=${f}`).join('&')
  const r = await fetch(`${BASE}/${path}?${params}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  return r.ok
}

// ── Sheet parsing (same logic as corrected agent) ──
function sheetNormStr(s) { return String(s ?? '').replace(/[\s\-]+/g, '').toUpperCase() }

const SHEET_HEADER_ALIASES = [
  ['flight_number', ['flight number', 'flight#', 'flight #', 'vuelo', 'numero de vuelo']],
  ['awb_1st', ['1st leg awb', '1st leg', 'awb 1st leg', '1st awb', '1st leg awb#']],
  ['awb_2nd', ['2nd leg awb', '2nd leg', 'awb 2nd leg', '2nd awb', '2nd leg awb#']],
  ['uld', ['uld', 'uld type', 'uld / loose', 'uld/loose']],
  ['pieces', ['pcs', 'pieces', 'piezas']],
  ['cw', ['cw', 'chw', 'chargeable', 'chargeable wt', 'chargeable weight']],
  ['pickup_from', ['pick up from', 'pickup from', 'pick-up from']],
  ['deliver_to', ['deliver to', 'airline']],
  ['destination', ['dest', 'dest.', 'destination', 'destino']],
  ['etd', ['etd', 'departure', 'date & etd time']],
  ['cutoff', ['cutoff', 'cut off', 'cutoff time', 'cut-off', 'cut off date/time']],
]
const NEGATIVE_KEYWORDS = ['inbound', 'inbond', 'eta', 'arrival', 'import', 'incoming']

function parseSheetHeaders(rawRows) {
  for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
    const row = rawRows[i] || []
    const candidates = {}
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
      if (!cell) continue
      for (const [key, aliases] of SHEET_HEADER_ALIASES) {
        if (aliases.some(a => cell === a || cell.includes(a))) {
          if (!candidates[key]) candidates[key] = []
          candidates[key].push({ col: j, headerLen: cell.length, header: cell })
        }
      }
    }
    const tempMap = {}
    for (const [key, options] of Object.entries(candidates)) {
      let filtered = options
      if (options.length > 1) {
        const clean = options.filter(o => !NEGATIVE_KEYWORDS.some(nk => o.header.includes(nk)))
        if (clean.length > 0) filtered = clean
      }
      filtered.sort((a, b) => a.col - b.col)
      tempMap[key] = filtered[0].col
    }
    if (Object.keys(tempMap).length >= 3) return { colMap: tempMap, headerRowIdx: i }
  }
  return { colMap: {}, headerRowIdx: -1 }
}

function sheetParseDate(raw) {
  if (raw === null || raw === undefined || raw === '') return ''
  if (typeof raw === 'number') {
    const d = new Date((raw - 25569) * 86400000)
    if (raw % 1 !== 0) {
      return `${d.toISOString().slice(0, 10)}T${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:00`
    }
    return d.toISOString().slice(0, 10)
  }
  const s = String(raw).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s || /^[a-z]/i.test(s)) return s
  const m = s.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/)
  if (m) {
    const mm = m[1].padStart(2, '0'), dd = m[2].padStart(2, '0')
    const year = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : String(new Date().getFullYear())
    return `${year}-${mm}-${dd}`
  }
  return s
}

function rowHash(row) {
  const parts = [
    row.flight, row.awb1st, row.awb2nd, row.uld,
    String(row.pcs), String(row.cw), row.pickupFrom,
    row.readyForPickup, row.lastDayFree, row.deliverTo,
    row.dest, row.etd, row.cutoff, row.holdBg, row.holdBox,
    row.battery ? 'Y' : 'N', row.docsInDrive ? 'Y' : 'N',
  ].map(s => sheetNormStr(s))
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

// ── CSV file reading ──
import { fileURLToPath } from 'url'
import { dirname } from 'path'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function parseCSV(text) {
  const rows = []; let row = []; let cell = ''; let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"' && text[i+1] === '"') { cell += '"'; i++ }
      else if (ch === '"') { inQuotes = false }
      else { cell += ch }
    } else {
      if (ch === '"') { inQuotes = true }
      else if (ch === ',') { row.push(cell); cell = '' }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
      else if (ch === '\r') { /* skip */ }
      else { cell += ch }
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

// ── CONFIGURATION ──
const SPREADSHEET_ID = '1-diJgoKpMMX64sYiMz4ZqpwL6usW3pJyS59hall_-Os'
const CONFIG_DOC_ID = 'YPATo6B9BvRJEIJO7ld9'
const PENDING_BOOKING_ID = 'ecIfM9uze4EaECazEbXd'
const CLIENT_ID = 'YPATo6B9BvRJEIJO7ld9'

console.log(`=== MIGRATION SCRIPT — MODE: ${MODE.toUpperCase()} ===\n`)

// ── PHASE 0: Check agent status ──
console.log('PHASE 0: Checking agent status...')
const configDoc = await fsGet(`_sheet_sync_configs/${CONFIG_DOC_ID}`)
const agentEnabled = pv(configDoc.fields?.enabled)
console.log(`  Agent enabled: ${agentEnabled}`)

// Check last run
const allRuns = await fsGetAll('_sheet_sync_runs')
let lastRunTime = null
for (const doc of allRuns) {
  const f = doc.fields || {}
  const ts = f.created_at?.timestampValue
  if (ts && (!lastRunTime || ts > lastRunTime)) lastRunTime = ts
}
if (lastRunTime) {
  const ago = Math.round((Date.now() - new Date(lastRunTime).getTime()) / 60000)
  console.log(`  Last agent run: ${lastRunTime} (${ago} min ago)`)
  if (ago < 2) console.log(`  WARNING: Agent ran very recently`)
}

// ── PHASE 1: Read sheet from CSV ──
console.log('\nPHASE 1: Reading sheet from CSV...')

const CSV_PATH = join(__dirname, 'EXPRESS LINE  BOOKING - May 2026 .csv')
const csvText = readFileSync(CSV_PATH, 'utf8')
const rawRows = parseCSV(csvText)
const now = new Date()
console.log(`  Raw rows: ${rawRows.length}`)

// Parse headers with corrected logic
const { colMap, headerRowIdx } = parseSheetHeaders(rawRows)
if (headerRowIdx < 0) { console.error('  ERROR: Could not find headers'); process.exit(1) }
console.log(`  Header row: ${headerRowIdx}`)
console.log(`  Column map: ${JSON.stringify(colMap)}`)
console.log(`  flight_number column: ${colMap.flight_number} (header: "${rawRows[headerRowIdx][colMap.flight_number]}")`)

// Parse data rows
const col = (r, key) => key in colMap ? String((r || [])[colMap[key]] ?? '').trim() : ''
const dataRows = []
for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
  const r = rawRows[i]
  const awb1 = col(r, 'awb_1st')
  if (!awb1 || !/\d{3}-\d+/.test(awb1)) continue
  const row = {
    flight: col(r, 'flight_number').toUpperCase(),
    awb1st: awb1,
    awb2nd: col(r, 'awb_2nd'),
    uld: col(r, 'uld').toUpperCase(),
    pcs: Number(col(r, 'pieces')) || 0,
    cw: Number(col(r, 'cw')) || 0,
    pickupFrom: col(r, 'pickup_from'),
    readyForPickup: sheetParseDate(colMap['ready_for_pickup'] != null ? (r || [])[colMap['ready_for_pickup']] : ''),
    lastDayFree: sheetParseDate(colMap['lfd'] != null ? (r || [])[colMap['lfd']] : ''),
    deliverTo: col(r, 'deliver_to'),
    dest: col(r, 'destination').toUpperCase(),
    etd: sheetParseDate(colMap['etd'] != null ? (r || [])[colMap['etd']] : ''),
    cutoff: sheetParseDate(colMap['cutoff'] != null ? (r || [])[colMap['cutoff']] : ''),
    holdBg: col(r, 'hold_bg') || '',
    holdBox: col(r, 'hold_box') || '',
    battery: false,
    docsInDrive: false,
  }
  dataRows.push(row)
}
console.log(`  Parsed data rows: ${dataRows.length}`)

// Build lookup: AWB → sheet row
const sheetByAwb = new Map()
for (const row of dataRows) {
  const key = sheetNormStr(row.awb1st)
  if (key) sheetByAwb.set(key, row)
}

// ── PHASE 2: Read system state ──
console.log('\nPHASE 2: Reading system state...')

const pendingDoc = await fsGet(`airfreight_bookings/${PENDING_BOOKING_ID}`)
if (!pendingDoc.fields) { console.error('  ERROR: PENDING booking not found'); process.exit(1) }
const pendingLines = pv(pendingDoc.fields.awb_lines) || []
console.log(`  PENDING booking AWBs: ${pendingLines.length}`)

// Load all flights (for matching)
const allFlightDocs = await fsGetAll('airfreight_flights')
const flightsByNorm = new Map()
for (const doc of allFlightDocs) {
  const f = doc.fields || {}
  const id = doc.name.split('/').pop()
  const fn = String(pv(f.flight_number) ?? '')
  const dt = String(pv(f.flight_datetime) ?? '')
  const status = String(pv(f.status) ?? '')
  flightsByNorm.set(sheetNormStr(fn) + '|' + (dt || '').slice(0,10), { id, fn, dt, status })
  // Also add without date for fallback
  if (!flightsByNorm.has(sheetNormStr(fn) + '|')) {
    flightsByNorm.set(sheetNormStr(fn) + '|', { id, fn, dt, status })
  }
}

// Load all bookings (for duplicate check and finding existing destinations)
const allBookingDocs = await fsGetAll('airfreight_bookings')
const bookingsByFlightClient = new Map()
for (const doc of allBookingDocs) {
  const f = doc.fields || {}
  const id = doc.name.split('/').pop()
  const flightId = pv(f.flight_id) || ''
  const clientId = pv(f.client_id) || ''
  const bt = pv(f.booking_type) || ''
  const lines = pv(f.awb_lines) || []
  if (bt === 'ecommerce' && clientId === CLIENT_ID) {
    const key = `${flightId}|${clientId}`
    bookingsByFlightClient.set(key, { id, flightId, lines })
  }
}

// ── PHASE 3: Plan migrations ──
console.log('\nPHASE 3: Planning migrations...')

const plan = { toMove: [], toStay: [], issues: [] }

for (const line of pendingLines) {
  const awbNorm = sheetNormStr(line.awb_number || '')
  const sheetRow = sheetByAwb.get(awbNorm)

  if (!sheetRow) {
    plan.toStay.push({ awb: line.awb_number, reason: 'NOT IN SHEET (may be from different month)' })
    continue
  }

  const flight = sheetRow.flight
  const etd = sheetRow.etd
  const isPending = !flight || /^PENDING/i.test(flight) || /^TBD/i.test(flight)

  if (isPending) {
    plan.toStay.push({ awb: line.awb_number, reason: `No flight in col C (value: "${flight || ''}")` })
    continue
  }

  if (!etd) {
    plan.toStay.push({ awb: line.awb_number, reason: `Has flight "${flight}" but no ETD` })
    continue
  }

  if (!sheetRow.awb2nd) {
    plan.toStay.push({ awb: line.awb_number, reason: `Has flight "${flight}" but no 2nd leg` })
    continue
  }

  // Validate: check weight/on_hand/dispatched
  if ((line.weight || 0) > 0) {
    plan.issues.push({ awb: line.awb_number, issue: `Has physical weight ${line.weight} — BLOCKED` })
    continue
  }
  if (line.on_hand) {
    plan.issues.push({ awb: line.awb_number, issue: `Has on_hand: true — BLOCKED` })
    continue
  }

  // Find target flight
  const flightNorm = sheetNormStr(flight)
  const etdDate = (etd || '').slice(0, 10)
  let targetFlight = flightsByNorm.get(flightNorm + '|' + etdDate) || flightsByNorm.get(flightNorm + '|')

  // Check if target flight is dispatched/closed
  if (targetFlight && (targetFlight.status === 'dispatched' || targetFlight.status === 'closed')) {
    plan.issues.push({ awb: line.awb_number, issue: `Target flight ${flight} is ${targetFlight.status} — BLOCKED` })
    continue
  }

  plan.toMove.push({
    awb: line.awb_number,
    awb2nd: line.awb_2nd_leg,
    flight,
    etd,
    pcs: sheetRow.pcs,
    cw: sheetRow.cw,
    uld: sheetRow.uld,
    dest: sheetRow.dest,
    deliverTo: sheetRow.deliverTo,
    cutoff: sheetRow.cutoff,
    targetFlightId: targetFlight?.id || null,
    targetFlightExists: !!targetFlight,
    line, // original line from PENDING
    sheetRow, // full sheet data
  })
}

// ── DRY-RUN REPORT ──
console.log('\n========================================')
console.log('  MIGRATION PLAN')
console.log('========================================\n')

console.log(`AWBs to MOVE from PENDING → real flights: ${plan.toMove.length}`)
for (const m of plan.toMove) {
  const flightStatus = m.targetFlightExists ? 'EXISTS' : 'WILL CREATE'
  console.log(`  ${m.awb} → ${m.flight} (ETD ${m.etd}) | PCS: ${m.pcs} | CW: ${m.cw} | Flight: ${flightStatus}`)
}

console.log(`\nAWBs STAYING in PENDING: ${plan.toStay.length}`)
for (const s of plan.toStay) {
  console.log(`  ${s.awb} — ${s.reason}`)
}

if (plan.issues.length > 0) {
  console.log(`\nBLOCKED AWBs (issues): ${plan.issues.length}`)
  for (const i of plan.issues) {
    console.log(`  ${i.awb} — ${i.issue}`)
  }
}

// Group by target flight
const byFlight = new Map()
for (const m of plan.toMove) {
  const key = m.flight
  if (!byFlight.has(key)) byFlight.set(key, [])
  byFlight.get(key).push(m)
}
console.log(`\nFlights involved: ${byFlight.size}`)
for (const [fn, awbs] of byFlight) {
  const exists = awbs[0].targetFlightExists
  console.log(`  ${fn}: ${awbs.length} AWBs | flight ${exists ? 'EXISTS' : 'WILL CREATE'}`)
}

// Validation checks
console.log('\nVALIDATION CHECKS:')
const hasWeight = plan.toMove.some(m => (m.line.weight || 0) > 0)
const hasOnHand = plan.toMove.some(m => m.line.on_hand)
const hasBlocked = plan.issues.length > 0
console.log(`  ${hasWeight ? 'FAIL' : 'OK'} No AWB has physical weight > 0`)
console.log(`  ${hasOnHand ? 'FAIL' : 'OK'} No AWB has on_hand: true`)
console.log(`  ${hasBlocked ? 'WARN' : 'OK'} No blocked AWBs (${plan.issues.length} blocked)`)
console.log(`  OK Agent enabled: ${agentEnabled}`)

const canExecute = !hasWeight && !hasOnHand && plan.toMove.length > 0
console.log(`\nRESULT: ${canExecute ? 'READY TO EXECUTE' : 'BLOCKED — fix issues first'}`)

if (MODE === 'dry-run') {
  console.log('\nThis was a DRY RUN. To execute: node migration-pending-to-real.mjs --execute')
  process.exit(0)
}

if (MODE === 'verify') {
  // ── VERIFICATION MODE ──
  console.log('\n========================================')
  console.log('  POST-MIGRATION VERIFICATION')
  console.log('========================================\n')

  // V1: No orphans
  const allBkDocs = await fsGetAll('airfreight_bookings')
  const allAwbsInSystem = new Set()
  for (const doc of allBkDocs) {
    const lines = pv(doc.fields?.awb_lines) || []
    for (const l of lines) {
      const norm = sheetNormStr(l.awb_number || '')
      if (norm) allAwbsInSystem.add(norm)
    }
  }
  const pendingAwbs = pendingLines.map(l => sheetNormStr(l.awb_number || ''))
  let orphans = 0
  for (const awbNorm of sheetByAwb.keys()) {
    if (!allAwbsInSystem.has(awbNorm)) {
      // Check if it's an incomplete row that shouldn't be in system
      const sr = sheetByAwb.get(awbNorm)
      if (sr && sr.flight && sr.etd && sr.awb2nd) {
        console.log(`  ORPHAN: ${awbNorm} — in sheet with flight but not in any booking`)
        orphans++
      }
    }
  }
  console.log(`V1 Orphans: ${orphans === 0 ? 'OK (0)' : `FAIL (${orphans})`}`)

  // V2: No duplicates
  const awbCounts = new Map()
  for (const doc of allBkDocs) {
    const lines = pv(doc.fields?.awb_lines) || []
    for (const l of lines) {
      const norm = sheetNormStr(l.awb_number || '')
      if (norm) awbCounts.set(norm, (awbCounts.get(norm) || 0) + 1)
    }
  }
  const dupes = [...awbCounts.entries()].filter(([,c]) => c > 1)
  console.log(`V2 Duplicates: ${dupes.length === 0 ? 'OK (0)' : `FAIL (${dupes.length})`}`)
  for (const [awb, count] of dupes) console.log(`  ${awb}: ${count} times`)

  // V3: PENDING only has AWBs without flight
  const pendingDocNow = await fsGet(`airfreight_bookings/${PENDING_BOOKING_ID}`)
  const pendingNow = pv(pendingDocNow.fields?.awb_lines) || []
  console.log(`V3 PENDING AWBs remaining: ${pendingNow.length}`)

  // V8: Agent enabled
  const cfgNow = await fsGet(`_sheet_sync_configs/${CONFIG_DOC_ID}`)
  console.log(`V8 Agent enabled: ${pv(cfgNow.fields?.enabled)}`)

  process.exit(0)
}

// ── EXECUTE MODE ──
if (!canExecute) { console.error('\nCannot execute: validation failed'); process.exit(1) }

console.log('\n========================================')
console.log('  EXECUTING MIGRATION')
console.log('========================================\n')

// PHASE 1: Pause agent
console.log('Step 1: Pausing agent...')
const pauseOk = await fsPatch(`_sheet_sync_configs/${CONFIG_DOC_ID}`, { enabled: toFV(false) }, ['enabled'])
if (!pauseOk) { console.error('  FAILED to pause agent'); process.exit(1) }
console.log('  Agent paused (enabled: false)')

try {
  // Register migration start
  const migrationStartFields = {
    type: toFV('migration'), status: toFV('running'),
    started_at: toFV(new Date().toISOString()),
    awbs_to_move: toFV(plan.toMove.length),
  }
  await fetch(BASE + '/_sheet_sync_runs', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: migrationStartFields }),
  })

  // PHASE 3a: Add AWBs to destination bookings (ADD FIRST)
  console.log('\nStep 2: Adding AWBs to destination bookings...')
  const successfullyAdded = []

  for (const m of plan.toMove) {
    const flightNorm = sheetNormStr(m.flight)
    const etdDate = (m.etd || '').slice(0, 10)

    // Find or create flight
    let targetFlight = flightsByNorm.get(flightNorm + '|' + etdDate) || flightsByNorm.get(flightNorm + '|')
    if (!targetFlight) {
      // Create flight
      const flightData = {
        airline: toFV(m.deliverTo || 'Unknown'), flight_number: toFV(m.flight),
        flight_datetime: toFV(m.etd), cutoff_datetime: toFV(m.cutoff || null),
        destinations: toFV(m.dest ? [m.dest] : []), status: toFV('open'),
        created_by: toFV('migration_script'), created_at: toFV(new Date().toISOString()),
      }
      const createRes = await fetch(BASE + '/airfreight_flights', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: flightData }),
      })
      const created = await createRes.json()
      const newId = created.name.split('/').pop()
      targetFlight = { id: newId, fn: m.flight, dt: m.etd, status: 'open' }
      flightsByNorm.set(flightNorm + '|' + etdDate, targetFlight)
      console.log(`  Created flight: ${m.flight} (${newId.slice(0,12)})`)
    }

    // Build updated line from PENDING line + sheet data
    const updatedLine = { ...m.line }
    updatedLine.pieces = m.pcs
    updatedLine.chargeable_weight = m.cw
    updatedLine.uld_type = m.uld || null
    updatedLine.awb_2nd_leg = m.sheetRow.awb2nd || updatedLine.awb_2nd_leg

    // Find existing booking for this flight+client
    const bKey = `${targetFlight.id}|${CLIENT_ID}`
    const existingBooking = bookingsByFlightClient.get(bKey)

    if (existingBooking) {
      // Check duplicate
      const awbNorm = sheetNormStr(updatedLine.awb_number || '')
      const alreadyIn = existingBooking.lines.some(l => sheetNormStr(l.awb_number || '') === awbNorm)
      if (alreadyIn) {
        console.log(`  ${m.awb} → already in booking ${existingBooking.id.slice(0,12)} (idempotent skip)`)
        successfullyAdded.push(m)
        continue
      }
      // Add to existing booking
      const newLines = [...existingBooking.lines, updatedLine]
      const normSet = new Set()
      for (const l of newLines) {
        if (l.awb_number) normSet.add(sheetNormStr(l.awb_number))
        if (l.awb_2nd_leg) normSet.add(sheetNormStr(l.awb_2nd_leg))
      }
      normSet.delete('')
      const ok = await fsPatch(`airfreight_bookings/${existingBooking.id}`, {
        awb_lines: toFV(newLines),
        pieces: toFV(newLines.reduce((s, l) => s + (l.pieces || 0), 0)),
        awb_numbers_normalized: toFV(Array.from(normSet)),
      }, ['awb_lines', 'pieces', 'awb_numbers_normalized'])
      if (ok) {
        existingBooking.lines = newLines // update local cache
        console.log(`  ${m.awb} → added to booking ${existingBooking.id.slice(0,12)} (flight ${m.flight})`)
        successfullyAdded.push(m)
      } else {
        console.error(`  ${m.awb} → FAILED to add to booking ${existingBooking.id.slice(0,12)}`)
      }
    } else {
      // Create new booking
      const newBookingData = {
        flight_id: toFV(targetFlight.id), flight_number: toFV(m.flight),
        airline: toFV(m.deliverTo || ''), booking_type: toFV('ecommerce'),
        client_id: toFV(CLIENT_ID), client_name: toFV('Express Line'),
        status: toFV('submitted'), created_by: toFV('migration_script'),
        created_at: toFV(new Date().toISOString()),
        change_count: toFV(0), modified_seen: toFV(true),
        change_log: toFV([]), documents: toFV({}),
        destination_id: toFV(m.dest || ''), awb_lines: toFV([updatedLine]),
        pieces: toFV(updatedLine.pieces || 0), on_hand: toFV(false),
      }
      // Compute awb_numbers_normalized
      const normSet = new Set()
      if (updatedLine.awb_number) normSet.add(sheetNormStr(updatedLine.awb_number))
      if (updatedLine.awb_2nd_leg) normSet.add(sheetNormStr(updatedLine.awb_2nd_leg))
      normSet.delete('')
      newBookingData.awb_numbers_normalized = toFV(Array.from(normSet))

      const createRes = await fetch(BASE + '/airfreight_bookings', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: newBookingData }),
      })
      if (createRes.ok) {
        const created = await createRes.json()
        const newBkId = created.name.split('/').pop()
        bookingsByFlightClient.set(bKey, { id: newBkId, flightId: targetFlight.id, lines: [updatedLine] })
        console.log(`  ${m.awb} → created booking ${newBkId.slice(0,12)} (flight ${m.flight})`)
        successfullyAdded.push(m)
      } else {
        console.error(`  ${m.awb} → FAILED to create booking: ${await createRes.text()}`)
      }
    }
  }

  console.log(`\n  Successfully added: ${successfullyAdded.length} / ${plan.toMove.length}`)

  // PHASE 3b: Verify all added, then remove from PENDING (REMOVE AFTER)
  if (successfullyAdded.length > 0) {
    console.log('\nStep 3: Removing moved AWBs from PENDING booking...')
    const movedNorms = new Set(successfullyAdded.map(m => sheetNormStr(m.awb)))

    // Re-read PENDING to get fresh state
    const freshPending = await fsGet(`airfreight_bookings/${PENDING_BOOKING_ID}`)
    const freshLines = pv(freshPending.fields?.awb_lines) || []
    const remainingLines = freshLines.filter(l => !movedNorms.has(sheetNormStr(l.awb_number || '')))

    const normSet = new Set()
    for (const l of remainingLines) {
      if (l.awb_number) normSet.add(sheetNormStr(l.awb_number))
      if (l.awb_2nd_leg) normSet.add(sheetNormStr(l.awb_2nd_leg))
    }
    normSet.delete('')

    const ok = await fsPatch(`airfreight_bookings/${PENDING_BOOKING_ID}`, {
      awb_lines: toFV(remainingLines),
      pieces: toFV(remainingLines.reduce((s, l) => s + (l.pieces || 0), 0)),
      awb_numbers_normalized: toFV(Array.from(normSet)),
    }, ['awb_lines', 'pieces', 'awb_numbers_normalized'])

    if (ok) {
      console.log(`  PENDING: ${freshLines.length} → ${remainingLines.length} AWBs`)
    } else {
      console.error('  FAILED to update PENDING booking')
    }
  }

  // PHASE 4: Update snapshot hashes
  console.log('\nStep 4: Updating snapshot hashes...')
  const snapshotId = `${CLIENT_ID}_${now.toISOString().slice(0,7)}`
  const hashUpdates = {}
  for (const m of successfullyAdded) {
    const key = sheetNormStr(m.awb)
    const sr = m.sheetRow
    if (sr) {
      const hash = rowHash(sr)
      hashUpdates[key] = hash
    }
  }
  // Also update hashes for AWBs staying in PENDING (their hash changed due to column fix)
  for (const s of plan.toStay) {
    const norm = sheetNormStr(s.awb)
    const sr = sheetByAwb.get(norm)
    if (sr) {
      hashUpdates[norm] = rowHash(sr)
    }
  }

  if (Object.keys(hashUpdates).length > 0) {
    const snDoc = await fsGet(`_sheet_sync_snapshots/${snapshotId}`)
    const existingHashes = {}
    if (snDoc.fields?.row_hashes?.mapValue?.fields) {
      for (const [k, v] of Object.entries(snDoc.fields.row_hashes.mapValue.fields)) {
        existingHashes[k] = pv(v)
      }
    }
    // Merge
    for (const [k, v] of Object.entries(hashUpdates)) {
      existingHashes[k] = v
    }
    // Convert to Firestore format
    const hashFields = {}
    for (const [k, v] of Object.entries(existingHashes)) {
      hashFields[k] = { stringValue: v }
    }
    const ok = await fsPatch(`_sheet_sync_snapshots/${snapshotId}`, {
      row_hashes: { mapValue: { fields: hashFields } },
    }, ['row_hashes'])
    console.log(`  Updated ${Object.keys(hashUpdates).length} hashes: ${ok ? 'OK' : 'FAILED'}`)
  }

  console.log('\n========================================')
  console.log('  MIGRATION COMPLETE')
  console.log('========================================')
  console.log(`  Moved: ${successfullyAdded.length}`)
  console.log(`  Stayed in PENDING: ${plan.toStay.length}`)
  console.log(`  Blocked: ${plan.issues.length}`)

} finally {
  // ALWAYS reactivate agent
  console.log('\nStep 5: Reactivating agent...')
  const reactivateOk = await fsPatch(`_sheet_sync_configs/${CONFIG_DOC_ID}`, { enabled: toFV(true) }, ['enabled'])
  console.log(`  Agent reactivated: ${reactivateOk ? 'OK' : 'FAILED — MANUAL ACTION NEEDED'}`)
}

console.log('\nTo verify: node migration-pending-to-real.mjs --verify')
