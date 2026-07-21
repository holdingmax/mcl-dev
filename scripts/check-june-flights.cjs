// Check all June flights and PENDING flights for orphan entities
const https = require('https'), path = require('path'), fs = require('fs'), PROJECT = 'wms-mcl'
function getToken() { const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json'); try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) } catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) } }
function exchangeToken(rt) { return new Promise((resolve, reject) => { const body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) + '&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi'; const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) }) }); req.on('error', reject); req.write(body); req.end() }) }
function fsQuery(token, sq) { return new Promise((resolve, reject) => { var body = JSON.stringify({ structuredQuery: sq }); var req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, function(res) { var d = ''; res.on('data', function(c) { d += c }); res.on('end', function() { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.write(body); req.end() }) }
function gf(doc, f) { var v = doc.fields && doc.fields[f]; if (!v) return null; if (v.stringValue !== undefined) return v.stringValue; if (v.integerValue !== undefined) return Number(v.integerValue); if (v.arrayValue) return (v.arrayValue.values || []).map(function(x) { return x.stringValue || '' }); return null }

async function main() {
  var token = await getToken()
  console.log('Token OK\n')

  // Get all flights with ETD in June
  var res = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_flights' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'flight_datetime' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '2026-06-01' } } },
      { fieldFilter: { field: { fieldPath: 'flight_datetime' }, op: 'LESS_THAN', value: { stringValue: '2026-07-01' } } },
    ] } },
    orderBy: [{ field: { fieldPath: 'flight_datetime' }, direction: 'ASCENDING' }],
    limit: 50,
  })
  var flights = res.filter(function(r) { return r.document }).map(function(r) {
    var d = r.document
    return { id: d.name.split('/').pop(), fn: gf(d,'flight_number'), airline: gf(d,'airline'), etd: gf(d,'flight_datetime'), dest: gf(d,'destinations'), status: gf(d,'flight_status') || gf(d,'status'), created_by: gf(d,'created_by') }
  })
  console.log('=== JUNE FLIGHTS (' + flights.length + ') ===')
  for (var i = 0; i < flights.length; i++) {
    var f = flights[i]
    console.log('\n  ' + f.id.slice(0,12) + ' | ' + (f.fn || 'PENDING') + ' | ' + (f.airline || '?') + ' | ' + (f.etd || '?') + ' | dest=' + (f.dest || []).join(',') + ' | status=' + (f.status || 'open') + ' | by=' + (f.created_by || '?'))

    // Check bookings
    var bRes = await fsQuery(token, { from: [{collectionId:'airfreight_bookings'}], where: {fieldFilter:{field:{fieldPath:'flight_id'},op:'EQUAL',value:{stringValue:f.id}}}, limit: 10 })
    var bookings = bRes.filter(function(r) { return r.document })
    var totalAwbs = 0
    for (var j = 0; j < bookings.length; j++) {
      var lines = (bookings[j].document.fields.awb_lines && bookings[j].document.fields.awb_lines.arrayValue && bookings[j].document.fields.awb_lines.arrayValue.values) || []
      totalAwbs += lines.length
      var bId = bookings[j].document.name.split('/').pop()
      var clientName = gf(bookings[j].document, 'client_name') || '?'
      console.log('    Booking ' + bId.slice(0,8) + ' | ' + clientName + ' | ' + lines.length + ' AWBs')
      for (var k = 0; k < lines.length; k++) {
        var m = lines[k].mapValue && lines[k].mapValue.fields
        if (m) {
          var awb = (m.awb_number && m.awb_number.stringValue) || ''
          console.log('      [' + k + '] ' + awb)
        }
      }
    }

    // Check doc_receptions
    var drRes = await fsQuery(token, { from: [{collectionId:'airfreight_doc_receptions'}], where: {fieldFilter:{field:{fieldPath:'flight_id'},op:'EQUAL',value:{stringValue:f.id}}}, limit: 10 })
    var drs = drRes.filter(function(r) { return r.document })
    if (drs.length > 0) console.log('    *** Doc receptions: ' + drs.length + ' ***')

    // Check billing
    var bcRes = await fsQuery(token, { from: [{collectionId:'air_billing_charges'}], where: {fieldFilter:{field:{fieldPath:'flight_id'},op:'EQUAL',value:{stringValue:f.id}}}, limit: 10 })
    var bcs = bcRes.filter(function(r) { return r.document })
    if (bcs.length > 0) console.log('    *** Billing charges: ' + bcs.length + ' ***')

    // Check buildup ULDs
    var buRes = await fsQuery(token, { from: [{collectionId:'buildup_ulds'}], where: {fieldFilter:{field:{fieldPath:'flight_id'},op:'EQUAL',value:{stringValue:f.id}}}, limit: 10 })
    var bus = buRes.filter(function(r) { return r.document })
    if (bus.length > 0) console.log('    *** Buildup ULDs: ' + bus.length + ' ***')

    // Summary
    if (drs.length === 0 && bcs.length === 0 && bus.length === 0) {
      console.log('    -> SAFE TO DELETE (no doc_receptions, billing, or ULDs)')
    } else {
      console.log('    -> WARNING: Has dependent entities!')
    }
  }

  // Check PENDING flights
  console.log('\n\n=== PENDING FLIGHTS ===')
  var pendRes = await fsQuery(token, { from: [{collectionId:'airfreight_flights'}], where: {fieldFilter:{field:{fieldPath:'flight_number'},op:'EQUAL',value:{stringValue:'PENDING'}}}, limit: 20 })
  var pendFlights = pendRes.filter(function(r) { return r.document })
  for (var p = 0; p < pendFlights.length; p++) {
    var d = pendFlights[p].document
    var pfId = d.name.split('/').pop()
    var pfEtd = gf(d,'flight_datetime')
    var pfAirline = gf(d,'airline')
    var pfDest = gf(d,'destinations')
    var pfCreatedBy = gf(d,'created_by')
    var bRes2 = await fsQuery(token, { from: [{collectionId:'airfreight_bookings'}], where: {fieldFilter:{field:{fieldPath:'flight_id'},op:'EQUAL',value:{stringValue:pfId}}}, limit: 10 })
    var bDocs2 = bRes2.filter(function(r) { return r.document })
    var awbCount = 0
    for (var q = 0; q < bDocs2.length; q++) {
      var lines2 = (bDocs2[q].document.fields.awb_lines && bDocs2[q].document.fields.awb_lines.arrayValue && bDocs2[q].document.fields.awb_lines.arrayValue.values) || []
      awbCount += lines2.length
    }
    var safe = awbCount === 0 ? 'SAFE TO DELETE (0 AWBs)' : 'HAS ' + awbCount + ' AWBs — DO NOT DELETE'
    console.log('  ' + pfId.slice(0,12) + ' | ' + (pfAirline||'?') + ' | ' + (pfEtd||'?') + ' | dest=' + (pfDest||[]).join(',') + ' | bookings=' + bDocs2.length + ' | AWBs=' + awbCount + ' | by=' + (pfCreatedBy||'?') + ' | ' + safe)
  }
}
main().catch(console.error)
