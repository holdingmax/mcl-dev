// Recovery script for Cases 1 & 2 — fixes booking/DR linkages + creates billing charges
// Case 1: UC-1527 — 3 AWBs missing from booking
// Case 2: LA-0543 — flight deleted, create new + reassign

const https = require('https')
const path = require('path')
const fs = require('fs')
const PROJECT = 'wms-mcl'
const NOW = new Date().toISOString()

function getToken() {
  const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json')
  try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) }
  catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) }
}
function exchangeToken(rt) {
  return new Promise((resolve, reject) => {
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi`
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) })
    }); req.on('error', reject); req.write(body); req.end()
  })
}

function firestorePatch(token, docPath, fields, updateMask) {
  return new Promise((resolve, reject) => {
    const maskParams = updateMask.map(f => `updateMask.fieldPaths=${f}`).join('&')
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}?${maskParams}`,
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { const j = JSON.parse(d); j.error ? reject(JSON.stringify(j.error)) : resolve(j) } catch (e) { reject(d) }
      })
    }); req.on('error', reject); req.write(JSON.stringify({ fields })); req.end()
  })
}

function firestoreCreate(token, collectionPath, fields, docId) {
  return new Promise((resolve, reject) => {
    const idParam = docId ? `?documentId=${docId}` : ''
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents/${collectionPath}${idParam}`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { const j = JSON.parse(d); j.error ? reject(JSON.stringify(j.error)) : resolve(j) } catch (e) { reject(d) }
      })
    }); req.on('error', reject); req.write(JSON.stringify({ fields })); req.end()
  })
}

function getDoc(token, docPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}`,
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(d) } })
    }); req.on('error', reject); req.end()
  })
}

function sv(s) { return { stringValue: s } }
function iv(n) { return { integerValue: String(n) } }
function dv(n) { return { doubleValue: n } }
function bv(b) { return { booleanValue: b } }
function nv() { return { nullValue: null } }

