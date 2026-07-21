// Forensic investigation: QT4099 sync agent error — READ ONLY
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
function gf(doc, f) {
  const v = doc.fields?.[f]; if (!v) return null
  if (v.stringValue !== undefined) return v.stringValue
  if (v.integerValue !== undefined) return Number(v.integerValue)
  if (v.doubleValue !== undefined) return Number(v.doubleValue)
  if (v.booleanValue !== undefined) return v.booleanValue
  if (v.timestampValue !== undefined) return v.timestampValue
  return null
}

async function main() {
  const token = await getToken()
  console.log('Token OK\n')

  // 1. Find all QT4099 flights
  console.log('=== ALL QT4099 FLIGHTS ===')
  const flightRes = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_flights' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: 'QT-4099' } } },
    limit: 20,
  })
  const flights = flightRes.filter(r => r.document)
  for (const f of flights) {
    const d = f.document
    const id = d.name.split('/').pop()
    console.log(`  Flight ${id}:`)
    console.log(`    flight_number: ${gf(d, 'flight_number')}`)
    console.log(`    flight_datetime: ${gf(d, 'flight_datetime')}`)
    console.log(`    flight_status: ${gf(d, 'flight_status')}`)
    console.log(`    status: ${gf(d, 'status')}`)
    console.log(`    dispatched_at: ${gf(d, 'dispatched_at')}`)
    console.log(`    created_at: ${gf(d, 'created_at')}`)
    console.log(`    created_by: ${gf(d, 'created_by')}`)
  }

  // 2. Find all sync alerts mentioning QT4099 or QT-4099
  console.log('\n=== SYNC ALERTS for QT4099 ===')
  const alertRes1 = await fsQuery(token, {
    from: [{ collectionId: '_sheet_sync_alerts' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: 'QT-4099' } } },
    orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'DESCENDING' }],
    limit: 50,
  })
  const alertRes2 = await fsQuery(token, {
    from: [{ collectionId: '_sheet_sync_alerts' }],
    where: { fieldFilter: { field: { fieldPath: 'system_flight' }, op: 'EQUAL', value: { stringValue: 'QT-4099' } } },
    orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'DESCENDING' }],
    limit: 50,
  })
  const alertDocs = new Map()
  for (const r of [...alertRes1, ...alertRes2].filter(r => r.document)) {
    alertDocs.set(r.document.name, r.document)
  }
  console.log(`  Total unique alerts: ${alertDocs.size}`)
  for (const [name, d] of alertDocs) {
    const id = name.split('/').pop()
    const alertType = gf(d, 'alert_type')
    const status = gf(d, 'status')
    const msg = gf(d, 'message')
    const awb1 = gf(d, 'awb_1st')
    const awb2 = gf(d, 'awb_2nd')
    const fn = gf(d, 'flight_number')
    const sf = gf(d, 'system_flight')
    const etd = gf(d, 'etd')
    const createdAt = gf(d, 'created_at')
    // Parse diffs
    const diffsField = d.fields?.diffs?.arrayValue?.values || []
    const diffsStr = diffsField.map(v => {
      const m = v.mapValue?.fields
      if (!m) return '?'
      return `${gf(m, 'field') || m.field?.stringValue}: ${gf(m, 'old_value') || m.old_value?.stringValue} -> ${gf(m, 'new_value') || m.new_value?.stringValue}`
    }).join(' | ')
    console.log(`\n  [${alertType}] ${status} — ${id.slice(0,8)}`)
    console.log(`    AWB: ${awb1} / ${awb2}`)
    console.log(`    flight_number: ${fn} | system_flight: ${sf}`)
    console.log(`    etd: ${etd}`)
    console.log(`    created_at: ${createdAt}`)
    console.log(`    message: ${msg}`)
    console.log(`    diffs: ${diffsStr}`)
  }

  // 3. Check bookings linked to QT4099 flights
  console.log('\n=== BOOKINGS for QT4099 flights ===')
  const flightIds = flights.map(f => f.document.name.split('/').pop())
  for (const fid of flightIds) {
    const bRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_bookings' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: fid } } },
      limit: 10,
    })
    const bDocs = bRes.filter(r => r.document)
    for (const b of bDocs) {
      const bd = b.document
      const bid = bd.name.split('/').pop()
      const lines = bd.fields?.awb_lines?.arrayValue?.values || []
      console.log(`\n  Booking ${bid} (flight ${fid}):`)
      console.log(`    status: ${gf(bd, 'status')}`)
      console.log(`    flight_number: ${gf(bd, 'flight_number')}`)
      console.log(`    awb_lines: ${lines.length}`)
      for (const l of lines) {
        const m = l.mapValue?.fields
        if (!m) continue
        const a1 = m.awb_number?.stringValue || ''
        const a2 = m.awb_2nd_leg?.stringValue || ''
        const pcs = m.pieces?.integerValue || m.pieces?.doubleValue || ''
        const cw = m.chargeable_weight?.integerValue || m.chargeable_weight?.doubleValue || ''
        const disp = m.dispatched?.booleanValue
        const onHand = m.on_hand?.booleanValue
        console.log(`      ${a1} / ${a2} — pcs:${pcs} cw:${cw} dispatched:${disp} on_hand:${onHand}`)
      }
    }
  }

  // 4. Check sync runs mentioning QT4099 (recent)
  console.log('\n=== RECENT SYNC RUNS (Express Line) ===')
  const runsRes = await fsQuery(token, {
    from: [{ collectionId: '_sheet_sync_runs' }],
    where: { fieldFilter: { field: { fieldPath: 'client_name' }, op: 'EQUAL', value: { stringValue: 'Express Line' } } },
    orderBy: [{ field: { fieldPath: 'started_at' }, direction: 'DESCENDING' }],
    limit: 10,
  })
  const runs = runsRes.filter(r => r.document)
  for (const r of runs) {
    const rd = r.document
    const rid = rd.name.split('/').pop()
    console.log(`  Run ${rid.slice(0,8)}: status=${gf(rd, 'status')} rows=${gf(rd, 'rows_checked')} changes=${gf(rd, 'changes_detected')} started=${gf(rd, 'started_at')}`)
  }
}

main().catch(console.error)
