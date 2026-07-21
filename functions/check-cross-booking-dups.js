/**
 * Check for duplicate AWBs ACROSS different bookings for Express Line.
 * Run: node functions/check-cross-booking-dups.js
 */
const https = require('https')
const fs = require('fs')
const path = require('path')

const PROJECT = 'wms-mcl'
const CLIENT_ID = 'YPATo6B9BvRJEIJO7ld9'

function getToken() {
  const configPath = path.join(require('os').homedir(), '.config', 'configstore', 'firebase-tools.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  return config.tokens?.access_token
}

function firestoreQuery() {
  const token = getToken()
  return new Promise((resolve, reject) => {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'airfreight_bookings' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'client_id' }, op: 'EQUAL', value: { stringValue: CLIENT_ID } } },
              { fieldFilter: { field: { fieldPath: 'booking_type' }, op: 'EQUAL', value: { stringValue: 'ecommerce' } } },
            ]
          }
        },
        limit: 500,
      }
    }
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`))
        else resolve(JSON.parse(data))
      })
    })
    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
  })
}

function extractVal(v) {
  if (!v) return null
  if (v.stringValue !== undefined) return v.stringValue
  if (v.integerValue !== undefined) return Number(v.integerValue)
  if (v.doubleValue !== undefined) return v.doubleValue
  if (v.booleanValue !== undefined) return v.booleanValue
  if (v.nullValue !== undefined) return null
  if (v.timestampValue !== undefined) return v.timestampValue
  if (v.arrayValue) return (v.arrayValue.values || []).map(extractVal)
  if (v.mapValue) {
    const obj = {}
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) obj[k] = extractVal(val)
    return obj
  }
  return JSON.stringify(v)
}

async function main() {
  console.log('=== Cross-booking duplicate check ===\n')

  const results = await firestoreQuery()

  // Build global AWB map: awb -> [{ bookingId, flightId, flightNum, lineIdx, line }]
  const awbMap = new Map()

  for (const result of results) {
    if (!result.document) continue
    const doc = result.document
    const docId = doc.name.split('/').pop()
    const fields = doc.fields || {}
    const flightId = extractVal(fields.flight_id) || ''
    const flightNum = extractVal(fields.flight_number) || ''
    const awbLines = extractVal(fields.awb_lines)
    if (!Array.isArray(awbLines)) continue

    for (let i = 0; i < awbLines.length; i++) {
      const line = awbLines[i]
      const awb = ((line.awb_number || '') + '').trim().toUpperCase()
      if (!awb) continue
      if (!awbMap.has(awb)) awbMap.set(awb, [])
      awbMap.get(awb).push({
        bookingId: docId,
        flightId,
        flightNum,
        lineIdx: i,
        ws: line.warehouse_status || '',
        onHand: !!line.on_hand,
        dispatched: !!line.dispatched,
        transportStatus: line.transport_status || '',
        transportCo: line.transport_company || '',
        pcs: line.pieces || 0,
        cw: line.chargeable_weight || 0,
      })
    }
  }

  // Find AWBs that appear in multiple bookings
  let crossDups = 0
  for (const [awb, entries] of awbMap) {
    if (entries.length <= 1) continue
    const bookingIds = new Set(entries.map(e => e.bookingId))
    if (bookingIds.size <= 1) continue // Same booking = already handled

    crossDups++
    console.log(`AWB ${awb} appears in ${entries.length} bookings:`)
    for (const e of entries) {
      console.log(`  booking=${e.bookingId.slice(0, 8)} flight=${e.flightNum || e.flightId.slice(0, 8)} ws=${e.ws || '-'} onHand=${e.onHand} dispatched=${e.dispatched} transport=${e.transportStatus || '-'} co=${e.transportCo || '-'} pcs=${e.pcs} cw=${e.cw}`)
    }
    console.log()
  }

  console.log(`\nTotal cross-booking duplicates: ${crossDups}`)
  console.log(`Total unique AWBs: ${awbMap.size}`)
}

main().catch(err => { console.error('Error:', err.message); process.exit(1) })