async function main() {
  const token = await getToken()
  console.log('Token OK\n')

  // ═══════════════════════════════════════════════════════════════════
  // CASE 1: UC-1527 — Add 3 AWB lines to booking + update DRs + billing
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ CASE 1: UC-1527 ═══\n')

  const CASE1_FLIGHT_ID = 'clFtNKunwg2MMZLKRIRs'
  const CASE1_BOOKING_ID = 'rNfC76nZKvR5rOfFZc6m'
  const CASE1_FLIGHT_NUMBER = 'UC-1527'
  const CASE1_AIRLINE = 'LATAM CAO'
  const CASE1_DISPATCHED_AT = '2026-05-25T16:27:40.473Z'
  const CASE1_CLIENT_ID = 'YPATo6B9BvRJEIJO7ld9'
  const CASE1_CLIENT_NAME = 'Express Line'

  // 3 AWB lines to add (from booking Utsbc0rkRMbHh0jE2GDs)
  const case1Lines = [
    { awb1st: '369-98153473', awb2nd: '045-22210053', pcs: 138, weight: 2315, chw: 2992, cargo: 'LOOSE' },
    { awb1st: '369-98154711', awb2nd: '045-22210064', pcs: 90, weight: 1708, chw: 1960, cargo: 'LOOSE' },
    { awb1st: '369-99783515', awb2nd: '045-22210602', pcs: 84, weight: 2519, chw: 3060, cargo: 'LOOSE' },
  ]

  // Step 1: Read current booking to get existing awb_lines
  console.log('Step 1: Reading current booking...')
  const currentBooking = await getDoc(token, `airfreight_bookings/${CASE1_BOOKING_ID}`)
  const existingLines = currentBooking.fields?.awb_lines?.arrayValue?.values || []
  console.log(`  Current lines: ${existingLines.length}`)

  // Build new lines to append
  const newLineValues = case1Lines.map(l => ({
    mapValue: {
      fields: {
        awb_number: sv(l.awb1st),
        awb_2nd_leg: sv(l.awb2nd),
        pieces: iv(l.pcs),
        weight: dv(l.weight),
        chargeable_weight: iv(l.chw),
        cargo_type: sv(l.cargo.toLowerCase()),
        uld_type: sv(l.cargo === 'BUP' ? 'BUP' : ''),
        destination: sv('EZE'),
      }
    }
  }))

  const allLines = [...existingLines, ...newLineValues]

  // Step 2: Update booking with new lines
  console.log('Step 2: Adding 3 AWB lines to booking...')
  await firestorePatch(token, `airfreight_bookings/${CASE1_BOOKING_ID}`, {
    awb_lines: { arrayValue: { values: allLines } }
  }, ['awb_lines'])
  console.log(`  ✓ Booking updated: ${existingLines.length} → ${allLines.length} lines`)

  // Step 3: Update doc_receptions booking_id
  const case1DRs = [
    { id: 'oEQ0A8qq0BpM7RyVIiPq', awb: '045-22210053' },
    { id: 'V4gJxpo1Px9ZJ0XU0riK', awb: '045-22210064' },
    { id: 'H8hPjS34WISnIoYju2Tg', awb: '045-22210602' },
  ]

  console.log('Step 3: Updating doc_receptions booking_id...')
  for (const dr of case1DRs) {
    await firestorePatch(token, `airfreight_doc_receptions/${dr.id}`, {
      booking_id: sv(CASE1_BOOKING_ID),
    }, ['booking_id'])
    console.log(`  ✓ DR ${dr.id} (${dr.awb}) → booking_id=${CASE1_BOOKING_ID}`)
  }

  // Step 4: Create billing charges
  console.log('Step 4: Creating billing charges...')
  const startIndex = existingLines.length // awb_index continues from existing
  for (let i = 0; i < case1Lines.length; i++) {
    const l = case1Lines[i]
    const awbIndex = startIndex + i
    const billingUnitId = `${CASE1_BOOKING_ID}__${awbIndex}`
    const charge = {
      booking_id: sv(CASE1_BOOKING_ID),
      flight_id: sv(CASE1_FLIGHT_ID),
      awb_index: iv(awbIndex),
      billing_unit_id: sv(billingUnitId),
      scope: sv('awb'),
      awb_1st_leg: sv(l.awb1st),
      awb_2nd_leg: sv(l.awb2nd),
      mawb_number: nv(),
      booking_type: sv('ecommerce'),
      cargo_type: sv(l.cargo),
      pieces: iv(l.pcs),
      weight: iv(l.weight),
      chargeable_weight: iv(l.chw),
      client_id: sv(CASE1_CLIENT_ID),
      client_name: sv(CASE1_CLIENT_NAME),
      airline: sv(CASE1_AIRLINE),
      flight_number: sv(CASE1_FLIGHT_NUMBER),
      source: sv('manual_recovery'),
      added_by: sv('system_recovery'),
      rate_id: nv(),
      dispatched_at: sv(CASE1_DISPATCHED_AT),
      created_at: sv(NOW),
      created_by: sv('system_recovery'),
      currency: sv('USD'),
      minimum_charge_applied: bv(false),
      charge_name: sv('BUILD UP + K9 SCREENING + DROP OFF'),
      description: sv('BUILD UP + K9 SCREENING + DROP OFF'),
      unit: sv('KG'),
      qty: iv(l.chw),
      rate: dv(0.19),
      total: dv(Math.round(l.chw * 0.19 * 100) / 100),
      status: sv('pending'),
    }
    const result = await firestoreCreate(token, 'air_billing_charges', charge)
    const newId = result.name.split('/').pop()
    console.log(`  ✓ Charge ${newId}: ${l.awb2nd} | ${l.chw} kg × $0.19 = $${(l.chw * 0.19).toFixed(2)}`)
  }

  console.log('\n═══ CASE 1 COMPLETE ═══\n')

  // ═══════════════════════════════════════════════════════════════════
  // CASE 2: LA-0543 — Create flight + reassign booking/DRs + billing
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ CASE 2: LA-0543 ═══\n')

  const CASE2_BOOKING_ID = 'TNHrhQGScwEtBtgv46pw'
  const CASE2_FLIGHT_NUMBER = 'LA-0543'
  const CASE2_AIRLINE = 'LATAM PAX'
  const CASE2_CLIENT_ID = 'YPATo6B9BvRJEIJO7ld9'
  const CASE2_CLIENT_NAME = 'Express Line'

  // Step 1: Create new flight
  console.log('Step 1: Creating flight LA-0543 ETD 2026-05-25...')
  const flightFields = {
    flight_number: sv('LA-0543'),
    airline: sv('LATAM PAX'),
    flight_datetime: sv('2026-05-25T23:55:00'),
    cutoff_datetime: sv('2026-05-24T20:00:00'),
    flight_status: sv('dispatched'),
    status: sv('open'),
    destinations: { arrayValue: { values: [sv('EZE')] } },
    created_at: sv(NOW),
    dispatched_at: sv('2026-05-26T04:00:00.000Z'),
    built_at: sv('2026-05-25T20:00:00.000Z'),
    built_by: sv('system_recovery'),
  }
  const flightResult = await firestoreCreate(token, 'airfreight_flights', flightFields)
  const newFlightId = flightResult.name.split('/').pop()
  console.log(`  ✓ Flight created: ${newFlightId}`)

  // Step 2: Update booking flight_id
  console.log('Step 2: Updating booking flight_id...')
  await firestorePatch(token, `airfreight_bookings/${CASE2_BOOKING_ID}`, {
    flight_id: sv(newFlightId),
    flight_number: sv(CASE2_FLIGHT_NUMBER),
  }, ['flight_id', 'flight_number'])
  console.log(`  ✓ Booking ${CASE2_BOOKING_ID} → flight_id=${newFlightId}`)

  // Step 3: Update doc_receptions flight_id
  const case2DRs = [
    { id: 'jW7iKUPzXbvjzo2QitHy', awb: '045-22209390' },
    { id: 'U6GtrQksFluFn2N6fZ6R', awb: '045-22210075' },
  ]
  console.log('Step 3: Updating doc_receptions flight_id...')
  for (const dr of case2DRs) {
    await firestorePatch(token, `airfreight_doc_receptions/${dr.id}`, {
      flight_id: sv(newFlightId),
      flight_number: sv(CASE2_FLIGHT_NUMBER),
    }, ['flight_id', 'flight_number'])
    console.log(`  ✓ DR ${dr.id} (${dr.awb}) → flight_id=${newFlightId}`)
  }

  // Step 4: Create billing charges for the 2 AWBs with doc_receptions
  const case2Lines = [
    { awb1st: '369-99362174', awb2nd: '045-22209390', pcs: 93, weight: 2595, chw: 3060, cargo: 'LOOSE', index: 1 },
    { awb1st: '369-99362185', awb2nd: '045-22210075', pcs: 85, weight: 2484, chw: 3060, cargo: 'LOOSE', index: 2 },
  ]

  console.log('Step 4: Creating billing charges...')
  for (const l of case2Lines) {
    const billingUnitId = `${CASE2_BOOKING_ID}__${l.index}`
    const charge = {
      booking_id: sv(CASE2_BOOKING_ID),
      flight_id: sv(newFlightId),
      awb_index: iv(l.index),
      billing_unit_id: sv(billingUnitId),
      scope: sv('awb'),
      awb_1st_leg: sv(l.awb1st),
      awb_2nd_leg: sv(l.awb2nd),
      mawb_number: nv(),
      booking_type: sv('ecommerce'),
      cargo_type: sv(l.cargo),
      pieces: iv(l.pcs),
      weight: iv(l.weight),
      chargeable_weight: iv(l.chw),
      client_id: sv(CASE2_CLIENT_ID),
      client_name: sv(CASE2_CLIENT_NAME),
      airline: sv(CASE2_AIRLINE),
      flight_number: sv(CASE2_FLIGHT_NUMBER),
      source: sv('manual_recovery'),
      added_by: sv('system_recovery'),
      rate_id: nv(),
      dispatched_at: sv('2026-05-26T04:00:00.000Z'),
      created_at: sv(NOW),
      created_by: sv('system_recovery'),
      currency: sv('USD'),
      minimum_charge_applied: bv(false),
      charge_name: sv('BUILD UP + K9 SCREENING + DROP OFF'),
      description: sv('BUILD UP + K9 SCREENING + DROP OFF'),
      unit: sv('KG'),
      qty: iv(l.chw),
      rate: dv(0.19),
      total: dv(Math.round(l.chw * 0.19 * 100) / 100),
      status: sv('pending'),
    }
    const result = await firestoreCreate(token, 'air_billing_charges', charge)
    const newId = result.name.split('/').pop()
    console.log(`  ✓ Charge ${newId}: ${l.awb2nd} | ${l.chw} kg × $0.19 = $${(l.chw * 0.19).toFixed(2)}`)
  }

  console.log('\n═══ CASE 2 COMPLETE ═══\n')
  console.log('═══ ALL RECOVERY COMPLETE ═══')
  console.log(`New flight ID (LA-0543 05-25): ${newFlightId}`)
  console.log('Billing charges created with status=pending — ready to invoice.')
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
