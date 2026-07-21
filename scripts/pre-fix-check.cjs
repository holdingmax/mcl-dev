// Pre-fix verification: check current state of all target flights/bookings before correction
const https = require('https'), path = require('path'), fs = require('fs'), PROJECT = 'wms-mcl'
function getToken() { const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json'); try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) } catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) } }
function exchangeToken(rt) { return new Promise((resolve, reject) => { const body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) + '&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi'; const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) }) }); req.on('error', reject); req.write(body); req.end() }) }
function fsQuery(token, sq) { return new Promise((resolve, reject) => { const body = JSON.stringify({ structuredQuery: sq }); const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.write(body); req.end() }) }
function getDoc(token, docPath) { return new Promise((resolve, reject) => { const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents/' + docPath, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.end() }) }
function gf(doc, f) { var v = doc.fields && doc.fields[f]; if (!v) return null; if (v.stringValue !== undefined) return v.stringValue; if (v.integerValue !== undefined) return Number(v.integerValue); if (v.doubleValue !== undefined) return Number(v.doubleValue); if (v.booleanValue !== undefined) return v.booleanValue; if (v.timestampValue !== undefined) return v.timestampValue; return null }

async function main() {
  var token = await getToken()
  console.log('Token OK\n')

  // 1. LA-0543 May 5 flight (CbT0t7nx) — target for original AWBs
  console.log('=== LA-0543 May 5 flight (CbT0t7nx) ===')
  var f1 = await getDoc(token, 'airfreight_flights/CbT0t7nxhkGLQxvz8IQr')
  if (f1.error) {
    // Try without suffix
    console.log('  Trying full collection search...')
  }
  if (f1.fields) {
    console.log('  flight_number: ' + gf(f1, 'flight_number'))
    console.log('  flight_datetime: ' + gf(f1, 'flight_datetime'))
    console.log('  dispatched_at: ' + gf(f1, 'dispatched_at'))
    console.log('  flight_status: ' + gf(f1, 'flight_status'))
  } else {
    console.log('  Not found with guessed ID, searching...')
  }

  // Search for LA-0543 with ETD starting with 2026-05-05
  var laRes = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_flights' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: 'LA-0543' } } },
    ] } },
    limit: 50,
  })
  var may5 = laRes.filter(function(r) {
    return r.document && (gf(r.document, 'flight_datetime') || '').startsWith('2026-05-05')
  })
  console.log('\n  LA-0543 flights with ETD 2026-05-05: ' + may5.length)
  for (var i = 0; i < may5.length; i++) {
    var d = may5[i].document
    var id = d.name.split('/').pop()
    console.log('  ID: ' + id)
    console.log('    flight_datetime: ' + gf(d, 'flight_datetime'))
    console.log('    dispatched_at: ' + gf(d, 'dispatched_at'))
    console.log('    flight_status: ' + gf(d, 'flight_status'))
    console.log('    status: ' + gf(d, 'status'))

    // Get bookings for this flight
    var bRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_bookings' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: id } } },
      limit: 10,
    })
    var bDocs = bRes.filter(function(r) { return r.document })
    console.log('    Bookings: ' + bDocs.length)
    for (var j = 0; j < bDocs.length; j++) {
      var bd = bDocs[j].document
      var bid = bd.name.split('/').pop()
      var lines = (bd.fields && bd.fields.awb_lines && bd.fields.awb_lines.arrayValue && bd.fields.awb_lines.arrayValue.values) || []
      var client = gf(bd, 'client_name')
      var btype = gf(bd, 'booking_type')
      console.log('    Booking ' + bid.slice(0, 12) + ' (' + client + ', ' + btype + '): ' + lines.length + ' AWBs')
      for (var k = 0; k < lines.length; k++) {
        var m = lines[k].mapValue && lines[k].mapValue.fields
        if (!m) continue
        var awb1 = (m.awb_number && m.awb_number.stringValue) || ''
        var awb2 = (m.awb_2nd_leg && m.awb_2nd_leg.stringValue) || ''
        console.log('      [' + k + '] ' + awb1 + ' / ' + awb2)
      }
    }
  }

  // 2. QT-4099 current state — get doc_distribucion details
  console.log('\n=== QT-4099 (9tEknSu4) — doc_distribucion ===')
  var qt = await getDoc(token, 'airfreight_flights/9tEknSu4KVLtxTg9KjWQ')
  if (qt.fields) {
    var distMap = qt.fields.doc_distribucion && qt.fields.doc_distribucion.mapValue && qt.fields.doc_distribucion.mapValue.fields
    if (distMap) {
      console.log('  url: ' + ((distMap.url && distMap.url.stringValue) || '').slice(0, 200))
      console.log('  filename: ' + ((distMap.filename && distMap.filename.stringValue) || ''))
      console.log('  uploaded_at: ' + ((distMap.uploaded_at && distMap.uploaded_at.stringValue) || ''))
    }
  }

  // 3. UC-1527 Utsbc0rk — verify the 9 original AWBs to keep
  console.log('\n=== UC-1527 Utsbc0rk — full booking ===')
  var ub = await getDoc(token, 'airfreight_bookings/Utsbc0rkRMbHh0jE2GDs')
  if (ub.fields) {
    var fid = gf(ub, 'flight_id')
    console.log('  flight_id: ' + fid)
    console.log('  flight_number: ' + gf(ub, 'flight_number'))
    var lines2 = (ub.fields.awb_lines && ub.fields.awb_lines.arrayValue && ub.fields.awb_lines.arrayValue.values) || []
    console.log('  Total lines: ' + lines2.length)
    for (var l = 0; l < lines2.length; l++) {
      var m2 = lines2[l].mapValue && lines2[l].mapValue.fields
      if (!m2) continue
      var a1 = (m2.awb_number && m2.awb_number.stringValue) || ''
      var disp = m2.dispatched && m2.dispatched.booleanValue
      console.log('  [' + l + '] ' + a1 + ' dispatched=' + disp)
    }
  }
}
main().catch(console.error)
