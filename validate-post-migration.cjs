/**
 * Post-migration validation script.
 * Checks integrity, duplicates, junk flights, and samples for mini-QA.
 */
const fs = require('fs')
const path = require('path')

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'express-line-export.json'), 'utf8'))
const backup = JSON.parse(fs.readFileSync(path.join(__dirname, 'migration-backup.json'), 'utf8'))

const flights = data.flights
const bookings = data.bookings

function flightMatchKey(raw) {
  let s = (raw || '').trim().toUpperCase()
  s = s.replace(/\s+(A\d+|PAX|CAO|LOOSE|CARGO)$/, '')
  return s.replace(/[\s\-]/g, '')
}

console.log('='.repeat(80))
console.log('VALIDACION POST-MIGRACION')
console.log('='.repeat(80))

// ── 1. VUELO BASURA ──
console.log('\n--- 1. VUELO BASURA ---')
const junkFlights = flights.filter(f => (f.flight_number || '').length > 15 || (f.flight_number || '').includes('9950'))
for (const f of junkFlights) {
  console.log(`  ID: ${f.id}`)
  console.log(`  flight_number: "${f.flight_number}"`)
  console.log(`  airline: "${f.airline}"`)
  console.log(`  ETD: ${f.flight_datetime}`)
  console.log(`  destinations: [${(f.destinations || []).join(', ')}]`)
  console.log(`  status: ${f.status}`)
  console.log(`  created_by: ${f.created_by}`)
  const linked = bookings.filter(b => b.flight_id === f.id)
  console.log(`  Bookings linked: ${linked.length}`)
  for (const b of linked) {
    console.log(`    Booking ${b.id}: ${(b.awb_lines || []).length} AWBs, dest=${b.destination_id}, status=${b.status}`)
    for (const l of (b.awb_lines || [])) {
      console.log(`      AWB: ${l.awb_number} → ${l.awb_2nd_leg || '(none)'} | PCS:${l.pieces} CW:${l.chargeable_weight} | hold:${l.hold} | dispatched:${l.dispatched}`)
    }
  }
}

// ── 2. INTEGRIDAD POST-MIGRACION ──
console.log('\n--- 2. INTEGRIDAD ---')

// 2a. Flights huérfanos (no tienen bookings)
const flightsWithBookings = new Set(bookings.map(b => b.flight_id))
const mayOrphanFlights = flights.filter(f =>
  !flightsWithBookings.has(f.id) && (f.flight_datetime || '').startsWith('2026-05')
)
console.log(`  Flights Mayo sin bookings: ${mayOrphanFlights.length}`)
for (const f of mayOrphanFlights) {
  console.log(`    ${f.id}: ${f.flight_number} ETD:${f.flight_datetime} by:${f.created_by}`)
}

// 2b. Bookings sin AWBs
const emptyBookings = bookings.filter(b => !b.awb_lines || b.awb_lines.length === 0)
console.log(`  Bookings sin AWBs: ${emptyBookings.length}`)
for (const b of emptyBookings) {
  console.log(`    ${b.id}: flight=${b.flight_id} dest=${b.destination_id}`)
}

// 2c. Destinos con sufijos residuales
const allDests = new Set()
for (const b of bookings) allDests.add(b.destination_id || '')
for (const f of flights) {
  if ((f.flight_datetime || '').startsWith('2026-05')) {
    for (const d of (f.destinations || [])) allDests.add(d)
  }
}
const badDests = [...allDests].filter(d => /\s+(LOOSE|PAX|CAO|CARGO)$/i.test(d))
console.log(`  Destinos con sufijos residuales (Mayo): ${badDests.length}`)
for (const d of badDests) console.log(`    "${d}"`)

// 2d. Holds inconsistentes (hold=true but no holds array, or hold=false but has holds)
let holdInconsistent = 0
for (const b of bookings) {
  const f = flights.find(fl => fl.id === b.flight_id)
  if (!f || !(f.flight_datetime || '').startsWith('2026-05')) continue
  for (const l of (b.awb_lines || [])) {
    if (l.hold === true && (!l.holds || l.holds.length === 0)) {
      holdInconsistent++
    }
  }
}
console.log(`  Holds inconsistentes (hold=true, holds=[]): ${holdInconsistent}`)

