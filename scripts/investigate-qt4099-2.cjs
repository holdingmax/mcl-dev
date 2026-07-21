// Forensic investigation part 2: QT4099 — check flight status fields, snapshots, all alerts
const https = require('https')
const path = require('path')
const fs = require('fs')
const PROJECT = 'wms-mcl'

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
function fsQuery(token, sq) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ structuredQuery: sq })
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`,
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(d) } })
    }); req.on('error', reject); req.write(body); req.end()
  })
}

async function main() {
  const token = await getToken()
  console.log('Token OK\n')

  // 1. Full flight document — show ALL fields
  console.log('=== FULL FLIGHT DOCUMENT 9tEknSu4KVLtxTg9KjWQ ===')
  const flight = await getDoc(token, 'airfreight_flights/9tEknSu4KVLtxTg9KjWQ')
  if (flight.fields) {
    for (const [k, v] of Object.entries(flight.fields)) {
      const val = v.stringValue ?? v.integerValue ?? v.doubleValue ?? v.booleanValue ?? v.timestampValue ?? JSON.stringify(v).slice(0, 200)
      console.log(`  ${k}: ${val}`)
    }
  }

  // 2. Check snapshot for Express Line — what hashes existed before the error?
  console.log('\n=== SNAPSHOT Express Line May 2026 ===')
  const snap = await getDoc(token, '_sheet_sync_snapshots/YPATo6B9BvRJEIJO7ld9_2026-05')
  if (snap.fields?.row_hashes?.mapValue?.fields) {
    const hashes = snap.fields.row_hashes.mapValue.fields
    const keys = Object.keys(hashes)
    console.log(`  Total AWB hashes: ${keys.length}`)
    // Find QT4099-related AWBs
    const qt4099awbs = [
      '99992781054', '99992781080', '99992781102', '99992781113', '99992781124',
      '99992781135', '99992781146', '99992781194', '36998152913', '36998153075',
      '36998153086', '36999783014', '36999783025', '36999783246', '36999783250',
      '36999783261', '16011071325', '36999783504', '36999783611',
      '36998155525', '36998155326', '93602243150', '93602685432'
    ]
    for (const awb of qt4099awbs) {
      const found = keys.find(k => k.includes(awb))
      if (found) {
        console.log(`  ${found}: hash=${hashes[found]?.stringValue?.slice(0, 20)}...`)
      }
    }
  } else if (snap.error) {
    console.log(`  Error: ${JSON.stringify(snap.error)}`)
  }

  // 3. ALL alerts for Express Line in last week (to find the actual move events)
  console.log('\n=== ALL ALERTS for Express Line (last 50) ===')
  const alertRes = await fsQuery(token, {
    from: [{ collectionId: '_sheet_sync_alerts' }],
    where: { fieldFilter: { field: { fieldPath: 'client_name' }, op: 'EQUAL', value: { stringValue: 'Express Line' } } },
    orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'DESCENDING' }],
    limit: 50,
  })
  const alerts = alertRes.filter(r => r.document)
  console.log(`  Total alerts: ${alerts.length}`)
  for (const a of alerts) {
    const d = a.document
    const id = d.name.split('/').pop()
    const alertType = d.fields?.alert_type?.stringValue || ''
    const status = d.fields?.status?.stringValue || ''
    const msg = d.fields?.message?.stringValue || ''
    const awb1 = d.fields?.awb_1st?.stringValue || ''
    const fn = d.fields?.flight_number?.stringValue || ''
    const sf = d.fields?.system_flight?.stringValue || ''
    const createdAt = d.fields?.created_at?.timestampValue || ''
    const diffsField = d.fields?.diffs?.arrayValue?.values || []
    const diffsStr = diffsField.map(v => {
      const m = v.mapValue?.fields
      if (!m) return '?'
      return `${m.field?.stringValue || ''}: ${m.old_value?.stringValue || ''} -> ${m.new_value?.stringValue || ''}`
    }).join(' | ')
    console.log(`\n  [${alertType}] ${status} — ${id.slice(0,12)} — ${createdAt}`)
    console.log(`    AWB: ${awb1} | flight: ${fn} | sys_flight: ${sf}`)
    console.log(`    msg: ${msg}`)
    if (diffsStr) console.log(`    diffs: ${diffsStr}`)
  }

  // 4. Check doc_receptions for the 4 new AWBs (05-29 group)
  console.log('\n=== DOC RECEPTIONS for 05-29 AWBs ===')
  const newAwbs2nd = ['729-93889891', '729-93889902', '729-93889913', '729-93889924']
  for (const awb of newAwbs2nd) {
    const res = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_doc_receptions' }],
      where: { fieldFilter: { field: { fieldPath: 'awb_number' }, op: 'EQUAL', value: { stringValue: awb } } },
      limit: 5,
    })
    const docs = res.filter(r => r.document)
    console.log(`  ${awb}: ${docs.length} doc_receptions`)
    for (const dr of docs) {
      const dd = dr.document
      const drid = dd.name.split('/').pop()
      const bid = dd.fields?.booking_id?.stringValue || ''
      const fid = dd.fields?.flight_id?.stringValue || ''
      console.log(`    DR ${drid}: booking=${bid.slice(0,8)} flight=${fid.slice(0,8)} status=${dd.fields?.status?.stringValue}`)
    }
  }

  // 5. Check sync run logs
  console.log('\n=== SYNC RUNS (Express Line, all) ===')
  const runsRes = await fsQuery(token, {
    from: [{ collectionId: '_sheet_sync_runs' }],
    where: { fieldFilter: { field: { fieldPath: 'client_id' }, op: 'EQUAL', value: { stringValue: 'YPATo6B9BvRJEIJO7ld9' } } },
    orderBy: [{ field: { fieldPath: 'started_at' }, direction: 'DESCENDING' }],
    limit: 20,
  })
  const runs = runsRes.filter(r => r.document)
  for (const r of runs) {
    const rd = r.document
    const rid = rd.name.split('/').pop()
    const startedAt = rd.fields?.started_at?.timestampValue || ''
    const st = rd.fields?.status?.stringValue || ''
    const rows = rd.fields?.rows_checked?.integerValue || ''
    const changes = rd.fields?.changes_detected?.integerValue || ''
    const applied = rd.fields?.changes_applied?.integerValue || ''
    const alertsGen = rd.fields?.alerts_generated?.integerValue || ''
    const duration = rd.fields?.duration_ms?.integerValue || ''
    console.log(`  ${rid.slice(0,12)} | ${startedAt} | st=${st} rows=${rows} changes=${changes} applied=${applied} alerts=${alertsGen} ${duration}ms`)
  }
}

main().catch(console.error)
