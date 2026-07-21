/**
 * Migration script: Correct existing Express Line (May 2026) data.
 *
 * Steps: M1-M12 per migration plan.
 * Run with: node functions/migrate-express-line.js [--apply]
 * Without --apply: dry-run (log only, no writes).
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

const PROJECT_ID = 'wms-mcl'
const CLIENT_ID = 'YPATo6B9BvRJEIJO7ld9'
const DRY_RUN = !process.argv.includes('--apply')

// ── Normalization helpers (must match index.js) ──

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

function flightMatchKey(raw) {
  let s = (raw || '').trim().toUpperCase()
  s = s.replace(/\s+(A\d+|PAX|CAO|LOOSE|CARGO)$/, '')
  return s.replace(/[\s\-]/g, '')
}

function normalizeDest(raw) {
  return (raw || '').trim().toUpperCase().replace(/\s+(LOOSE|PAX|CAO|CARGO)$/, '').trim()
}

function normalizeUld(raw) {
  let s = (raw || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase()
  if (s === 'BUP OR LOOSE') s = 'LOOSE'
  return s
}

// ── REST API helpers ──

function exchangeRefreshToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const postData = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi`
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        const parsed = JSON.parse(data)
        if (parsed.access_token) resolve(parsed.access_token)
        else reject(new Error(parsed.error_description || 'Token exchange failed'))
      })
    })
    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

function firestoreReq(token, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null
    const options = {
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents${urlPath}`,
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    }
    if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData)
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) reject(new Error(parsed.error.message))
          else resolve(parsed)
        } catch { reject(new Error('Bad response: ' + data.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    if (postData) req.write(postData)
    req.end()
  })
}

function runQuery(token, collection, filters) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: filters.length === 1 ? filters[0]
        : { compositeFilter: { op: 'AND', filters } },
    },
  }
  return firestoreReq(token, 'POST', ':runQuery', body)
}

function parseValue(val) {
  if (!val) return null
  if ('stringValue' in val) return val.stringValue
  if ('integerValue' in val) return Number(val.integerValue)
  if ('doubleValue' in val) return val.doubleValue
  if ('booleanValue' in val) return val.booleanValue
  if ('nullValue' in val) return null
  if ('timestampValue' in val) return val.timestampValue
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(parseValue)
  if ('mapValue' in val) {
    const obj = {}
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) obj[k] = parseValue(v)
    return obj
  }
  return null
}

function parseDoc(doc) {
  const id = (doc.name || '').split('/').pop()
  const fields = {}
  for (const [k, v] of Object.entries(doc.fields || {})) fields[k] = parseValue(v)
  return { id, ...fields }
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null }
  if (typeof val === 'boolean') return { booleanValue: val }
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  if (typeof val === 'string') return { stringValue: val }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } }
  if (typeof val === 'object') {
    const fields = {}
    for (const [k, v] of Object.entries(val)) fields[k] = toFirestoreValue(v)
    return { mapValue: { fields } }
  }
  return { stringValue: String(val) }
}

async function patchDoc(token, docPath, fieldsToUpdate) {
  const updateMask = Object.keys(fieldsToUpdate).map(f => `updateMask.fieldPaths=${f}`).join('&')
  const body = { fields: {} }
  for (const [k, v] of Object.entries(fieldsToUpdate)) body.fields[k] = toFirestoreValue(v)
  return firestoreReq(token, 'PATCH', `/${docPath}?${updateMask}`, body)
}

// ── Main ──

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN (no writes) ===' : '=== APPLYING MIGRATION ===')

  const home = process.env.USERPROFILE || process.env.HOME
  const cfgPath = path.join(home, '.config', 'configstore', 'firebase-tools.json')
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const refreshToken = cfg.tokens && cfg.tokens.refresh_token
  if (!refreshToken) { console.error('No refresh token'); process.exit(1) }

  const token = await exchangeRefreshToken(refreshToken)
  console.log('Authenticated')

  // Load bookings
  const bookingsRaw = await runQuery(token, 'airfreight_bookings', [
    { fieldFilter: { field: { fieldPath: 'client_id' }, op: 'EQUAL', value: { stringValue: CLIENT_ID } } },
    { fieldFilter: { field: { fieldPath: 'booking_type' }, op: 'EQUAL', value: { stringValue: 'ecommerce' } } },
  ])
  const bookings = (Array.isArray(bookingsRaw) ? bookingsRaw : []).filter(r => r.document).map(r => parseDoc(r.document))
  console.log(`Loaded ${bookings.length} bookings`)

  // Load flights
  const flightIds = [...new Set(bookings.map(b => b.flight_id).filter(Boolean))]
  const flights = {}
  for (const fid of flightIds) {
    try {
      const fDoc = await firestoreReq(token, 'GET', `/airfreight_flights/${fid}`, null)
      if (fDoc.fields) flights[fid] = { id: fid, ...parseDoc(fDoc) }
    } catch {}
  }
  console.log(`Loaded ${Object.keys(flights).length} flights`)

  // Filter May 2026 flights only
  const mayFlights = Object.values(flights).filter(f => {
    const etd = (f.flight_datetime || '')
    return etd.startsWith('2026-05') || (f.created_by === 'sheet_sync_agent' && etd.startsWith('2026-05'))
  })
  console.log(`May 2026 flights: ${mayFlights.length}`)

  const backup = { flights: {}, bookings: {} }
  const log = []

  // ── M2: Normalize flight_number in flights ──
  console.log('\n--- M2: Normalize flight_number in flights ---')
  for (const f of mayFlights) {
    const current = f.flight_number || ''
    const normalized = normalizeFlightNumber(current)
    if (current !== normalized) {
      log.push({ step: 'M2', flight_id: f.id, before: current, after: normalized })
      console.log(`  ${f.id}: "${current}" → "${normalized}"`)
      if (!DRY_RUN) {
        backup.flights[f.id] = { flight_number: current }
        await patchDoc(token, `airfreight_flights/${f.id}`, { flight_number: normalized })
      }
    }
  }

  // ── M5: Normalize destinations[] in flights ──
  console.log('\n--- M5: Normalize destinations[] in flights ---')
  for (const f of mayFlights) {
    const dests = f.destinations || []
    const normalized = dests.map(d => normalizeDest(d))
    const changed = dests.some((d, i) => d !== normalized[i])
    if (changed) {
      log.push({ step: 'M5', flight_id: f.id, before: dests, after: normalized })
      console.log(`  ${f.id}: [${dests.join(', ')}] → [${normalized.join(', ')}]`)
      if (!DRY_RUN) {
        if (!backup.flights[f.id]) backup.flights[f.id] = {}
        backup.flights[f.id].destinations = dests
        await patchDoc(token, `airfreight_flights/${f.id}`, { destinations: normalized })
      }
    }
  }

  // ── M1: Merge duplicate flights (same flightMatchKey + same ETD date) ──
  console.log('\n--- M1: Detect duplicate flights ---')
  const flightGroups = {}
  for (const f of mayFlights) {
    const key = flightMatchKey(f.flight_number) + '|' + (f.flight_datetime || '').slice(0, 10)
    if (!flightGroups[key]) flightGroups[key] = []
    flightGroups[key].push(f)
  }
  for (const [key, group] of Object.entries(flightGroups)) {
    if (group.length <= 1) continue
    // Find which flight has more bookings
    const withCounts = group.map(f => ({
      flight: f,
      bookingCount: bookings.filter(b => b.flight_id === f.id).length,
    }))
    withCounts.sort((a, b) => b.bookingCount - a.bookingCount)
    const keep = withCounts[0]
    const dupes = withCounts.slice(1)
    for (const dupe of dupes) {
      log.push({ step: 'M1', action: 'merge', keep: keep.flight.id, remove: dupe.flight.id, key })
      console.log(`  DUPLICATE: ${key} — keep ${keep.flight.id} (${keep.bookingCount} bookings), merge ${dupe.flight.id} (${dupe.bookingCount} bookings)`)
      // Move bookings from dupe to keep
      const dupeBookings = bookings.filter(b => b.flight_id === dupe.flight.id)
      for (const b of dupeBookings) {
        console.log(`    Move booking ${b.id} from flight ${dupe.flight.id} → ${keep.flight.id}`)
        if (!DRY_RUN) {
          backup.bookings[b.id] = { flight_id: b.flight_id, flight_number: b.flight_number }
          await patchDoc(token, `airfreight_bookings/${b.id}`, {
            flight_id: keep.flight.id,
            flight_number: keep.flight.flight_number || normalizeFlightNumber(dupe.flight.flight_number),
          })
        }
      }
    }
  }

  // ── M3: Normalize flight_number in bookings ──
  console.log('\n--- M3: Normalize flight_number in bookings ---')
  const mayBookings = bookings.filter(b => {
    const f = flights[b.flight_id]
    return f && (f.flight_datetime || '').startsWith('2026-05')
  })
  for (const b of mayBookings) {
    const current = b.flight_number || ''
    const normalized = normalizeFlightNumber(current)
    if (current !== normalized) {
      log.push({ step: 'M3', booking_id: b.id, before: current, after: normalized })
      console.log(`  ${b.id}: "${current}" → "${normalized}"`)
      if (!DRY_RUN) {
        if (!backup.bookings[b.id]) backup.bookings[b.id] = {}
        backup.bookings[b.id].flight_number = current
        await patchDoc(token, `airfreight_bookings/${b.id}`, { flight_number: normalized })
      }
    }
  }

  // ── M4: Normalize destination_id in bookings ──
  console.log('\n--- M4: Normalize destination_id in bookings ---')
  for (const b of mayBookings) {
    const current = b.destination_id || ''
    const normalized = normalizeDest(current)
    if (current !== normalized) {
      log.push({ step: 'M4', booking_id: b.id, before: current, after: normalized })
      console.log(`  ${b.id}: "${current}" → "${normalized}"`)
      if (!DRY_RUN) {
        if (!backup.bookings[b.id]) backup.bookings[b.id] = {}
        backup.bookings[b.id].destination_id = current
        await patchDoc(token, `airfreight_bookings/${b.id}`, { destination_id: normalized })
      }
    }
  }

  // ── M6, M7, M8, M9: AWB-level fixes (ULD, docs, holds, pickup) ──
  console.log('\n--- M6-M9: AWB-level fixes ---')

  // Load the export to get Excel data for comparison
  const exportPath = path.join(__dirname, '..', 'express-line-export.json')
  let exportData = null
  try { exportData = JSON.parse(fs.readFileSync(exportPath, 'utf8')) } catch {}

  for (const b of mayBookings) {
    if (!b.awb_lines || b.awb_lines.length === 0) continue
    let modified = false
    const updatedLines = b.awb_lines.map((line, idx) => {
      const updated = { ...line }

      // M6: Normalize ULD
      const currentUld = line.uld_type || ''
      const normalizedUld = normalizeUld(currentUld)
      if (currentUld !== normalizedUld) {
        log.push({ step: 'M6', booking: b.id, awb: line.awb_number, before: currentUld, after: normalizedUld })
        console.log(`  M6 ULD: ${line.awb_number} "${currentUld}" → "${normalizedUld}"`)
        updated.uld_type = normalizedUld
        modified = true
      }

      // M8: Clear PENDING holds where no hold data exists
      if (line.hold === 'pending' && (!line.holds || line.holds.length === 0)) {
        log.push({ step: 'M8', booking: b.id, awb: line.awb_number, action: 'clear_pending_hold' })
        console.log(`  M8 HOLD: ${line.awb_number} PENDING → NO HOLD (no hold data)`)
        updated.hold = false
        updated.holds = []
        modified = true
      }

      return updated
    })

    if (modified && !DRY_RUN) {
      if (!backup.bookings[b.id]) backup.bookings[b.id] = {}
      backup.bookings[b.id].awb_lines = b.awb_lines
      await patchDoc(token, `airfreight_bookings/${b.id}`, { awb_lines: updatedLines })
    }
  }

  // ── M11: Remove junk flight (address as flight_number) ──
  console.log('\n--- M11: Remove junk flights ---')
  for (const f of mayFlights) {
    const fn = (f.flight_number || '')
    if (fn.includes('9950') || fn.includes('STE 101') || fn.length > 20) {
      const linkedBookings = bookings.filter(b => b.flight_id === f.id)
      log.push({ step: 'M11', flight_id: f.id, flight_number: fn, linked_bookings: linkedBookings.length })
      console.log(`  JUNK: "${fn}" (${f.id}) — ${linkedBookings.length} bookings linked`)
      if (linkedBookings.length === 0) {
        console.log(`    → Safe to delete (no bookings)`)
      } else {
        console.log(`    → Has bookings, skip delete — needs manual review`)
      }
    }
  }

  // ── Summary ──
  console.log(`\n=== SUMMARY ===`)
  console.log(`Total operations: ${log.length}`)
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLIED'}`)

  // Save backup and log
  const outDir = path.join(__dirname, '..')
  fs.writeFileSync(path.join(outDir, 'migration-log.json'), JSON.stringify(log, null, 2))
  console.log(`Log saved: migration-log.json`)
  if (!DRY_RUN) {
    fs.writeFileSync(path.join(outDir, 'migration-backup.json'), JSON.stringify(backup, null, 2))
    console.log(`Backup saved: migration-backup.json`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
