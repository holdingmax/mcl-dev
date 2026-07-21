// Check specific flight and booking IDs found in doc_receptions — READ ONLY
const https = require('https')
const path = require('path')
const fs = require('fs')
const PROJECT = 'wms-mcl'

function getToken() {
  const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json')
  try {
    const config = JSON.parse(fs.readFileSync(p, 'utf8'))
    return exchangeToken(config.tokens.refresh_token)
  } catch {
    const p2 = path.join(require('os').homedir(), '.config/configstore/firebase-tools.json')
    const config = JSON.parse(fs.readFileSync(p2, 'utf8'))
    return exchangeToken(config.tokens.refresh_token)
  }
}
function exchangeToken(rt) {
  return new Promise((resolve, reject) => {
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi`
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) })
    }); req.on('error', reject); req.write(body); req.end()
  })
}
function getDoc(token, collection, docId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents/${collection}/${docId}`,
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
  return null
}

async function main() {
  const token = await getToken()

  // 1. Flight h1Iughl1h4yyzYPkIvXw (referenced by LA-0543 doc_receptions)
  console.log('=== Flight h1Iughl1h4yyzYPkIvXw ===')
  const f1 = await getDoc(token, 'airfreight_flights', 'h1Iughl1h4yyzYPkIvXw')
  if (f1.error) {
    console.log('  NOT FOUND (deleted?)', f1.error.message)
  } else {
    console.log(`  flight_number=${gf(f1, 'flight_number')}  etd=${gf(f1, 'flight_datetime')}  status=${gf(f1, 'flight_status')}  dispatched=${gf(f1, 'dispatched_at') || 'NO'}`)
  }

  // 2. Booking TNHrhQGScwEtBtgv46pw (referenced by LA-0543 doc_receptions)
  console.log('\n=== Booking TNHrhQGScwEtBtgv46pw ===')
  const b1 = await getDoc(token, 'airfreight_bookings', 'TNHrhQGScwEtBtgv46pw')
  if (b1.error) {
    console.log('  NOT FOUND (deleted?)', b1.error.message)
  } else {
    console.log(`  flight_id=${gf(b1, 'flight_id')}  client=${gf(b1, 'client_name')}  type=${gf(b1, 'booking_type')}`)
    const lines = b1.fields?.awb_lines?.arrayValue?.values || []
    console.log(`  awb_lines: ${lines.length}`)
    for (const lv of lines) {
      const l = lv.mapValue
      console.log(`    1st=${gf(l, 'awb_number')}  2nd=${gf(l, 'awb_2nd_leg')}  pcs=${gf(l, 'pieces')}  w=${gf(l, 'weight')}`)
    }
  }

  // 3. Booking Utsbc0rkRMbHh0jE2GDs (referenced by UC-1527 doc_receptions)
  console.log('\n=== Booking Utsbc0rkRMbHh0jE2GDs ===')
  const b2 = await getDoc(token, 'airfreight_bookings', 'Utsbc0rkRMbHh0jE2GDs')
  if (b2.error) {
    console.log('  NOT FOUND (deleted?)', b2.error.message)
  } else {
    console.log(`  flight_id=${gf(b2, 'flight_id')}  client=${gf(b2, 'client_name')}  type=${gf(b2, 'booking_type')}`)
    const lines = b2.fields?.awb_lines?.arrayValue?.values || []
    console.log(`  awb_lines: ${lines.length}`)
    for (const lv of lines) {
      const l = lv.mapValue
      console.log(`    1st=${gf(l, 'awb_number')}  2nd=${gf(l, 'awb_2nd_leg')}  pcs=${gf(l, 'pieces')}  w=${gf(l, 'weight')}`)
    }
  }

  // 4. Check deletion audit for these IDs
  console.log('\n=== Deletion Audit for these IDs ===')
  for (const docId of ['h1Iughl1h4yyzYPkIvXw', 'TNHrhQGScwEtBtgv46pw', 'Utsbc0rkRMbHh0jE2GDs']) {
    const audit = await getDoc(token, '_deletion_audit_log', docId)
    if (audit.error) {
      console.log(`  ${docId}: no audit record`)
    } else {
      console.log(`  ${docId}: collection=${gf(audit, 'collection')}  deleted_at=${gf(audit, 'deleted_at')}  deleted_by=${gf(audit, 'deleted_by')}`)
    }
  }
}

main().catch(console.error)
