// Cleanup LA-0543: remove undistributed AWBs, fix flight date, reassign to correct flights
// Usage: node scripts/cleanup-la0543.cjs [--dry-run]
const https = require('https')
const os = require('os')
const path = require('path')
const fs = require('fs')

const DRY_RUN = process.argv.includes('--dry-run')
const PROJECT = 'wms-mcl'
const BASE = `/v1/projects/${PROJECT}/databases/(default)/documents`

// ── Auth helpers (reused from query-audit3) ────────────────────────────────

function findFirebaseToken() {
  const locations = [
    path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'configstore', 'firebase-tools.json'),
    path.join(process.env.APPDATA || '', 'configstore', 'firebase-tools.json'),
  ]
  for (const loc of locations) {
    try {
      if (fs.existsSync(loc)) {
        const config = JSON.parse(fs.readFileSync(loc, 'utf-8'))
        if (config.tokens && config.tokens.refresh_token) return config.tokens
        if (config.user && config.user.tokens) return config.user.tokens
        return config
      }
    } catch (e) { /* skip */ }
  }
  return null
}

function refreshAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }).toString()
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const p = JSON.parse(data)
          if (p.access_token) resolve(p.access_token)
          else reject(new Error('No access_token: ' + data.slice(0, 200)))
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── Firestore REST helpers ─────────────────────────────────────────────────

function firestoreRequest(accessToken, method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : ''
    const options = {
      hostname: 'firestore.googleapis.com',
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + accessToken,
      },
    }
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr)
    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }) }
        catch (e) { resolve({ status: res.statusCode, data: data.slice(0, 500) }) }
      })
    })
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

function getDoc(token, collection, docId) {
  return firestoreRequest(token, 'GET', `${BASE}/${collection}/${docId}`)
}

function queryDocs(token, collectionId, filters, limit) {
  const sq = { structuredQuery: { from: [{ collectionId }], limit: limit || 100 } }
  if (filters && filters.length > 0) {
    sq.structuredQuery.where = { compositeFilter: { op: 'AND', filters } }
  }
  return firestoreRequest(token, 'POST', `${BASE}:runQuery`, sq)
}

function patchDoc(token, collection, docId, fields, updateMask) {
  const mask = updateMask.map(f => `updateMask.fieldPaths=${f}`).join('&')
  return firestoreRequest(token, 'PATCH',
    `${BASE}/${collection}/${docId}?${mask}`,
    { fields })
}

function createDoc(token, collection, fields) {
  return firestoreRequest(token, 'POST',
    `${BASE}/${collection}`,
    { fields })
}

function deleteDoc(token, collection, docId) {
  return firestoreRequest(token, 'DELETE', `${BASE}/${collection}/${docId}`)
}

// ── Value helpers ──────────────────────────────────────────────────────────

function sv(s) { return { stringValue: s || '' } }
function iv(n) { return { integerValue: String(n) } }
function dv(d) { return { doubleValue: d } }
function bv(b) { return { booleanValue: b } }
function tv(t) { return { timestampValue: t } }
function av(arr) { return { arrayValue: { values: arr } } }
function nv() { return { nullValue: null } }

function extractVal(field) {
  if (!field) return null
  if (field.stringValue !== undefined) return field.stringValue
  if (field.integerValue !== undefined) return Number(field.integerValue)
  if (field.timestampValue !== undefined) return field.timestampValue
  if (field.doubleValue !== undefined) return field.doubleValue
  if (field.booleanValue !== undefined) return field.booleanValue
  if (field.nullValue !== undefined) return null
  if (field.arrayValue) return (field.arrayValue.values || []).map(v => extractVal(v))
  if (field.mapValue) {
    const obj = {}
    for (const [k, v] of Object.entries(field.mapValue.fields || {})) obj[k] = extractVal(v)
    return obj
  }
  return JSON.stringify(field)
}

