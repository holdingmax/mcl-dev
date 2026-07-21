/**
 * Cleanup v2: Remove duplicate AWB lines from ALL Express Line ecommerce bookings.
 * When deduplicating, KEEPS the line with the most operational data
 * (warehouse_status, doc_reception_id, scans, on_hand, dispatched, etc.)
 *
 * Run: node functions/cleanup-duplicates-v2.js
 */
const https = require('https')
const fs = require('fs')
const path = require('path')

const PROJECT = 'wms-mcl'
const CLIENT_ID = 'YPATo6B9BvRJEIJO7ld9' // Express Line

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
      path: url.pathname + (url.search || ''),
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

/**
 * Score a line by how much operational data it has.
 * Higher = more valuable = should be kept.
 */
function lineScore(line) {
  let score = 0
  if (line.warehouse_status) score += 10  // Doc/physical reception
  if (line.doc_reception_id) score += 5
  if (line.on_hand) score += 5
  if (line.drop_off_time) score += 5
  if (line.dispatched) score += 10
  if (line.dispatched_at) score += 5
  if (line.transport_status) score += 3
  if (line.scans && Array.isArray(line.scans) && line.scans.length > 0) score += 5
  if (line.holds && Array.isArray(line.holds) && line.holds.length > 0) score += 3
  if (line.audit_log && Array.isArray(line.audit_log) && line.audit_log.length > 0) score += 3
  if (line.screening_status) score += 3
  if (line.screening_event_id) score += 3
  // Also consider basic data completeness
  if (line.awb_2nd_leg) score += 1
  if (line.pickup_from) score += 1
  if (line.ready_for_pickup) score += 1
  if (line.last_day_free) score += 1
  return score
}

/**
 * Merge two lines: keep the best-scored one as base, but copy over
 * any non-null operational fields from the other.
 */
function mergeLines(a, b) {
  const scoreA = lineScore(a)
  const scoreB = lineScore(b)
  const winner = scoreA >= scoreB ? { ...a } : { ...b }
  const loser = scoreA >= scoreB ? b : a

  // Copy operational fields from loser if winner doesn't have them
  const opsFields = [
    'warehouse_status', 'doc_reception_id', 'on_hand', 'drop_off_time',
    'dispatched', 'dispatched_at', 'dispatched_by', 'transport_status',
    'scans', 'holds', 'audit_log', 'screening_status', 'screening_event_id',
    'hold', 'transport_company',
  ]
  for (const f of opsFields) {
    if (!winner[f] && loser[f]) {
      winner[f] = loser[f]
    }
    // For arrays, merge if winner's is empty
    if (Array.isArray(loser[f]) && loser[f].length > 0) {
      if (!Array.isArray(winner[f]) || winner[f].length === 0) {
        winner[f] = loser[f]
      }
    }
  }

  return winner
}

async function main() {
  console.log('=== Cleanup v2: Finding ALL ecommerce bookings for Express Line ===\n')

  const results = await firestoreQuery('airfreight_bookings')

  let totalDupsFound = 0
  let totalBookingsFixed = 0

  for (const result of results) {
    if (!result.document) continue
    const doc = result.document
    const docId = doc.name.split('/').pop()
    const fields = doc.fields || {}

    const awbLines = extractVal(fields.awb_lines)
    if (!Array.isArray(awbLines) || awbLines.length === 0) continue

    // Group by normalized AWB number
    const groups = new Map()
    for (let i = 0; i < awbLines.length; i++) {
      const line = awbLines[i]
      const awb = ((line.awb_number || '') + '').trim().toUpperCase()
      if (!awb) {
        // Keep lines without AWB as-is
        if (!groups.has('__empty_' + i)) groups.set('__empty_' + i, [])
        groups.get('__empty_' + i).push(line)
        continue
      }
      if (!groups.has(awb)) groups.set(awb, [])
      groups.get(awb).push(line)
    }

    // Check if there are any duplicates
    let hasDups = false
    for (const [awb, lines] of groups) {
      if (awb.startsWith('__empty_')) continue
      if (lines.length > 1) {
        hasDups = true
        const scores = lines.map(l => lineScore(l))
        console.log(`  DUP: ${awb} x${lines.length} in booking ${docId.slice(0, 8)} (scores: ${scores.join(', ')})`)
        totalDupsFound += lines.length - 1
      }
    }

    if (!hasDups) continue

    // Deduplicate: merge lines with same AWB, keep best
    const deduped = []
    for (const [awb, lines] of groups) {
      if (lines.length === 1) {
        deduped.push(lines[0])
      } else {
        // Merge all duplicates into one
        let merged = lines[0]
        for (let i = 1; i < lines.length; i++) {
          merged = mergeLines(merged, lines[i])
        }
        deduped.push(merged)
      }
    }

    // Update Firestore
    const newPieces = deduped.reduce((s, l) => s + (l.pieces || 0), 0)
    const updateBody = {
      fields: {
        ...fields,
        awb_lines: toFirestoreValue(deduped),
        pieces: toFirestoreValue(newPieces),
      }
    }

    const updatePath = `airfreight_bookings/${docId}?updateMask.fieldPaths=awb_lines&updateMask.fieldPaths=pieces`
    await firestoreRequest('PATCH', updatePath, updateBody)
    totalBookingsFixed++
    console.log(`  FIXED: ${docId.slice(0, 8)} — ${awbLines.length} -> ${deduped.length} lines (removed ${awbLines.length - deduped.length} dups)\n`)
  }

  console.log(`\n=== Summary ===`)
  console.log(`Duplicate lines found: ${totalDupsFound}`)
  console.log(`Bookings fixed: ${totalBookingsFixed}`)

  if (totalDupsFound === 0) {
    console.log('\nNo duplicates found! System is clean.')
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1) })
