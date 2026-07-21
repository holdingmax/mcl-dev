// Fetch planning data for specific dates from Firestore
const https = require('https'), path = require('path'), fs = require('fs'), PROJECT = 'wms-mcl'
function getToken() { const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json'); try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) } catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) } }
function exchangeToken(rt) { return new Promise((resolve, reject) => { const body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) + '&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi'; const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) }) }); req.on('error', reject); req.write(body); req.end() }) }
function fsQuery(token, sq) { return new Promise((resolve, reject) => { var body = JSON.stringify({ structuredQuery: sq }); var req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, function(res) { var d = ''; res.on('data', function(c) { d += c }); res.on('end', function() { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.write(body); req.end() }) }
function gf(doc, f) { var v = doc.fields && doc.fields[f]; if (!v) return null; if (v.stringValue !== undefined) return v.stringValue; if (v.integerValue !== undefined) return Number(v.integerValue); if (v.doubleValue !== undefined) return Number(v.doubleValue); if (v.booleanValue !== undefined) return v.booleanValue; if (v.timestampValue !== undefined) return v.timestampValue; if (v.arrayValue) return (v.arrayValue.values || []).map(function(x) { return x.stringValue || '' }); return null }

// Target dates from CLI args, default to tomorrow + day after
var args = process.argv.slice(2)
var targetDates = args.length > 0 ? args : ['2026-05-28', '2026-05-29']

async function main() {
  var token = await getToken()
  console.log('Token OK')
  console.log('Target dates: ' + targetDates.join(', ') + '\n')

  // Get all flights for the target dates
  var allFlightsRes = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_flights' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'flight_datetime' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: targetDates[0] } } },
      { fieldFilter: { field: { fieldPath: 'flight_datetime' }, op: 'LESS_THAN', value: { stringValue: (targetDates[targetDates.length - 1] || targetDates[0]).replace(/\d{2}$/, function(d) { return String(Number(d) + 1).padStart(2, '0') }) } } },
    ] } },
    orderBy: [{ field: { fieldPath: 'flight_datetime' }, direction: 'ASCENDING' }],
    limit: 100,
  })
  var flights = allFlightsRes.filter(function(r) { return r.document }).map(function(r) {
    var d = r.document
    return {
      id: d.name.split('/').pop(),
      flight_number: gf(d, 'flight_number'),
      airline: gf(d, 'airline'),
      flight_datetime: gf(d, 'flight_datetime'),
      cutoff_datetime: gf(d, 'cutoff_datetime'),
      destinations: gf(d, 'destinations'),
      status: gf(d, 'status'),
      flight_status: gf(d, 'flight_status'),
      dispatched_at: gf(d, 'dispatched_at'),
      created_by: gf(d, 'created_by'),
    }
  })

  console.log('=== FLIGHTS (' + flights.length + ') ===')
  for (var i = 0; i < flights.length; i++) {
    var f = flights[i]
    var etdDate = (f.flight_datetime || '').slice(0, 10)
    var etdTime = (f.flight_datetime || '').slice(11, 16) || '??:??'
    var coTime = (f.cutoff_datetime || '').slice(11, 16) || (f.cutoff_datetime || '').slice(0, 10) || '??:??'
    var dest = Array.isArray(f.destinations) ? f.destinations.join(',') : (f.destinations || '')
    var status = f.flight_status || f.status || 'open'
    console.log('\n--- ' + f.flight_number + ' ---')
    console.log('  ID: ' + f.id)
    console.log('  Date: ' + etdDate + ' | ETD: ' + etdTime + ' | Cutoff: ' + coTime)
    console.log('  Airline: ' + f.airline + ' | Dest: ' + dest + ' | Status: ' + status)

    // Get bookings for this flight
    var bRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_bookings' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: f.id } } },
      limit: 20,
    })
    var bookings = bRes.filter(function(r) { return r.document })
    var totalPcs = 0, totalKg = 0, totalAwbs = 0

    for (var j = 0; j < bookings.length; j++) {
      var bd = bookings[j].document
      var bid = bd.name.split('/').pop()
      var client = gf(bd, 'client_name') || ''
      var btype = gf(bd, 'booking_type') || ''
      var lines = (bd.fields.awb_lines && bd.fields.awb_lines.arrayValue && bd.fields.awb_lines.arrayValue.values) || []

      console.log('  Booking ' + bid.slice(0, 8) + ' (' + client + ', ' + btype + '): ' + lines.length + ' AWBs')

      for (var k = 0; k < lines.length; k++) {
        var m = lines[k].mapValue && lines[k].mapValue.fields
        if (!m) continue
        var awb1 = (m.awb_number && m.awb_number.stringValue) || ''
        var awb2 = (m.awb_2nd_leg && m.awb_2nd_leg.stringValue) || ''
        var pcs = Number((m.pieces && (m.pieces.integerValue || m.pieces.doubleValue)) || 0)
        var cw = Number((m.chargeable_weight && (m.chargeable_weight.integerValue || m.chargeable_weight.doubleValue)) || 0)
        var weight = Number((m.weight && (m.weight.integerValue || m.weight.doubleValue)) || 0)
        var uld = (m.uld_type && m.uld_type.stringValue) || ''
        var onHand = !!(m.on_hand && m.on_hand.booleanValue)
        var dispatched = !!(m.dispatched && m.dispatched.booleanValue)
        var pickupFrom = (m.pickup_from && m.pickup_from.stringValue) || ''
        var readyForPickup = (m.ready_for_pickup && m.ready_for_pickup.stringValue) || ''

        totalPcs += pcs
        totalKg += cw || weight
        totalAwbs++

        console.log('    [' + k + '] ' + awb1 + ' | pcs=' + pcs + ' cw=' + cw + ' kg=' + weight + ' | uld=' + uld + ' | onHand=' + onHand + ' | disp=' + dispatched + (pickupFrom ? ' | pickup=' + pickupFrom : '') + (readyForPickup ? ' | ready=' + readyForPickup : ''))
      }
    }
    console.log('  TOTALS: ' + totalAwbs + ' AWBs | ' + totalPcs + ' pcs | ' + totalKg + ' kg')

    // Get doc_receptions count for this flight
    var drRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_doc_receptions' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: f.id } } },
      limit: 100,
    })
    var drDocs = drRes.filter(function(r) { return r.document })
    console.log('  Doc receptions: ' + drDocs.length)

    // Get physical pieces count
    var ppRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_physical_pieces' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: f.id } } },
      limit: 100,
    })
    var ppDocs = ppRes.filter(function(r) { return r.document })
    var rcvdPcs = 0, rcvdKg = 0
    for (var p = 0; p < ppDocs.length; p++) {
      var pd = ppDocs[p].document
      rcvdPcs += Number(gf(pd, 'pieces') || 0)
      rcvdKg += Number(gf(pd, 'weight') || gf(pd, 'chargeable_weight') || 0)
    }
    console.log('  Physical received: ' + ppDocs.length + ' records | ' + rcvdPcs + ' pcs | ' + rcvdKg + ' kg')

    // Get buildup ULDs
    var buRes = await fsQuery(token, {
      from: [{ collectionId: 'buildup_ulds' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: f.id } } },
      limit: 50,
    })
    var buDocs = buRes.filter(function(r) { return r.document })
    if (buDocs.length > 0) {
      console.log('  ULDs: ' + buDocs.length)
      for (var u = 0; u < buDocs.length; u++) {
        var ud = buDocs[u].document
        var uldType = gf(ud, 'uld_type') || ''
        var uldStatus = gf(ud, 'status') || ''
        var uldPcs = gf(ud, 'total_pieces') || 0
        var uldKg = gf(ud, 'total_weight') || 0
        console.log('    ' + uldType + ' | ' + uldStatus + ' | ' + uldPcs + ' pcs | ' + uldKg + ' kg')
      }
    }
  }
}
main().catch(console.error)
