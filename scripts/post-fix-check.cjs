// Post-fix verification: check all corrected entities
const https = require('https'), path = require('path'), fs = require('fs'), PROJECT = 'wms-mcl'
function getToken() { const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json'); try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) } catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) } }
function exchangeToken(rt) { return new Promise((resolve, reject) => { const body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) + '&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi'; const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) }) }); req.on('error', reject); req.write(body); req.end() }) }
function getDoc(token, docPath) { return new Promise((resolve, reject) => { const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents/' + docPath, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.end() }) }
function fsQuery(token, sq) { return new Promise((resolve, reject) => { var body = JSON.stringify({ structuredQuery: sq }); var req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, function(res) { var d = ''; res.on('data', function(c) { d += c }); res.on('end', function() { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.write(body); req.end() }) }
function gf(doc, f) { var v = doc.fields && doc.fields[f]; if (!v) return null; if (v.stringValue !== undefined) return v.stringValue; if (v.integerValue !== undefined) return Number(v.integerValue); return null }

async function main() {
  var token = await getToken()
  console.log('Token OK\n')

  // === QT-4099 ORIGINAL (05-22) ===
  console.log('=== QT-4099 ORIGINAL (9tEknSu4) ===')
  var qt = await getDoc(token, 'airfreight_flights/9tEknSu4KVLtxTg9KjWQ')
  console.log('  flight_datetime: ' + gf(qt, 'flight_datetime'))
  console.log('  cutoff_datetime: ' + gf(qt, 'cutoff_datetime'))
  console.log('  dispatched_at: ' + gf(qt, 'dispatched_at'))
  console.log('  flight_status: ' + gf(qt, 'flight_status'))
  var distMap = qt.fields.doc_distribucion && qt.fields.doc_distribucion.mapValue && qt.fields.doc_distribucion.mapValue.fields
  console.log('  doc_distribucion: ' + (distMap ? 'EXISTS' : 'CLEARED'))

  var bRes = await fsQuery(token, { from: [{ collectionId: 'airfreight_bookings' }], where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: '9tEknSu4KVLtxTg9KjWQ' } } }, limit: 10 })
  var bDocs = bRes.filter(function(r) { return r.document })
  for (var i = 0; i < bDocs.length; i++) {
    var bd = bDocs[i].document
    var lines = (bd.fields.awb_lines && bd.fields.awb_lines.arrayValue && bd.fields.awb_lines.arrayValue.values) || []
    console.log('  Booking ' + bd.name.split('/').pop().slice(0,12) + ': ' + lines.length + ' AWBs')
  }

  // === QT-4099 NEW (05-29) ===
  console.log('\n=== QT-4099 NEW (LNmMogvq) ===')
  var qt2 = await getDoc(token, 'airfreight_flights/LNmMogvqLmxDNjX9xnP9')
  console.log('  flight_datetime: ' + gf(qt2, 'flight_datetime'))
  console.log('  cutoff_datetime: ' + gf(qt2, 'cutoff_datetime'))
  console.log('  status: ' + gf(qt2, 'status'))
  console.log('  created_by: ' + gf(qt2, 'created_by'))

  var bRes2 = await fsQuery(token, { from: [{ collectionId: 'airfreight_bookings' }], where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: 'LNmMogvqLmxDNjX9xnP9' } } }, limit: 10 })
  var bDocs2 = bRes2.filter(function(r) { return r.document })
  for (var j = 0; j < bDocs2.length; j++) {
    var bd2 = bDocs2[j].document
    var lines2 = (bd2.fields.awb_lines && bd2.fields.awb_lines.arrayValue && bd2.fields.awb_lines.arrayValue.values) || []
    console.log('  Booking ' + bd2.name.split('/').pop().slice(0,12) + ': ' + lines2.length + ' AWBs')
    for (var k = 0; k < lines2.length; k++) {
      var m = lines2[k].mapValue && lines2[k].mapValue.fields
      var awb1 = (m && m.awb_number && m.awb_number.stringValue) || ''
      var awb2 = (m && m.awb_2nd_leg && m.awb_2nd_leg.stringValue) || ''
      console.log('    [' + k + '] ' + awb1 + ' / ' + awb2)
    }
  }

  // === Doc Receptions moved ===
  console.log('\n=== Doc Receptions on new QT-4099 ===')
  var drIds = ['LePxtYKTQ1qtk8PqpIyO', 'tyEgNOUP9QxRbJgr8Wa5', 'IK9q8QJo4T9UmeW3HM3i']
  for (var d = 0; d < drIds.length; d++) {
    var dr = await getDoc(token, 'airfreight_doc_receptions/' + drIds[d])
    var fid = gf(dr, 'flight_id') || ''
    var bid = gf(dr, 'booking_id') || ''
    console.log('  DR ' + drIds[d].slice(0,8) + ': flight_id=' + fid.slice(0,8) + ' booking_id=' + bid.slice(0,8))
  }

  // === LA-0543 NEW (05-31) ===
  console.log('\n=== LA-0543 NEW (uRnCh7BO) ===')
  var la = await getDoc(token, 'airfreight_flights/uRnCh7BOF7c2bUqkOUIT')
  console.log('  flight_datetime: ' + gf(la, 'flight_datetime'))
  console.log('  status: ' + gf(la, 'status'))
  console.log('  created_by: ' + gf(la, 'created_by'))

  var bRes3 = await fsQuery(token, { from: [{ collectionId: 'airfreight_bookings' }], where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: 'uRnCh7BOF7c2bUqkOUIT' } } }, limit: 10 })
  var bDocs3 = bRes3.filter(function(r) { return r.document })
  for (var l = 0; l < bDocs3.length; l++) {
    var bd3 = bDocs3[l].document
    var lines3 = (bd3.fields.awb_lines && bd3.fields.awb_lines.arrayValue && bd3.fields.awb_lines.arrayValue.values) || []
    console.log('  Booking ' + bd3.name.split('/').pop().slice(0,12) + ': ' + lines3.length + ' AWBs')
    for (var n = 0; n < lines3.length; n++) {
      var m3 = lines3[n].mapValue && lines3[n].mapValue.fields
      var a1 = (m3 && m3.awb_number && m3.awb_number.stringValue) || ''
      var a2 = (m3 && m3.awb_2nd_leg && m3.awb_2nd_leg.stringValue) || ''
      console.log('    [' + n + '] ' + a1 + ' / ' + a2)
    }
  }

  // === UC-1527 second booking ===
  console.log('\n=== UC-1527 booking rNfC76nZ ===')
  var ub2 = await getDoc(token, 'airfreight_bookings/rNfC76nZKvR5rOfFZc6m')
  var lines4 = (ub2.fields.awb_lines && ub2.fields.awb_lines.arrayValue && ub2.fields.awb_lines.arrayValue.values) || []
  console.log('  Total lines: ' + lines4.length)
  for (var p = 0; p < lines4.length; p++) {
    var m4 = lines4[p].mapValue && lines4[p].mapValue.fields
    var disp = m4 && m4.dispatched && m4.dispatched.booleanValue
    var awb = (m4 && m4.awb_number && m4.awb_number.stringValue) || ''
    console.log('  [' + p + '] ' + awb + ' dispatched=' + disp)
  }
}
main().catch(console.error)
