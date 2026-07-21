// Find original ETD of LA-0543 (DIQjBb82) by tracing the 2 dispatched AWBs
const https = require('https'), path = require('path'), fs = require('fs'), PROJECT = 'wms-mcl'
function getToken() { const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json'); try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) } catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) } }
function exchangeToken(rt) { return new Promise((resolve, reject) => { const body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) + '&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi'; const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) }) }); req.on('error', reject); req.write(body); req.end() }) }
function fsQuery(token, sq) { return new Promise((resolve, reject) => { const body = JSON.stringify({ structuredQuery: sq }); const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.write(body); req.end() }) }
function getDoc(token, docPath) { return new Promise((resolve, reject) => { const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents/' + docPath, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.end() }) }
function gf(doc, f) { var v = doc.fields && doc.fields[f]; if (!v) return null; if (v.stringValue !== undefined) return v.stringValue; if (v.integerValue !== undefined) return Number(v.integerValue); if (v.doubleValue !== undefined) return Number(v.doubleValue); if (v.booleanValue !== undefined) return v.booleanValue; if (v.timestampValue !== undefined) return v.timestampValue; return null }

async function main() {
  var token = await getToken()

  // The 2 original AWBs that WERE dispatched on this flight
  var origAwbs = [
    { awb1st: '369-99774080', awb2nd: '045-21532674' },
    { awb1st: '369-99774286', awb2nd: '045-22209176' },
  ]
  // The 2 phantom AWBs added by agent
  var phantomAwbs = [
    { awb1st: '369-98156015', awb2nd: '045-22209423' },
    { awb1st: '369-98155713', awb2nd: '045-20347946' },
  ]

  console.log('=================================================================')
  console.log('EVIDENCE 1: Billing charges (invoiced) — dispatch date embedded')
  console.log('=================================================================')
  var bcRes = await fsQuery(token, {
    from: [{ collectionId: 'air_billing_charges' }],
    where: { fieldFilter: { field: { fieldPath: 'booking_id' }, op: 'EQUAL', value: { stringValue: 'AMwbYZMi7NGOeaPnHyZb' } } },
    limit: 20,
  })
  var bcDocs = bcRes.filter(function(r) { return r.document })
  for (var i = 0; i < bcDocs.length; i++) {
    var cd = bcDocs[i].document
    var awb1 = gf(cd, 'awb_1st_leg') || ''
    var awb2 = gf(cd, 'awb_2nd_leg') || ''
    var total = gf(cd, 'total')
    var status = gf(cd, 'status')
    var dispAt = gf(cd, 'dispatched_at') || ''
    var flightNum = gf(cd, 'flight_number') || ''
    var chargeName = gf(cd, 'charge_name') || gf(cd, 'description') || ''
    var createdAt = gf(cd, 'created_at') || ''
    console.log('  ' + awb1 + ' / ' + awb2)
    console.log('    charge: ' + chargeName + ' | total=$' + total + ' | status=' + status)
    console.log('    flight_number: ' + flightNum + ' | dispatched_at: ' + dispAt)
    console.log('    created_at: ' + createdAt)
    console.log('')
  }

  console.log('=================================================================')
  console.log('EVIDENCE 2: Snapshot hashes — when were original AWBs first seen?')
  console.log('=================================================================')
  // Check snapshot for the original AWB keys
  var snap = await getDoc(token, '_sheet_sync_snapshots/YPATo6B9BvRJEIJO7ld9_2026-05')
  if (snap.fields && snap.fields.row_hashes && snap.fields.row_hashes.mapValue) {
    var hashes = snap.fields.row_hashes.mapValue.fields
    var allAwbs = origAwbs.concat(phantomAwbs)
    for (var j = 0; j < allAwbs.length; j++) {
      var awbKey = allAwbs[j].awb1st.replace(/-/g, '')
      var found = hashes[awbKey]
      console.log('  ' + allAwbs[j].awb1st + ': ' + (found ? 'hash=' + (found.stringValue || '').slice(0, 30) + '...' : 'NOT IN SNAPSHOT'))
    }
  }

  console.log('')
  console.log('=================================================================')
  console.log('EVIDENCE 3: All LA-0543 flights sorted by ETD — find the gap')
  console.log('=================================================================')
  var allLA = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_flights' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: 'LA-0543' } } },
    limit: 50,
  })
  var laFlights = allLA.filter(function(r) { return r.document })
  var flightList = laFlights.map(function(f) {
    var d = f.document
    return {
      id: d.name.split('/').pop(),
      etd: gf(d, 'flight_datetime') || '',
      dispAt: gf(d, 'dispatched_at') || '',
      createdBy: gf(d, 'created_by') || '',
    }
  }).sort(function(a, b) { return a.etd.localeCompare(b.etd) })

  // Filter to April-May only
  var aprilMay = flightList.filter(function(f) { return f.etd >= '2026-04' && f.etd <= '2026-06' })
  console.log('')
  console.log('  ETD          | ID       | Dispatched  | Created by')
  console.log('  -------------|----------|-------------|------------------')
  for (var k = 0; k < aprilMay.length; k++) {
    var f = aprilMay[k]
    var marker = f.id === 'DIQjBb82HSFXXAUF8ApQ' ? ' <<<< THIS ONE' : ''
    console.log('  ' + f.etd.slice(0, 10).padEnd(13) + '| ' + f.id.slice(0, 8).padEnd(9) + '| ' + (f.dispAt || '').slice(0, 10).padEnd(12) + '| ' + f.createdBy + marker)
  }

  // Find consecutive date gaps
  console.log('')
  console.log('  DATE GAP ANALYSIS (consecutive LA-0543 flights):')
  var etdDates = aprilMay.map(function(f) { return f.etd.slice(0, 10) }).filter(Boolean)
  var uniqueDates = Array.from(new Set(etdDates)).sort()
  for (var m = 1; m < uniqueDates.length; m++) {
    var prev = new Date(uniqueDates[m - 1])
    var curr = new Date(uniqueDates[m])
    var gap = Math.round((curr - prev) / 86400000)
    if (gap > 2) {
      console.log('  GAP: ' + uniqueDates[m-1] + ' -> ' + uniqueDates[m] + ' (' + gap + ' days)')
      // List missing dates
      var missing = []
      for (var d = 1; d < gap; d++) {
        var dt = new Date(prev.getTime() + d * 86400000)
        missing.push(dt.toISOString().slice(0, 10))
      }
      console.log('       Missing: ' + missing.join(', '))
    }
  }

  console.log('')
  console.log('=================================================================')
  console.log('EVIDENCE 4: Other flights dispatched in the same batch (05-07)')
  console.log('=================================================================')
  // Find all LA-0543 flights dispatched on 05-07 — their ETD pattern shows the original range
  var batch0507 = aprilMay.filter(function(f) { return (f.dispAt || '').slice(0, 10) === '2026-05-07' })
  console.log('  LA-0543 flights dispatched on 2026-05-07:')
  for (var n = 0; n < batch0507.length; n++) {
    var bf = batch0507[n]
    var isTarget = bf.id === 'DIQjBb82HSFXXAUF8ApQ' ? ' <<<< ANOMALY' : ''
    console.log('  ETD=' + bf.etd.slice(0, 10) + ' (id=' + bf.id.slice(0, 8) + ')' + isTarget)
  }
  var batch0507Etds = batch0507.map(function(f) { return f.etd.slice(0, 10) }).sort()
  var normalRange = batch0507Etds.filter(function(d) { return d < '2026-05-10' })
  console.log('')
  console.log('  Normal ETD range for 05-07 batch: ' + normalRange[0] + ' to ' + normalRange[normalRange.length - 1])
  console.log('  ANOMALY: DIQjBb82 has ETD=' + batch0507.find(function(f) { return f.id === 'DIQjBb82HSFXXAUF8ApQ' }).etd.slice(0, 10) + ' (way outside batch range)')

  console.log('')
  console.log('=================================================================')
  console.log('EVIDENCE 5: Dates missing from batch that could be the original')
  console.log('=================================================================')
  // All dates covered by 05-07 batch (excluding the anomaly)
  var batchDates = normalRange
  // What dates are missing from the overall LA-0543 list that fall within the batch range?
  var firstBatch = batchDates[0]
  var lastBatch = batchDates[batchDates.length - 1]
  console.log('  Batch covers: ' + firstBatch + ' to ' + lastBatch)
  var allCoveredDates = new Set(uniqueDates)
  var missingInRange = []
  var startD = new Date(firstBatch)
  var endD = new Date(lastBatch)
  for (var dt2 = new Date(startD); dt2 <= endD; dt2.setDate(dt2.getDate() + 1)) {
    var ds = dt2.toISOString().slice(0, 10)
    if (!allCoveredDates.has(ds)) {
      missingInRange.push(ds)
    }
  }
  console.log('  Missing dates in batch range: ' + (missingInRange.length > 0 ? missingInRange.join(', ') : 'NONE'))

  // Also check May dates
  var missingMay = []
  for (var day = 1; day <= 31; day++) {
    var mayDate = '2026-05-' + String(day).padStart(2, '0')
    if (!allCoveredDates.has(mayDate)) missingMay.push(mayDate)
  }
  console.log('  Missing May dates overall: ' + missingMay.join(', '))

  console.log('')
  console.log('=================================================================')
  console.log('CONCLUSION')
  console.log('=================================================================')
  console.log('  The original ETD of DIQjBb82 was one of the missing dates above.')
  console.log('  To confirm exactly which one, search in the Express Line planilla')
  console.log('  for AWB 369-99774080 or 045-21532674 — the ETD column has the answer.')
}

main().catch(console.error)