// 2e. ULD con valores corruptos
let uldCorrupt = 0
for (const b of bookings) {
  const f = flights.find(fl => fl.id === b.flight_id)
  if (!f || !(f.flight_datetime || '').startsWith('2026-05')) continue
  for (const l of (b.awb_lines || [])) {
    const uld = l.uld_type || ''
    if (uld.includes('\n') || uld.includes('\r') || uld.includes('BUP OR')) {
      uldCorrupt++
      console.log(`    CORRUPT ULD: ${l.awb_number} = "${uld}"`)
    }
  }
}
console.log(`  ULDs corruptos: ${uldCorrupt}`)

// 2f. Vuelos duplicados Mayo (mismo flightMatchKey + ETD date)
const mayFlights = flights.filter(f => (f.flight_datetime || '').startsWith('2026-05'))
const flightGroups = {}
for (const f of mayFlights) {
  const key = flightMatchKey(f.flight_number) + '|' + (f.flight_datetime || '').slice(0, 10)
  if (!flightGroups[key]) flightGroups[key] = []
  flightGroups[key].push(f)
}
const dupes = Object.entries(flightGroups).filter(([, g]) => g.length > 1)
console.log(`  Vuelos duplicados Mayo: ${dupes.length}`)
for (const [key, group] of dupes) {
  console.log(`    ${key}: ${group.map(f => f.id).join(', ')}`)
}

// 2g. AWBs de Abril modificados (check backup)
const aprilBookingIds = bookings
  .filter(b => {
    const f = flights.find(fl => fl.id === b.flight_id)
    return f && (f.flight_datetime || '').startsWith('2026-04')
  })
  .map(b => b.id)
const modifiedApril = aprilBookingIds.filter(id => backup.bookings && backup.bookings[id])
console.log(`  Bookings Abril en backup (modificados): ${modifiedApril.length}`)

// 2h. AWBs despachados modificados
let dispatchedModified = 0
for (const [bid, fields] of Object.entries(backup.bookings || {})) {
  const b = bookings.find(bk => bk.id === bid)
  if (!b) continue
  for (const l of (b.awb_lines || [])) {
    if (l.dispatched) dispatchedModified++
  }
}
// This is just a rough check — dispatched AWBs shouldn't have been in modified bookings
console.log(`  Bookings con AWBs despachados en backup: ${dispatchedModified > 0 ? 'CHECK NEEDED' : '0 (OK)'}`)

// ── 3. MINI-QA ──
console.log('\n--- 3. MINI-QA ---')

// 3A. DOCS — sample 3 AWBs
console.log('  3A. DOCS sample:')
let docsSampled = 0
for (const b of bookings) {
  if (docsSampled >= 3) break
  const f = flights.find(fl => fl.id === b.flight_id)
  if (!f || !(f.flight_datetime || '').startsWith('2026-05')) continue
  for (const l of (b.awb_lines || [])) {
    if (docsSampled >= 3) break
    if (l.docs_in_drive === true) {
      console.log(`    ${l.awb_number}: docs_in_drive=${l.docs_in_drive} ✓`)
      docsSampled++
    }
  }
}
if (docsSampled === 0) console.log('    No AWBs with docs_in_drive=true found (will be synced on next agent run)')

// 3B. HOLD — sample 3 cleaned AWBs
console.log('  3B. HOLD cleaned sample:')
let holdSampled = 0
for (const b of bookings) {
  if (holdSampled >= 3) break
  const f = flights.find(fl => fl.id === b.flight_id)
  if (!f || !(f.flight_datetime || '').startsWith('2026-05')) continue
  for (const l of (b.awb_lines || [])) {
    if (holdSampled >= 3) break
    if (l.hold === false && (!l.holds || l.holds.length === 0)) {
      console.log(`    ${l.awb_number}: hold=${l.hold}, holds=${JSON.stringify(l.holds || [])} ✓`)
      holdSampled++
    }
  }
}

// 3C. Flight normalization — check QT-4093, LA-0543, UC-1617
console.log('  3C. Flight normalization:')
const checkFlights = ['QT-4093', 'LA-0543', 'UC-1617']
for (const fn of checkFlights) {
  const key = flightMatchKey(fn)
  const matches = mayFlights.filter(f => flightMatchKey(f.flight_number) === key)
  // Group by ETD date
  const byEtd = {}
  for (const f of matches) {
    const etd = (f.flight_datetime || '').slice(0, 10)
    if (!byEtd[etd]) byEtd[etd] = []
    byEtd[etd].push(f)
  }
  const dupEtds = Object.entries(byEtd).filter(([, g]) => g.length > 1)
  console.log(`    ${fn}: ${matches.length} flights, ${Object.keys(byEtd).length} unique ETDs, ${dupEtds.length} duplicate ETDs`)
  for (const f of matches) {
    const linkedCount = bookings.filter(b => b.flight_id === f.id).length
    console.log(`      ${f.id}: "${f.flight_number}" ETD:${f.flight_datetime} airline:"${f.airline}" dest:[${(f.destinations||[]).join(',')}] bookings:${linkedCount}`)
  }
  if (dupEtds.length > 0) console.log(`      *** DUPLICATES ON SAME ETD ***`)
}

