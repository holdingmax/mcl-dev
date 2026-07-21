// Check physical_pieces linkage and check if doc_distribucion can be recovered
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

async function main() {
  const token = await getToken()

  // Check physical_pieces for the 2 doc_receptions
  const drIds = ['jW7iKUPzXbvjzo2QitHy', 'U6GtrQksFluFn2N6fZ6R']
  for (const drId of drIds) {
    console.log(`\n=== Physical pieces for DR ${drId} ===`)
    const res = await fsQuery(token, {
      from: [{ collectionId: 'airfreight_physical_pieces' }],
      where: { fieldFilter: { field: { fieldPath: 'doc_reception_id' }, op: 'EQUAL', value: { stringValue: drId } } },
      limit: 200,
    })
    const docs = res.filter(r => r.document)
    console.log(`  Found: ${docs.length} pieces`)
    if (docs.length > 0) {
      const d = docs[0].document
      // Check what flight_id they reference
      console.log(`  Sample piece flight_id: ${gf(d, 'flight_id')}`)
      console.log(`  Sample piece uld_id: ${gf(d, 'uld_id')}`)
      console.log(`  Fields: ${Object.keys(d.fields || {}).join(', ')}`)
    }
  }

  // Check the nearby LA-0543 dispatched flight for doc_distribucion structure
  console.log('\n=== doc_distribucion from LA-0543 cPrdOW0IHC4ESblqKvat ===')
  const getDoc = (docPath) => new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}`,
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(d) } })
    }); req.on('error', reject); req.end()
  })

  const refFlight = await getDoc('airfreight_flights/cPrdOW0IHC4ESblqKvat')
  const distField = refFlight.fields?.doc_distribucion
  if (distField) {
    console.log(JSON.stringify(distField, null, 2).slice(0, 500))
  } else {
    console.log('No doc_distribucion field')
  }
}

main().catch(console.error)
