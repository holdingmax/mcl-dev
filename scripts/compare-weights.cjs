// Compare gross weight and CHW between bookings and doc_receptions for built flights
// Uses Firebase REST API with CLI token

const { execSync } = require('child_process')
const https = require('https')

const PROJECT = 'wms-mcl'

function getCliToken() {
  const out = execSync('npx firebase login:ci --no-localhost 2>&1 || true', { encoding: 'utf8' })
  // Try getting token from firebase CLI directly
  const token = execSync('gcloud auth print-access-token 2>/dev/null || echo ""', { encoding: 'utf8' }).trim()
  return token
}

function firestoreQuery(token, structuredQuery) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ structuredQuery })
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(d) }
      })
    })
    req.on('error', reject); req.write(body); req.end()
  })
}

function getField(doc, field) {
  const f = doc.fields?.[field]
  if (!f) return null
  if (f.stringValue !== undefined) return f.stringValue
  if (f.integerValue !== undefined) return Number(f.integerValue)
  if (f.doubleValue !== undefined) return Number(f.doubleValue)
  if (f.booleanValue !== undefined) return f.booleanValue
  return null
}

function getArrayField(doc, field) {
  const f = doc.fields?.[field]
  if (!f || !f.arrayValue) return []
  return (f.arrayValue.values || []).map(v => v.mapValue || v)
}

function getMapField(mv, field) {
  const f = mv?.fields?.[field]
  if (!f) return null
  if (f.stringValue !== undefined) return f.stringValue
  if (f.integerValue !== undefined) return Number(f.integerValue)
  if (f.doubleValue !== undefined) return Number(f.doubleValue)
  return null
}

async function compareFlightWeights(token, flightNumber) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`FLIGHT: ${flightNumber}`)
  console.log('='.repeat(60))

  // Find flight
  const flightRes = await firestoreQuery(token, {
    from: [{ collectionId: 'airfreight_flights' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_number' }, op: 'EQUAL', value: { stringValue: flightNumber } } },
    limit: 1,
  })
  const flightDocs = flightRes.filter(r => r.document)
  if (flightDocs.length === 0) { console.log('Flight not found!'); return }

  const flight = flightDocs[0].document
  const flightId = flight.name.split('/').pop()
  console.log(`Flight ID: ${flightId}`)

  // --- BOOKINGS ---
  const bookRes = await firestoreQuery(token, {
    from: [{ collectionId: 'airfreight_bookings' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: flightId } } },
    limit: 50,
  })
  const bookingDocs = bookRes.filter(r => r.document)

  let bkgGross = 0, bkgChw = 0, bkgPcs = 0, bkgAwbCount = 0
  console.log(`\n--- BOOKINGS (${bookingDocs.length} booking docs) ---`)

  for (const bd of bookingDocs) {
    const d = bd.document
    const bType = getField(d, 'booking_type')
    console.log(`  Booking ${d.name.split('/').pop()} (type: ${bType})`)

    if (bType === 'simple') {
      const w = Number(getField(d, 'weight')) || 0
      const c = Number(getField(d, 'chargeable_weight')) || 0
      const p = Number(getField(d, 'pieces')) || 0
      console.log(`    AWB: ${getField(d, 'awb_1st_leg') || '?'} / 2nd: ${getField(d, 'awb_2nd_leg') || '-'}  |  pcs: ${p}  |  gross: ${w}  |  chw: ${c}`)
      bkgGross += w; bkgChw += c; bkgPcs += p; bkgAwbCount++
    } else {
      const lines = getArrayField(d, 'awb_lines')
      for (const line of lines) {
        const w = Number(getMapField(line, 'weight')) || 0
        const c = Number(getMapField(line, 'chargeable_weight')) || 0
        const p = Number(getMapField(line, 'pieces')) || 0
        const awb1 = getMapField(line, 'awb_number') || '?'
        const awb2 = getMapField(line, 'awb_2nd_leg') || '-'
        console.log(`    1st: ${awb1}  |  2nd: ${awb2}  |  pcs: ${p}  |  gross: ${w}  |  chw: ${c}`)
        bkgGross += w; bkgChw += c; bkgPcs += p; bkgAwbCount++
      }
    }
  }
  console.log(`  BOOKING TOTAL: ${bkgAwbCount} AWBs  |  pcs: ${bkgPcs}  |  gross: ${bkgGross}  |  chw: ${bkgChw}`)

  // --- DOC RECEPTIONS ---
  const drRes = await firestoreQuery(token, {
    from: [{ collectionId: 'airfreight_doc_receptions' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: flightId } } },
    limit: 100,
  })
  const drDocs = drRes.filter(r => r.document)

  let drGross = 0, drChw = 0, drPcs = 0
  console.log(`\n--- DOC RECEPTIONS (${drDocs.length} docs) ---`)

  for (const drd of drDocs) {
    const d = drd.document
    const w = Number(getField(d, 'weight')) || 0
    const c = Number(getField(d, 'chargeable_weight')) || 0
    const p = Number(getField(d, 'pieces')) || 0
    const awb = getField(d, 'awb_number') || '?'
    const leg2 = getField(d, 'awb_2nd_leg') || '-'
    const mawb = getField(d, 'mawb_number') || '-'
    console.log(`    awb: ${awb}  |  2nd: ${leg2}  |  mawb: ${mawb}  |  pcs: ${p}  |  gross: ${w}  |  chw: ${c}`)
    drGross += w; drChw += c; drPcs += p
  }
  console.log(`  DR TOTAL: ${drDocs.length} AWBs  |  pcs: ${drPcs}  |  gross: ${drGross}  |  chw: ${drChw}`)

  // --- COMPARISON ---
  console.log(`\n--- COMPARISON ---`)
  console.log(`  Pieces:  booking=${bkgPcs}  dist=${drPcs}  ${bkgPcs === drPcs ? 'MATCH' : 'DIFF ' + (drPcs - bkgPcs)}`)
  console.log(`  Gross:   booking=${bkgGross}  dist=${drGross}  ${bkgGross === drGross ? 'MATCH' : 'DIFF ' + (drGross - bkgGross)}`)
  console.log(`  CHW:     booking=${bkgChw}  dist=${drChw}  ${bkgChw === drChw ? 'MATCH' : 'DIFF ' + (drChw - bkgChw)}`)
}

async function main() {
  // Get token from gcloud or firebase CLI
  let token
  try {
    token = execSync('gcloud auth print-access-token 2>/dev/null', { encoding: 'utf8' }).trim()
  } catch {
    // Fallback: use firebase CLI token
    try {
      const configPath = require('path').join(require('os').homedir(), '.config/configstore/firebase-tools.json')
      const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'))
      const refreshToken = config.tokens?.refresh_token
      if (!refreshToken) throw new Error('No refresh token')

      // Exchange refresh token for access token
      const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi`
      token = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => {
            const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d)
          })
        })
        req.on('error', reject); req.write(body); req.end()
      })
    } catch (e) {
      console.error('Could not get token:', e)
      process.exit(1)
    }
  }

  console.log('Token OK')
  await compareFlightWeights(token, 'UC-1731')
  await compareFlightWeights(token, 'L7-2521')
}

main().catch(console.error)