// ── 4. ULD VALIDATION ──
console.log('\n--- 4. ULD VALIDATION ---')
let uldIssues = 0
for (const b of bookings) {
  const f = flights.find(fl => fl.id === b.flight_id)
  if (!f || !(f.flight_datetime || '').startsWith('2026-05')) continue
  for (const l of (b.awb_lines || [])) {
    const uld = l.uld_type || ''
    if (uld.includes('BUP') || uld.includes('\n') || uld.includes('\r')) {
      console.log(`  ISSUE: ${l.awb_number} uld="${uld}"`)
      uldIssues++
    }
  }
}
console.log(`  ULD issues remaining: ${uldIssues}`)

// ── 5. DEST VALIDATION ──
console.log('\n--- 5. DEST VALIDATION ---')
const mayDestSet = new Set()
for (const b of bookings) {
  const f = flights.find(fl => fl.id === b.flight_id)
  if (!f || !(f.flight_datetime || '').startsWith('2026-05')) continue
  mayDestSet.add(b.destination_id || '')
}
for (const f of mayFlights) {
  for (const d of (f.destinations || [])) mayDestSet.add(d)
}
const suffixDests = [...mayDestSet].filter(d => /\s+(LOOSE|PAX|CAO|CARGO)$/i.test(d))
console.log(`  Unique Mayo destinations: ${[...mayDestSet].filter(d=>d).join(', ')}`)
console.log(`  With residual suffixes: ${suffixDests.length}`)

// ── 6. MERGED FLIGHTS VALIDATION ──
console.log('\n--- 6. MERGED FLIGHTS ---')
const mergedPairs = [
  { name: 'GG-4515 May14', key: 'GG4515', etd: '2026-05-14' },
  { name: 'LA-0543 May19', key: 'LA0543', etd: '2026-05-19' },
  { name: 'UC-1617 May23', key: 'UC1617', etd: '2026-05-23' },
]
for (const mp of mergedPairs) {
  const matches = mayFlights.filter(f =>
    flightMatchKey(f.flight_number) === mp.key &&
    (f.flight_datetime || '').startsWith(mp.etd)
  )
  const totalAwbs = matches.reduce((s, f) => {
    return s + bookings.filter(b => b.flight_id === f.id).reduce((s2, b) => s2 + (b.awb_lines || []).length, 0)
  }, 0)
  console.log(`  ${mp.name}: ${matches.length} flight(s), ${totalAwbs} AWBs`)
  if (matches.length > 1) console.log(`    *** STILL DUPLICATED ***`)
  for (const f of matches) {
    const bs = bookings.filter(b => b.flight_id === f.id)
    console.log(`    ${f.id}: ${bs.length} bookings, ${bs.reduce((s,b)=>s+(b.awb_lines||[]).length,0)} AWBs`)
  }
}

// ── 7. ROLLBACK VALIDATION ──
console.log('\n--- 7. ROLLBACK ---')
const backupFlights = Object.keys(backup.flights || {}).length
const backupBookings = Object.keys(backup.bookings || {}).length
console.log(`  Backup flights: ${backupFlights}`)
console.log(`  Backup bookings: ${backupBookings}`)
const backupFields = new Set()
for (const fields of Object.values(backup.flights || {})) {
  for (const k of Object.keys(fields)) backupFields.add(`flight.${k}`)
}
for (const fields of Object.values(backup.bookings || {})) {
  for (const k of Object.keys(fields)) backupFields.add(`booking.${k}`)
}
console.log(`  Backed up field types: ${[...backupFields].join(', ')}`)
console.log(`  Rollback script exists: ${fs.existsSync(path.join(__dirname, 'functions', 'rollback-express-line.js'))}`)

console.log('\n' + '='.repeat(80))
console.log('VALIDACION COMPLETA')
console.log('='.repeat(80))