function parseDocs(results) {
  const docs = []
  if (!Array.isArray(results)) return docs
  for (const r of results) {
    if (!r.document) continue
    const fields = r.document.fields || {}
    const doc = { _id: r.document.name.split('/').pop(), _fields: fields }
    for (const [k, v] of Object.entries(fields)) doc[k] = extractVal(v)
    docs.push(doc)
  }
  return docs
}

function ff(fieldPath, op, value) {
  const val = typeof value === 'string' ? { stringValue: value } : { integerValue: String(value) }
  return { fieldFilter: { field: { fieldPath }, op, value: val } }
}

// ── Constants ──────────────────────────────────────────────────────────────

const FLIGHT_ID = 'gsdRJFS88I7RVPcyn8gy'  // LA-0543 current flight

// AWBs that FLEW (distributed, stay on current flight)
const FLEW_AWBS = ['045-22210274', '045-20347950', '045-20347961']

// AWBs to MOVE to LA-0543 06/02
const MOVE_0602 = ['045-22210285', '045-20348123']

// AWBs to MOVE to LA-0543 06/04
const MOVE_0604 = ['045-22210296', '045-20348134']

const ALL_MOVE = [...MOVE_0602, ...MOVE_0604]

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN MODE ===' : '=== LIVE MODE ===')
  console.log('')

  // Auth
  const tokens = findFirebaseToken()
  if (!tokens) { console.error('No Firebase credentials found'); process.exit(1) }
  let refreshToken = tokens.refresh_token || (tokens.tokens && tokens.tokens.refresh_token)
  if (!refreshToken) { console.error('No refresh_token found'); process.exit(1) }
  const token = await refreshAccessToken(refreshToken)
  console.log('Authenticated.\n')

  // ── Step 0: Diagnose current state ─────────────────────────────────────

  console.log('=== STEP 0: DIAGNOSE CURRENT STATE ===\n')

  // Get the flight
  const flightRes = await getDoc(token, 'airfreight_flights', FLIGHT_ID)
  if (flightRes.status !== 200) { console.error('Flight not found:', flightRes); process.exit(1) }
  const flightFields = flightRes.data.fields || {}
  console.log('Flight:', extractVal(flightFields.flight_number), '| Date:', extractVal(flightFields.flight_datetime),
    '| Status:', extractVal(flightFields.flight_status))

  // Get bookings for this flight
  const bkRes = await queryDocs(token, 'airfreight_bookings', [ff('flight_id', 'EQUAL', FLIGHT_ID)], 20)
  const bookings = parseDocs(bkRes.data)
  console.log(`\nBookings found: ${bookings.length}`)

  for (const bk of bookings) {
    console.log(`  Booking ${bk._id}: type=${bk.booking_type}, client=${bk.client_name}, lines=${(bk.awb_lines || []).length}`)
    const lines = bk.awb_lines || []
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      const awb2 = l.awb_2nd_leg || l.awb_number || '?'
      const isMove = ALL_MOVE.includes(awb2)
      console.log(`    [${i}] ${awb2} | ${l.pieces} pcs | CW ${l.chargeable_weight} | dispatched=${l.dispatched} ${isMove ? '← WILL MOVE' : '← STAYS'}`)
    }
  }

  // Get doc_receptions for the AWBs to move
  console.log('\nDoc receptions for AWBs to move:')
  for (const awb of ALL_MOVE) {
    const drRes = await queryDocs(token, 'airfreight_doc_receptions',
      [ff('awb_2nd_leg', 'EQUAL', awb)], 5)
    const drs = parseDocs(drRes.data)
    if (drs.length === 0) {
      // Try by awb_number
      const drRes2 = await queryDocs(token, 'airfreight_doc_receptions',
        [ff('awb_number', 'EQUAL', awb)], 5)
      const drs2 = parseDocs(drRes2.data)
      for (const dr of drs2) {
        console.log(`  ${awb} → doc_reception ${dr._id} | flight_id=${dr.flight_id} | booking_id=${dr.booking_id}`)
      }
    } else {
      for (const dr of drs) {
        console.log(`  ${awb} → doc_reception ${dr._id} | flight_id=${dr.flight_id} | booking_id=${dr.booking_id}`)
      }
    }
  }

  // Get charges for this flight
  const chRes = await queryDocs(token, 'airfreight_charges', [ff('flight_id', 'EQUAL', FLIGHT_ID)], 50)
  const charges = parseDocs(chRes.data)
  console.log(`\nCharges found: ${charges.length}`)
  for (const ch of charges) {
    const awb = ch.awb_2nd_leg || ch.awb_number || '?'
    const isMove = ALL_MOVE.includes(awb)
    console.log(`  ${ch._id}: ${awb} | $${ch.total || 0} ${isMove ? '← WILL DELETE' : '← STAYS'}`)
  }

  // Check if LA-0543 flights already exist for 06/02 and 06/04
  console.log('\nChecking existing LA-0543 flights:')
  const flightsRes = await queryDocs(token, 'airfreight_flights',
    [ff('flight_number', 'EQUAL', 'LA-0543')], 20)
  const allFlights = parseDocs(flightsRes.data)
  for (const f of allFlights) {
    console.log(`  ${f._id}: ${f.flight_number} | ${f.flight_datetime} | status=${f.flight_status}`)
  }

  const flight0602 = allFlights.find(f => (f.flight_datetime || '').startsWith('2026-06-02'))
  const flight0604 = allFlights.find(f => (f.flight_datetime || '').startsWith('2026-06-04'))

  if (DRY_RUN) {
    console.log('\n=== DRY RUN — no changes made ===')
    console.log('\nPlan:')
    console.log('1. Fix flight date: Jun 02 → 2026-06-01T23:40:00')
    console.log('2. Remove 4 AWBs from booking, keep 3 that flew')
    console.log('3. Delete charges for 4 moved AWBs')
    console.log(`4. ${flight0602 ? 'Use existing' : 'Create new'} LA-0543 06/02 flight → assign 2 AWBs`)
    console.log(`5. ${flight0604 ? 'Use existing' : 'Create new'} LA-0543 06/04 flight → assign 2 AWBs`)
    console.log('6. Update doc_reception.flight_id for 4 AWBs')
    console.log('\nRun without --dry-run to execute.')
    process.exit(0)
  }

  // ── Step 1: Fix flight date ────────────────────────────────────────────

  console.log('\n=== STEP 1: FIX FLIGHT DATE ===\n')
  const fixDateRes = await patchDoc(token, 'airfreight_flights', FLIGHT_ID, {
    flight_datetime: sv('2026-06-01T23:40:00'),
    cutoff_datetime: sv('2026-05-31T00:00:00'),
  }, ['flight_datetime', 'cutoff_datetime'])
  console.log('Flight date updated:', fixDateRes.status === 200 ? 'OK' : fixDateRes.data)

  // ── Step 2: Remove undistributed AWBs from booking ─────────────────────

  console.log('\n=== STEP 2: CLEAN BOOKING ===\n')

  for (const bk of bookings) {
    const rawLines = bk._fields.awb_lines
    if (!rawLines || !rawLines.arrayValue) continue

    const origValues = rawLines.arrayValue.values || []
    const keepValues = []
    const moveValues0602 = []
    const moveValues0604 = []

    for (const lineVal of origValues) {
      const lineFields = lineVal.mapValue?.fields || {}
      const awb2 = extractVal(lineFields.awb_2nd_leg) || extractVal(lineFields.awb_number) || ''

      if (MOVE_0602.includes(awb2)) {
        moveValues0602.push(lineVal)
        console.log(`  Removing from booking: ${awb2} → will go to 06/02`)
      } else if (MOVE_0604.includes(awb2)) {
        moveValues0604.push(lineVal)
        console.log(`  Removing from booking: ${awb2} → will go to 06/04`)
      } else {
        keepValues.push(lineVal)
        console.log(`  Keeping in booking: ${awb2}`)
      }
    }

    // Update the booking with only the kept lines
    const updateRes = await patchDoc(token, 'airfreight_bookings', bk._id, {
      awb_lines: { arrayValue: { values: keepValues } },
    }, ['awb_lines'])
    console.log(`\n  Booking ${bk._id} updated (${keepValues.length} lines kept):`, updateRes.status === 200 ? 'OK' : updateRes.data)

    // ── Step 3: Delete charges for moved AWBs ────────────────────────────

    console.log('\n=== STEP 3: DELETE INCORRECT CHARGES ===\n')

    for (const ch of charges) {
      const awb = ch.awb_2nd_leg || ch.awb_number || ''
      if (ALL_MOVE.includes(awb)) {
        const delRes = await deleteDoc(token, 'airfreight_charges', ch._id)
        console.log(`  Deleted charge ${ch._id} for ${awb}: ${delRes.status === 200 ? 'OK' : delRes.status}`)
      }
    }

    // ── Step 4: Create/find flight for 06/02 and assign AWBs ─────────────

    console.log('\n=== STEP 4: LA-0543 06/02 ===\n')

    let flight0602Id = flight0602?._id
    if (!flight0602Id) {
      const createRes = await createDoc(token, 'airfreight_flights', {
        flight_number: sv('LA-0543'),
        airline: sv('LATAM PAX'),
        flight_datetime: sv('2026-06-02T23:40:00'),
        cutoff_datetime: sv('2026-06-01T00:00:00'),
        destinations: av([sv('EZE')]),
        status: sv('open'),
        flight_status: sv('booked'),
        flight_type: sv('international'),
        created_by: sv('cleanup_script'),
        created_at: sv(new Date().toISOString()),
      })
      if (createRes.status === 200) {
        flight0602Id = createRes.data.name.split('/').pop()
        console.log('  Created flight LA-0543 06/02:', flight0602Id)
      } else {
        console.error('  Failed to create flight:', createRes.data)
      }
    } else {
      console.log('  Using existing flight LA-0543 06/02:', flight0602Id)
    }

    if (flight0602Id && moveValues0602.length > 0) {
      // Reset dispatched flags on moved lines
      const cleanedLines0602 = moveValues0602.map(lv => {
        const f = { ...lv.mapValue.fields }
        delete f.dispatched
        delete f.dispatched_at
        delete f.dispatched_by
        delete f.drop_off_time
        return { mapValue: { fields: f } }
      })

      const bkRes0602 = await createDoc(token, 'airfreight_bookings', {
        flight_id: sv(flight0602Id),
        flight_number: sv('LA-0543'),
        airline: sv('LATAM PAX'),
        booking_type: sv('ecommerce'),
        client_id: sv(bk.client_id || ''),
        client_name: sv(bk.client_name || 'Express Line'),
        status: sv('submitted'),
        created_by: sv('cleanup_script'),
        created_at: sv(new Date().toISOString()),
        awb_lines: { arrayValue: { values: cleanedLines0602 } },
      })
      if (bkRes0602.status === 200) {
        const newBkId = bkRes0602.data.name.split('/').pop()
        console.log('  Created booking for 06/02:', newBkId, `(${moveValues0602.length} lines)`)

        // Update doc_receptions
        for (const awb of MOVE_0602) {
          const drRes = await queryDocs(token, 'airfreight_doc_receptions',
            [ff('awb_2nd_leg', 'EQUAL', awb)], 5)
          const drs = parseDocs(drRes.data)
          for (const dr of drs) {
            const upRes = await patchDoc(token, 'airfreight_doc_receptions', dr._id, {
              flight_id: sv(flight0602Id),
              flight_number: sv('LA-0543'),
              booking_id: sv(newBkId),
            }, ['flight_id', 'flight_number', 'booking_id'])
            console.log(`  Updated doc_reception ${dr._id} (${awb}) → flight 06/02: ${upRes.status === 200 ? 'OK' : upRes.status}`)
          }
        }
      } else {
        console.error('  Failed to create booking:', bkRes0602.data)
      }
    }

    // ── Step 5: Create/find flight for 06/04 and assign AWBs ─────────────

    console.log('\n=== STEP 5: LA-0543 06/04 ===\n')

    let flight0604Id = flight0604?._id
    if (!flight0604Id) {
      const createRes = await createDoc(token, 'airfreight_flights', {
        flight_number: sv('LA-0543'),
        airline: sv('LATAM PAX'),
        flight_datetime: sv('2026-06-04T23:40:00'),
        cutoff_datetime: sv('2026-06-03T00:00:00'),
        destinations: av([sv('EZE')]),
        status: sv('open'),
        flight_status: sv('booked'),
        flight_type: sv('international'),
        created_by: sv('cleanup_script'),
        created_at: sv(new Date().toISOString()),
      })
      if (createRes.status === 200) {
        flight0604Id = createRes.data.name.split('/').pop()
        console.log('  Created flight LA-0543 06/04:', flight0604Id)
      } else {
        console.error('  Failed to create flight:', createRes.data)
      }
    } else {
      console.log('  Using existing flight LA-0543 06/04:', flight0604Id)
    }

    if (flight0604Id && moveValues0604.length > 0) {
      const cleanedLines0604 = moveValues0604.map(lv => {
        const f = { ...lv.mapValue.fields }
        delete f.dispatched
        delete f.dispatched_at
        delete f.dispatched_by
        delete f.drop_off_time
        return { mapValue: { fields: f } }
      })

      const bkRes0604 = await createDoc(token, 'airfreight_bookings', {
        flight_id: sv(flight0604Id),
        flight_number: sv('LA-0543'),
        airline: sv('LATAM PAX'),
        booking_type: sv('ecommerce'),
        client_id: sv(bk.client_id || ''),
        client_name: sv(bk.client_name || 'Express Line'),
        status: sv('submitted'),
        created_by: sv('cleanup_script'),
        created_at: sv(new Date().toISOString()),
        awb_lines: { arrayValue: { values: cleanedLines0604 } },
      })
      if (bkRes0604.status === 200) {
        const newBkId = bkRes0604.data.name.split('/').pop()
        console.log('  Created booking for 06/04:', newBkId, `(${moveValues0604.length} lines)`)

        // Update doc_receptions
        for (const awb of MOVE_0604) {
          const drRes = await queryDocs(token, 'airfreight_doc_receptions',
            [ff('awb_2nd_leg', 'EQUAL', awb)], 5)
          const drs = parseDocs(drRes.data)
          for (const dr of drs) {
            const upRes = await patchDoc(token, 'airfreight_doc_receptions', dr._id, {
              flight_id: sv(flight0604Id),
              flight_number: sv('LA-0543'),
              booking_id: sv(newBkId),
            }, ['flight_id', 'flight_number', 'booking_id'])
            console.log(`  Updated doc_reception ${dr._id} (${awb}) → flight 06/04: ${upRes.status === 200 ? 'OK' : upRes.status}`)
          }
        }
      } else {
        console.error('  Failed to create booking:', bkRes0604.data)
      }
    }
  }

  console.log('\n=== CLEANUP COMPLETE ===')
  console.log('Summary:')
  console.log('  - Flight date corrected to 2026-06-01T23:40')
  console.log('  - 3 AWBs kept on dispatched flight (flew)')
  console.log('  - 2 AWBs moved to LA-0543 06/02')
  console.log('  - 2 AWBs moved to LA-0543 06/04')
  console.log('  - Incorrect charges deleted')
  process.exit(0)
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
