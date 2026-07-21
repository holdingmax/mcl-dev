// Monitor sheet sync agent — check audit logs, sync runs, flights, and detect anomalies
const https = require('https'), path = require('path'), fs = require('fs'), PROJECT = 'wms-mcl'
function getToken() { var p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json'); try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) } catch(e) { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) } }
function exchangeToken(rt) { return new Promise(function(resolve, reject) { var body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) + '&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi'; var req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, function(res) { var d = ''; res.on('data', function(c) { d += c }); res.on('end', function() { var j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) }) }); req.on('error', reject); req.write(body); req.end() }) }
function fsQuery(token, sq) { return new Promise(function(resolve, reject) { var body = JSON.stringify({ structuredQuery: sq }); var req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, function(res) { var d = ''; res.on('data', function(c) { d += c }); res.on('end', function() { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.write(body); req.end() }) }
function gf(doc, f) {
  var v = doc.fields && doc.fields[f]
  if (v === undefined || v === null) return null
  if (v.stringValue !== undefined) return v.stringValue
  if (v.integerValue !== undefined) return Number(v.integerValue)
  if (v.timestampValue !== undefined) return v.timestampValue
  if (v.arrayValue) return (v.arrayValue.values || []).map(function(x) { return x.stringValue || '' })
  if (v.mapValue) return JSON.stringify(v.mapValue.fields || {})
  return JSON.stringify(v)
}

async function main() {
  var token = await getToken()
  var now = new Date().toISOString()
  console.log('=== AGENT MONITOR — ' + now + ' ===\n')

  // 1. Latest sync runs (field is run_at, not started_at)
  var runRes = await fsQuery(token, { from: [{collectionId: '_sheet_sync_runs'}], orderBy: [{field:{fieldPath:'run_at'}, direction:'DESCENDING'}], limit: 10 })
  var runs = runRes.filter(function(r) { return r.document })
  console.log('--- SYNC RUNS (latest 10) ---')
  for (var i = 0; i < runs.length; i++) {
    var d = runs[i].document
    var runAt = gf(d, 'run_at') || '?'
    var status = gf(d, 'status') || '?'
    var rows = gf(d, 'rows_checked')
    var changes = gf(d, 'changes_applied')
    var detected = gf(d, 'changes_detected')
    var alerts = gf(d, 'alerts_generated')
    var duration = gf(d, 'duration_ms')
    var clientId = (gf(d, 'client_id') || '?').slice(0, 8)
    console.log('  ' + runAt + ' | ' + status + ' | client=' + clientId + ' | rows=' + rows + ' | detected=' + (detected || 0) + ' | applied=' + (changes || 0) + ' | alerts=' + (alerts || 0) + ' | ' + duration + 'ms')
  }

  // 2. Audit logs (H-07)
  var auditRes = await fsQuery(token, { from: [{collectionId: '_sheet_sync_flight_audit'}], orderBy: [{field:{fieldPath:'created_at'}, direction:'DESCENDING'}], limit: 20 })
  var audits = auditRes.filter(function(r) { return r.document })
  console.log('\n--- FLIGHT AUDIT LOGS (' + audits.length + ') ---')
  if (audits.length === 0) {
    console.log('  (none yet — no flight operations triggered)')
  }
  for (var j = 0; j < audits.length; j++) {
    var ad = audits[j].document
    var type = gf(ad, 'type') || '?'
    var fn = gf(ad, 'fn') || '?'
    var flightNum = gf(ad, 'flight_number') || '?'
    var flightId = gf(ad, 'flight_id') || ''
    var triggerAwb = gf(ad, 'trigger_awb') || ''
    var etd = gf(ad, 'etd') || gf(ad, 'new_etd') || ''
    var createdAt = gf(ad, 'created_at') || '?'
    console.log('  ' + type + ' | ' + fn + ' | flight=' + flightNum + ' | id=' + (flightId ? flightId.slice(0, 10) : '?') + ' | awb=' + triggerAwb + ' | etd=' + etd + ' | ' + createdAt)
  }

  // 3. Agent-created flights + duplicate check
  var flightRes = await fsQuery(token, { from: [{collectionId: 'airfreight_flights'}], where: {fieldFilter:{field:{fieldPath:'created_by'}, op:'EQUAL', value:{stringValue:'sheet_sync_agent'}}}, limit: 100 })
  var agentFlights = flightRes.filter(function(r) { return r.document })
  console.log('\n--- AGENT-CREATED FLIGHTS (' + agentFlights.length + ') — baseline: 10 ---')
  var flightsByNumber = {}
  for (var k = 0; k < agentFlights.length; k++) {
    var fd = agentFlights[k].document
    var fNum = gf(fd, 'flight_number') || '?'
    var fEtd = gf(fd, 'flight_datetime') || '?'
    var fAirline = gf(fd, 'airline') || '?'
    var fId = fd.name.split('/').pop()
    if (flightsByNumber[fNum] === undefined) flightsByNumber[fNum] = []
    flightsByNumber[fNum].push({ id: fId, etd: fEtd, airline: fAirline })
    console.log('  ' + fId.slice(0, 12) + ' | ' + fNum + ' | ' + fAirline + ' | ETD=' + fEtd)
  }
  // Duplicate detection (same flight_number + same ETD date = real duplicate)
  var realDupes = []
  var keys = Object.keys(flightsByNumber)
  for (var di = 0; di < keys.length; di++) {
    var group = flightsByNumber[keys[di]]
    if (group.length < 2) continue
    var etdSet = {}
    for (var gi = 0; gi < group.length; gi++) {
      var etdKey = (group[gi].etd || '').slice(0, 10)
      if (etdSet[etdKey]) {
        realDupes.push({ fn: keys[di], etd: etdKey, ids: [etdSet[etdKey], group[gi].id] })
      }
      etdSet[etdKey] = group[gi].id
    }
  }
  if (realDupes.length > 0) {
    console.log('\n  !!! REAL DUPLICATES (same flight + same ETD) !!!')
    for (var ri = 0; ri < realDupes.length; ri++) {
      console.log('    ' + realDupes[ri].fn + ' ETD=' + realDupes[ri].etd + ' IDs: ' + realDupes[ri].ids.join(', '))
    }
  } else {
    console.log('\n  OK — No real duplicates (same flight+ETD)')
  }

  // 4. PENDING + June flights
  var pendRes = await fsQuery(token, { from: [{collectionId: 'airfreight_flights'}], where: {fieldFilter:{field:{fieldPath:'flight_number'}, op:'EQUAL', value:{stringValue:'PENDING'}}}, limit: 20 })
  var pends = pendRes.filter(function(r) { return r.document })
  console.log('\n--- PENDING FLIGHTS (' + pends.length + ') ---')

  var juneRes = await fsQuery(token, { from: [{collectionId: 'airfreight_flights'}], where: { compositeFilter: { op:'AND', filters: [
    { fieldFilter: { field:{fieldPath:'flight_datetime'}, op:'GREATER_THAN_OR_EQUAL', value:{stringValue:'2026-06-01'} } },
    { fieldFilter: { field:{fieldPath:'flight_datetime'}, op:'LESS_THAN', value:{stringValue:'2026-07-01'} } },
  ]}}, limit: 50 })
  var juneFlights = juneRes.filter(function(r) { return r.document })
  console.log('--- JUNE FLIGHTS (' + juneFlights.length + ') ---')
  for (var ji = 0; ji < juneFlights.length; ji++) {
    var jd = juneFlights[ji].document
    var jId = jd.name.split('/').pop()
    console.log('  ' + jId.slice(0, 12) + ' | ' + (gf(jd, 'flight_number') || '?') + ' | ' + (gf(jd, 'airline') || '?') + ' | ETD=' + (gf(jd, 'flight_datetime') || '?') + ' | by=' + (gf(jd, 'created_by') || '?'))
  }

  console.log('\n=== END MONITOR ===')
}
main().catch(console.error)
