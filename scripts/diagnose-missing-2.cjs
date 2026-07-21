// Search for missing AWBs across ALL flights — by awb_number in doc_receptions and bookings
// READ-ONLY

const https = require('https')
const path = require('path')
const fs = require('fs')
const PROJECT = 'wms-mcl'

function getToken() {
  const configPaths = [
    path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'),
    path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json'),
  ]
  for (const p of configPaths) {
    try {
      const config = JSON.parse(fs.readFileSync(p, 'utf8'))
      const rt = config.tokens?.refresh_token
      if (rt) return exchangeToken(rt)
    } catch {}
  }
  throw new Error('No token')
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

// All 2nd leg AWBs from the screenshot
const AWB_2NDS = [
  '045-22209353', '045-22209843',  // LA-0543 ETD 05-17
  '045-22210602', '045-22210053', '045-22210064',  // UC-1527 ETD 05-25
  '045-22209390', '045-22210075',  // LA-0543 ETD 05-25
  '045-22209434',  // UC-1731 ETD 05-26
]

async function main() {
  const token = await getToken()
  console.log('Token OK\n')

  for (const awb of AWB_2NDS) {
    console.log(`\n--- AWB 2nd Leg: ${awb} ---`)

    // Search doc_receptions by awb_number
    const drRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_doc_receptions' }],
      where: { fieldFilter: { field: { fieldPath: 'awb_number' }, op: 'EQUAL', value: { stringValue: awb } } },
      limit: 5,
    })
    const drDocs = drRes.filter(r => r.document)
    if (drDocs.length === 0) {
      console.log('  doc_receptions: NONE')
    } else {
      for (const dr of drDocs) {
        const d = dr.document
        console.log(`  doc_reception: id=${d.name.split('/').pop()}  flight_id=${gf(d, 'flight_id')}  flight_number=${gf(d, 'flight_number')}  status=${gf(d, 'status')}  pcs=${gf(d, 'pieces')}  w=${gf(d, 'weight')}  booking_id=${gf(d, 'booking_id')}`)
      }
    }

    // Search billing charges by awb_2nd_leg
    const bcRes = await fsQuery(token, {
      from: [{ collectionId: 'air_billing_charges' }],
      where: { fieldFilter: { field: { fieldPath: 'awb_2nd_leg' }, op: 'EQUAL', value: { stringValue: awb } } },
      limit: 5,
    })
    const bcDocs = bcRes.filter(r => r.document)
    if (bcDocs.length === 0) {
      console.log('  billing_charges: NONE')
    } else {
      for (const bc of bcDocs) {
        const d = bc.document
        console.log(`  billing_charge: id=${d.name.split('/').pop()}  status=${gf(d, 'status')}  flight=${gf(d, 'flight_number')}  invoice=${gf(d, 'invoice_id')}`)
      }
    }

    // Search physical_pieces by awb_number
    const ppRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_physical_pieces' }],
      where: { fieldFilter: { field: { fieldPath: 'awb_number' }, op: 'EQUAL', value: { stringValue: awb } } },
      limit: 3,
    })
    const ppDocs = ppRes.filter(r => r.document)
    console.log(`  physical_pieces: ${ppDocs.length} found`)

    // Search buildup_ulds that contain this AWB
    // (can't query array contains on nested field, skip for now)
  }

  // Also check: for the LA-0543 flights that exist around 05-17 and 05-25, what bookings do they have?
  console.log('\n\n=== LA-0543 NEARBY FLIGHTS: check bookings ===')
  const nearbyIds = [
    { id: 'n5Vl23d1aZvaitv1yTmy', etd: '2026-05-14' },
    { id: 'ALelgkQ4MjOPm2dhCTnh', etd: '2026-05-19' },
    { id: 'rmhTTVMFfr81ms4Hnco6', etd: '2026-05-19' },
    { id: 'cPrdOW0IHC4ESblqKvat', etd: '2026-05-21' },
    { id: 'h4bcV897mD3XuGAGy07e', etd: '2026-05-26' },
  ]

  const norm = s => (s || '').replace(/[-\s]/g, '').toUpperCase()
  const targetAwbs = new Set(['045-22209353', '045-22209843', '045-22209390', '045-22210075'].map(norm))

  for (const nf of nearbyIds) {
    const bookRes = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_bookings' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: nf.id } } },
      limit: 10,
    })
    const bookDocs = bookRes.filter(r => r.document)
    console.log(`\n  Flight ${nf.id} (ETD ${nf.etd}): ${bookDocs.length} bookings`)

    for (const bd of bookDocs) {
      const d = bd.document
      const lines = d.fields?.awb_lines?.arrayValue?.values || []
      for (const lv of lines) {
        const line = lv.mapValue
        const a2 = gf(line, 'awb_2nd_leg') || ''
        if (targetAwbs.has(norm(a2))) {
          console.log(`    *** FOUND ${a2} in booking ${d.name.split('/').pop()} ***`)
        }
      }
      // Also check simple
      const a2 = gf(d, 'awb_2nd_leg') || ''
      if (a2 && targetAwbs.has(norm(a2))) {
        console.log(`    *** FOUND ${a2} in simple booking ${d.name.split('/').pop()} ***`)
      }
    }

    // Also check doc_receptions for these flights
    const drRes2 = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_doc_receptions' }],
      where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: nf.id } } },
      limit: 50,
    })
    const drDocs2 = drRes2.filter(r => r.document)
    for (const dr of drDocs2) {
      const awb = gf(dr.document, 'awb_number') || ''
      if (targetAwbs.has(norm(awb))) {
        console.log(`    *** FOUND ${awb} in doc_reception for this flight ***`)
      }
    }
  }

  console.log('\n\nDIAGNOSIS COMPLETE — READ ONLY')
}

main().catch(console.error)
