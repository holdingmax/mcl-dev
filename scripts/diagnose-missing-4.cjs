// Get template from existing LA-0543 flight + understand billing charge structure — READ ONLY
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

  // 1. Get full structure of a recent dispatched LA-0543 flight
  console.log('=== Template: LA-0543 flight cPrdOW0IHC4ESblqKvat (ETD 05-21, dispatched) ===')
  const f = await getDoc(token, 'airfreight_flights', 'cPrdOW0IHC4ESblqKvat')
  console.log(JSON.stringify(f.fields, null, 2))

  // 2. Get a billing charge example to understand structure
  console.log('\n\n=== Example billing charge for UC-1527 flight clFtNKunwg2MMZLKRIRs ===')
  const bcRes = await fsQuery(token, {
    from: [{ collectionId: 'air_billing_charges' }],
    where: { fieldFilter: { field: { fieldPath: 'flight_id' }, op: 'EQUAL', value: { stringValue: 'clFtNKunwg2MMZLKRIRs' } } },
    limit: 1,
  })
  const bcDocs = bcRes.filter(r => r.document)
  if (bcDocs.length > 0) {
    console.log(JSON.stringify(bcDocs[0].document.fields, null, 2))
  } else {
    console.log('No billing charges found for this flight')
  }

  // 3. Check the 3rd AWB in case 2 booking (045-22209773) - does it have doc_reception?
  console.log('\n\n=== Check AWB 045-22209773 (3rd line in case 2 booking) ===')
  const drRes = await fsQuery(token, {
    from: [{ collectionId: 'airfreight_doc_receptions' }],
    where: { fieldFilter: { field: { fieldPath: 'awb_number' }, op: 'EQUAL', value: { stringValue: '045-22209773' } } },
    limit: 3,
  })
  const drDocs = drRes.filter(r => r.document)
  console.log(`doc_receptions: ${drDocs.length}`)
  for (const dr of drDocs) {
    const d = dr.document
    const gf = (f) => { const v = d.fields?.[f]; return v?.stringValue || v?.integerValue || v?.doubleValue || null }
    console.log(`  id=${d.name.split('/').pop()}  flight_id=${gf('flight_id')}  status=${gf('status')}  pcs=${gf('pieces')}  w=${gf('weight')}`)
  }
}

main().catch(console.error)
