// CASE 3 ONLY: LA-0543 — Separate AWBs to correct dates
// Cases 1 and 2 already completed successfully
const https = require('https'), path = require('path'), fs = require('fs'), PROJECT = 'wms-mcl'
const NOW = new Date().toISOString()

function getToken() { const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json'); try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) } catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) } }
function exchangeToken(rt) { return new Promise((resolve, reject) => { const body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) + '&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi'; const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) }) }); req.on('error', reject); req.write(body); req.end() }) }
function getDoc(token, docPath) { return new Promise((resolve, reject) => { const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents/' + docPath, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.end() }) }
function firestorePatch(token, docPath, fields, updateMask) {
  return new Promise((resolve, reject) => {
    var maskParams = updateMask.map(function(f) { return 'updateMask.fieldPaths=' + f }).join('&')
    var req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents/' + docPath + '?' + maskParams, method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, function(res) {
      var d = ''; res.on('data', function(c) { d += c }); res.on('end', function() { try { var j = JSON.parse(d); j.error ? reject(JSON.stringify(j.error)) : resolve(j) } catch(e) { reject(d) } })
    }); req.on('error', reject); req.write(JSON.stringify({ fields: fields })); req.end()
  })
}
function firestoreCreate(token, collectionPath, fields) {
  return new Promise((resolve, reject) => {
    var req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents/' + collectionPath, method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, function(res) {
      var d = ''; res.on('data', function(c) { d += c }); res.on('end', function() { try { var j = JSON.parse(d); j.error ? reject(JSON.stringify(j.error)) : resolve(j) } catch(e) { reject(d) } })
    }); req.on('error', reject); req.write(JSON.stringify({ fields: fields })); req.end()
  })
}
function fsQuery(token, sq) { return new Promise((resolve, reject) => { var body = JSON.stringify({ structuredQuery: sq }); var req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, function(res) { var d = ''; res.on('data', function(c) { d += c }); res.on('end', function() { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.write(body); req.end() }) }
function gf(doc, f) { var v = doc.fields && doc.fields[f]; if (!v) return null; if (v.stringValue !== undefined) return v.stringValue; if (v.integerValue !== undefined) return Number(v.integerValue); return null }

function sv(s) { return { stringValue: s } }
function iv(n) { return { integerValue: String(n) } }
function dv(n) { return { doubleValue: n } }
function bv(b) { return { booleanValue: b } }

async function addAwbsToBooking(token, bookingId, newLines) {
  var doc = await getDoc(token, 'airfreight_bookings/' + bookingId)
  if (!doc.fields) throw new Error('Booking ' + bookingId + ' not found: ' + JSON.stringify(doc))
  var lines = (doc.fields.awb_lines && doc.fields.awb_lines.arrayValue && doc.fields.awb_lines.arrayValue.values) || []
  var all = lines.concat(newLines)
  var totalPcs = all.reduce(function(s, l) {
    var m = l.mapValue && l.mapValue.fields
    var pcs = m && m.pieces && (m.pieces.integerValue || m.pieces.doubleValue)
    return s + (Number(pcs) || 0)
  }, 0)
  var normalized = []
  for (var i = 0; i < all.length; i++) {
    var m = all[i].mapValue && all[i].mapValue.fields
    if (m && m.awb_number && m.awb_number.stringValue) normalized.push(m.awb_number.stringValue.replace(/-/g, ''))
    if (m && m.awb_2nd_leg && m.awb_2nd_leg.stringValue) normalized.push(m.awb_2nd_leg.stringValue.replace(/-/g, ''))
  }
  await firestorePatch(token, 'airfreight_bookings/' + bookingId, {
    awb_lines: { arrayValue: { values: all } },
    pieces: { integerValue: String(totalPcs) },
    awb_numbers_normalized: { arrayValue: { values: normalized.map(function(n) { return { stringValue: n } }) } },
  }, ['awb_lines', 'pieces', 'awb_numbers_normalized'])
  return { total: all.length }
}

function makeAwbLine(awb1, awb2, pcs, kg) {
  return { mapValue: { fields: {
    awb_number: sv(awb1), awb_2nd_leg: sv(awb2),
    pieces: iv(pcs), weight_kg: dv(kg), dispatched: bv(false),
  } } }
}

// Correct booking ID for LA-0543 May 5 flight (CbT0t7nxSig6E3ha8KIT)
var MAY5_BOOKING_ID = 'LCdO65OlpERv7ndWL6TX'
var MAY5_FLIGHT_ID = 'CbT0t7nxSig6E3ha8KIT'

async function main() {
  var token = await getToken()
  console.log('Token OK\n')

  console.log('================================================================')
  console.log('CASE 3: LA-0543 — Separate AWBs to correct dates')
  console.log('================================================================')

  // Step 1: Read booking AMwbYZMi to extract original AWB lines
  console.log('\nStep 1: Extract AWB data from booking AMwbYZMi7NGOeaPnHyZb...')
  var laBooking = await getDoc(token, 'airfreight_bookings/AMwbYZMi7NGOeaPnHyZb')
  if (!laBooking.fields) throw new Error('Booking AMwbYZMi not found: ' + JSON.stringify(laBooking))
  var laLines = (laBooking.fields.awb_lines && laBooking.fields.awb_lines.arrayValue && laBooking.fields.awb_lines.arrayValue.values) || []
  var origAwbSet = new Set(['369-99774080', '369-99774286'])
  var phantomAwbSet = new Set(['369-98156015', '369-98155713'])
  var origLines = laLines.filter(function(l) {
    var m = l.mapValue && l.mapValue.fields
    return origAwbSet.has(m && m.awb_number && m.awb_number.stringValue)
  })
  var phantomLines = laLines.filter(function(l) {
    var m = l.mapValue && l.mapValue.fields
    return phantomAwbSet.has(m && m.awb_number && m.awb_number.stringValue)
  })
  console.log('  Original AWBs (-> May 5): ' + origLines.length)
  console.log('  Phantom AWBs (-> May 31): ' + phantomLines.length)

  // Step 2: Add 2 original AWBs to May 5 booking
  console.log('\nStep 2: Add 2 original AWBs to LA-0543 May 5 booking ' + MAY5_BOOKING_ID + '...')
  var la5result = await addAwbsToBooking(token, MAY5_BOOKING_ID, origLines)
  console.log('  Booking now has ' + la5result.total + ' AWBs')

  // Step 3: Update billing charges to point to May 5 flight/booking
  console.log('\nStep 3: Update billing charges -> May 5 flight/booking...')
  var bcRes = await fsQuery(token, {
    from: [{ collectionId: 'air_billing_charges' }],
    where: { fieldFilter: { field: { fieldPath: 'booking_id' }, op: 'EQUAL', value: { stringValue: 'AMwbYZMi7NGOeaPnHyZb' } } },
    limit: 20,
  })
  var bcDocs = bcRes.filter(function(r) { return r.document })
  // Only update charges for the 2 original AWBs (369-99774080, 369-99774286)
  var origChargeCount = 0
  for (var bi = 0; bi < bcDocs.length; bi++) {
    var bcDoc = bcDocs[bi].document
    var bcId = bcDoc.name.split('/').pop()
    var bcAwb = gf(bcDoc, 'awb_1st_leg') || gf(bcDoc, 'awb_number') || ''
    if (origAwbSet.has(bcAwb)) {
      await firestorePatch(token, 'air_billing_charges/' + bcId, {
        booking_id: sv(MAY5_BOOKING_ID),
        flight_id: sv(MAY5_FLIGHT_ID),
      }, ['booking_id', 'flight_id'])
      console.log('  Charge ' + bcId.slice(0, 8) + ' (' + bcAwb + ') -> May 5 booking')
      origChargeCount++
    } else {
      console.log('  Charge ' + bcId.slice(0, 8) + ' (' + bcAwb + ') — skipped (not original AWB)')
    }
  }
  console.log('  Updated ' + origChargeCount + ' charges')

  // Step 4: Create new LA-0543 flight for May 31
  console.log('\nStep 4: Create new LA-0543 flight ETD 2026-05-31...')
  var newLaFlight = await firestoreCreate(token, 'airfreight_flights', {
    flight_number: sv('LA-0543'),
    airline: sv('LATAM PAX'),
    flight_datetime: sv('2026-05-31T23:40:00'),
    cutoff_datetime: sv('2026-05-30'),
    destinations: { arrayValue: { values: [sv('EZE')] } },
    status: sv('open'),
    created_at: sv(NOW),
    created_by: sv('system_recovery'),
  })
  var newLaFlightId = newLaFlight.name.split('/').pop()
  console.log('  New flight ID: ' + newLaFlightId)

  // Step 5: Create booking on new flight with 2 phantom AWBs
  console.log('\nStep 5: Create booking on new LA-0543 05-31 flight...')
  var phantomBookingLines = phantomLines.length > 0 ? phantomLines : [
    makeAwbLine('369-98156015', '045-22209423', 137, 2985),
    makeAwbLine('369-98155713', '045-20347946', 120, 2540),
  ]
  var phantomPcs = phantomBookingLines.reduce(function(s, l) {
    var m = l.mapValue && l.mapValue.fields
    var pcs = m && m.pieces && (m.pieces.integerValue || m.pieces.doubleValue)
    return s + (Number(pcs) || 0)
  }, 0)
  var phantomNorm = []
  for (var pi = 0; pi < phantomBookingLines.length; pi++) {
    var pm = phantomBookingLines[pi].mapValue && phantomBookingLines[pi].mapValue.fields
    if (pm && pm.awb_number && pm.awb_number.stringValue) phantomNorm.push(pm.awb_number.stringValue.replace(/-/g, ''))
    if (pm && pm.awb_2nd_leg && pm.awb_2nd_leg.stringValue) phantomNorm.push(pm.awb_2nd_leg.stringValue.replace(/-/g, ''))
  }
  var newLaBooking = await firestoreCreate(token, 'airfreight_bookings', {
    flight_id: sv(newLaFlightId),
    flight_number: sv('LA-0543'),
    airline: sv('LATAM PAX'),
    booking_type: sv('ecommerce'),
    client_id: sv('YPATo6B9BvRJEIJO7ld9'),
    client_name: sv('Express Line'),
    destination_id: sv('EZE'),
    status: sv('submitted'),
    created_by: sv('system_recovery'),
    created_at: sv(NOW),
    change_count: iv(0),
    modified_seen: bv(true),
    awb_lines: { arrayValue: { values: phantomBookingLines } },
    pieces: iv(phantomPcs),
    awb_numbers_normalized: { arrayValue: { values: phantomNorm.map(function(n) { return sv(n) }) } },
  })
  var newLaBookingId = newLaBooking.name.split('/').pop()
  console.log('  New booking ID: ' + newLaBookingId + ' (' + phantomBookingLines.length + ' AWBs, ' + phantomPcs + ' pcs)')

  // Step 6: Restore DIQjBb82 ETD to 05-05 and clear it
  console.log('\nStep 6: Restore DIQjBb82HSFXXAUF8ApQ ETD to 2026-05-05...')
  await firestorePatch(token, 'airfreight_flights/DIQjBb82HSFXXAUF8ApQ', {
    flight_datetime: sv('2026-05-05T23:40:00'),
    cutoff_datetime: sv('2026-05-04'),
  }, ['flight_datetime', 'cutoff_datetime'])
  console.log('  flight_datetime: 2026-05-05T23:40:00')

  // Step 7: Clear booking AMwbYZMi (now empty — all AWBs moved out)
  console.log('\nStep 7: Clear booking AMwbYZMi7NGOeaPnHyZb (all AWBs moved)...')
  await firestorePatch(token, 'airfreight_bookings/AMwbYZMi7NGOeaPnHyZb', {
    awb_lines: { arrayValue: { values: [] } },
    pieces: iv(0),
    awb_numbers_normalized: { arrayValue: { values: [] } },
  }, ['awb_lines', 'pieces', 'awb_numbers_normalized'])
  console.log('  Booking cleared (0 AWBs)')

  console.log('\n  CASE 3 COMPLETE')
  console.log('  May 5 flight CbT0t7nxSig6E3ha8KIT: 2 AWBs added')
  console.log('  May 31 flight ' + newLaFlightId + ': 2 AWBs (new)')
  console.log('  DIQjBb82 ETD restored to 05-05, booking AMwbYZMi cleared')
}

main().catch(function(err) { console.error('FATAL:', err); process.exit(1) })
