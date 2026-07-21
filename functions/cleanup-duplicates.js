/**
 * One-time: remove duplicate AWB lines from bookings and delete stale snapshot.
 * Run: node functions/cleanup-duplicates.js
 */
const https = require('https')
const fs = require('fs')
const path = require('path')

const PROJECT = 'wms-mcl'

function getToken() {
  const configPath = path.join(require('os').homedir(), '.config', 'configstore', 'firebase-tools.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  return config.tokens?.access_token
}

function firestoreRequest(method, docPath, body) {
  const token = getToken()
  return new Promise((resolve, reject) => {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}`)
    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`))
        else resolve(data ? JSON.parse(data) : null)
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function firestoreQuery(collectionId, fieldPath, op, value) {
  const token = getToken()
  return new Promise((resolve, reject) => {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`
    const body = {
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath },
            op,
            value: typeof value === 'string' ? { stringValue: value } : { booleanValue: value },
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
  if (v.arrayValue) return (v.arrayValue.values || []).map(extractVal)
  if (v.mapValue) {
    const obj = {}
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) obj[k] = extractVal(val)
    return obj
  }
  return JSON.stringify(v)
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null }
  if (typeof val === 'string') return { stringValue: val }
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  if (typeof val === 'boolean') return { booleanValue: val }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } }
  if (typeof val === 'object') {
    const fields = {}
    for (const [k, v] of Object.entries(val)) fields[k] = toFirestoreValue(v)
    return { mapValue: { fields } }
  }
  return { stringValue: String(val) }
}

async function main() {
  const CLIENT_ID = 'YPATo6B9BvRJEIJO7ld9' // Express Line

  console.log('1. Finding ecommerce bookings for Express Line...')
  const results = await firestoreQuery('airfreight_bookings', 'client_id', 'EQUAL', CLIENT_ID)

  let fixedCount = 0
  let totalDupsRemoved = 0

  for (const result of results) {
    if (!result.document) continue
    const doc = result.document
    const docId = doc.name.split('/').pop()
    const fields = doc.fields || {}

    const bookingType = extractVal(fields.booking_type)
    if (bookingType !== 'ecommerce') continue

    const awbLines = extractVal(fields.awb_lines)
    if (!Array.isArray(awbLines) || awbLines.length === 0) continue

    // Find duplicates by awb_number
    const seen = new Map()
    const deduped = []
    let hasDups = false

    for (const line of awbLines) {
      const awb = (line.awb_number || '').trim().toUpperCase()
      if (!awb) { deduped.push(line); continue }
      if (seen.has(awb)) {
        hasDups = true
        totalDupsRemoved++
        console.log(`  DUP: ${awb} in booking ${docId.slice(0, 8)} (flight: ${extractVal(fields.flight_number) || '?'})`)
      } else {
        seen.set(awb, true)
        deduped.push(line)
      }
    }

    if (hasDups) {
      const newPieces = deduped.reduce((s, l) => s + (l.pieces || 0), 0)
      // Update via REST PATCH
      const updateBody = {
        fields: {
          ...fields,
          awb_lines: toFirestoreValue(deduped),
          pieces: toFirestoreValue(newPieces),
        }
      }
      await firestoreRequest('PATCH', `airfreight_bookings/${docId}?updateMask.fieldPaths=awb_lines&updateMask.fieldPaths=pieces`, updateBody)
      fixedCount++
      console.log(`  FIXED: ${docId.slice(0, 8)} — removed ${awbLines.length - deduped.length} dups, ${deduped.length} lines remain`)
    }
  }

  console.log(`\nDuplicates removed: ${totalDupsRemoved} from ${fixedCount} bookings`)

  // 2. Delete old snapshot to force re-sync
  console.log('\n2. Deleting old snapshot to force full re-sync...')
  try {
    await firestoreRequest('DELETE', `_sheet_sync_snapshots/${CLIENT_ID}_2026-05`)
    console.log('  Snapshot deleted')
  } catch (e) {
    console.log('  Snapshot delete:', e.message.slice(0, 100))
  }

  // 3. Clear old alerts
  console.log('\n3. Clearing old alerts...')
  try {
    const alertResults = await firestoreQuery('_sheet_sync_alerts', 'client_id', 'EQUAL', CLIENT_ID)
    let deleted = 0
    for (const r of alertResults) {
      if (!r.document) continue
      const alertId = r.document.name.split('/').pop()
      await firestoreRequest('DELETE', `_sheet_sync_alerts/${alertId}`)
      deleted++
    }
    console.log(`  Deleted ${deleted} old alerts`)
  } catch (e) {
    console.log('  Alert cleanup:', e.message.slice(0, 100))
  }

  console.log('\nDone. Next agent run will do a clean full sync.')
}

main().catch(err => { console.error('Error:', err.message); process.exit(1) })
