/**
 * M1: Migration — Add flight_instance_key to all existing flights.
 * Safe, additive, non-destructive. Can be run multiple times (idempotent).
 *
 * Usage:
 *   node scripts/migrate_flight_instance_keys.cjs          # dry-run (default)
 *   node scripts/migrate_flight_instance_keys.cjs --apply  # actually write
 */
const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

const APPLY = process.argv.includes('--apply')

function normalizeFlightNumber(raw) {
  let s = (raw || '').trim().toUpperCase()
  if (!s || /^(PENDING|TBD|TBA|N\/A)$/i.test(s)) return s
  s = s.replace(/\s+(A\d+|PAX|CAO|LOOSE|CARGO)$/, '')
  if (!s.includes('-')) {
    const m = s.match(/^([A-Z]{1,3})(\d{3,5})$/)
    if (m) s = `${m[1]}-${m[2]}`
  }
  return s
}

function buildInstanceKey(flightNumber, etdOrIso) {
  const fn = normalizeFlightNumber(flightNumber)
  if (!fn || /^(PENDING|TBD|TBA|N\/A)$/i.test(fn)) return null
  const date = (etdOrIso || '').slice(0, 10)
  if (!date || date.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fn + '_DRAFT'
  return fn + '_' + date
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  console.log('')

  const snap = await db.collection('airfreight_flights').get()
  console.log(`Total flights: ${snap.size}`)

  const keyMap = new Map() // key → [{ id, flight_number, etd, status }]
  let updated = 0
  let skipped = 0
  let alreadyHasKey = 0
  const duplicates = []

  for (const doc of snap.docs) {
    const f = doc.data()
    const existing = f.flight_instance_key
    const key = buildInstanceKey(f.flight_number, f.flight_datetime)

    if (existing === key) {
      alreadyHasKey++
      continue
    }

    if (!key) {
      skipped++
      continue
    }

    // Track duplicates
    if (!keyMap.has(key)) keyMap.set(key, [])
    keyMap.set(key, [...keyMap.get(key), {
      id: doc.id,
      flight_number: f.flight_number,
      etd: f.flight_datetime || null,
      status: f.flight_status || f.status || '',
      created_by: f.created_by || '',
      bookings_hint: '(check separately)',
    }])

    if (APPLY) {
      await db.collection('airfreight_flights').doc(doc.id).update({
        flight_instance_key: key,
      })
    }
    updated++
    console.log(`  ${APPLY ? 'UPDATED' : 'WOULD UPDATE'} ${doc.id}: ${f.flight_number} (${(f.flight_datetime || '').slice(0, 10) || 'no-ETD'}) → key: ${key}`)
  }

  // Report duplicates
  const dupeKeys = [...keyMap.entries()].filter(([k, v]) => v.length > 1)
  console.log('')
  console.log('=== SUMMARY ===')
  console.log(`Already had correct key: ${alreadyHasKey}`)
  console.log(`Updated/would update: ${updated}`)
  console.log(`Skipped (PENDING/null): ${skipped}`)
  console.log(`Duplicate keys found: ${dupeKeys.length}`)

  if (dupeKeys.length > 0) {
    console.log('')
    console.log('=== DUPLICATE INSTANCE KEYS (need manual resolution) ===')
    for (const [key, flights] of dupeKeys) {
      console.log(`\n  KEY: ${key} (${flights.length} flights)`)
      for (const f of flights) {
        console.log(`    - ${f.id}: ${f.flight_number} ETD=${f.etd || 'null'} status=${f.status} created_by=${f.created_by}`)
      }
    }
  }

  if (!APPLY) {
    console.log('')
    console.log('This was a DRY-RUN. To apply changes, run:')
    console.log('  node scripts/migrate_flight_instance_keys.cjs --apply')
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
