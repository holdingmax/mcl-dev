// Check buildup_ulds for deleted flight and case 1 flight — READ ONLY
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
function gf(doc, f) {
  const v = doc.fields?.[f]; if (!v) return null
  if (v.stringValue !== undefined) return v.stringValue
  if (v.integerValue !== undefined) return Number(v.integerValue)
  if (v.doubleValue !== undefined) return Number(v.doubleValue)
  return null
}

async function checkUlds(token, label, flightId) {
  console.log(`\n=== ${label} (flight_id=${flightId}) ===`)
  const res = await fsQuery(token, {
    from: [{ collectionId: 'buildup_ulds' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: flightId } } },
    limit: 50,
  })
  const docs = res.filter(r => r.document)
  console.log(`  buildup_ulds: ${docs.length} found`)
  for (const d of docs) {
    const doc = d.document
    const uldNum = gf(doc, 'uld_number') || gf(doc, 'uld_id') || '?'
    const uldType = gf(doc, 'uld_type') || ''
    const status = gf(doc, 'status') || ''
    console.log(`  ULD: ${uldNum} (${uldType}) status=${status} id=${doc.name.split('/').pop()}`)

    // Check assigned AWBs
    const awbs = doc.fields?.awbs?.arrayValue?.values || doc.fields?.assigned_awbs?.arrayValue?.values || []
    if (awbs.length > 0) {
      for (const a of awbs) {
        const m = a.mapValue
        if (m) {
          const awbNum = gf(m, 'awb_number') || gf(m, 'doc_reception_id') || ''
          const pcs = gf(m, 'pieces') || ''
          const w = gf(m, 'weight') || ''
          console.log(`    awb=${awbNum} pcs=${pcs} w=${w}`)
        } else {
          console.log(`    raw: ${JSON.stringify(a).slice(0, 100)}`)
        }
      }
    } else {
      // Try printing all fields to understand structure
      const fieldNames = Object.keys(doc.fields || {})
      console.log(`    fields: ${fieldNames.join(', ')}`)
    }
  }

  // Also check physical_pieces for this flight
  const ppRes = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_physical_pieces' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: flightId } } },
    limit: 5,
  })
  const ppDocs = ppRes.filter(r => r.document)
  console.log(`  physical_pieces: ${ppDocs.length} found`)
}

async function main() {
  const token = await getToken()
  console.log('Token OK')

  // Case 2: deleted flight
  await checkUlds(token, 'CASE 2 — Deleted flight LA-0543', 'h1Iughl1h4yyzYPkIvXw')

  // Case 2: new flight (should have nothing)
  await checkUlds(token, 'CASE 2 — New flight LA-0543', 'eSpKSthqdhToPjzBUGRv')

  // Case 1: UC-1527 flight (should have ULDs)
  await checkUlds(token, 'CASE 1 — UC-1527 flight', 'clFtNKunwg2MMZLKRIRs')
}

main().catch(console.error)
